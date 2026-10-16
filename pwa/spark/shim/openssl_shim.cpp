// SPDX-License-Identifier: MIT
// Campfire PWA: OpenSSL replacement for Firo's sparkmobile (see include/openssl/*.h).
//
//   SHA-512            sparkmobile's own bitcoin/crypto/sha512.cpp (CSHA512)
//   ChaCha20-Poly1305  Bitcoin Core v27.2 src/crypto/chacha20poly1305.cpp
//                      (AEADChaCha20Poly1305, RFC 8439 section 2.8), unmodified
//   RAND_bytes         browser: crypto.getRandomValues (src/library_spark.js);
//                      native test builds: arc4random_buf
//   OPENSSL_cleanse    a memset through a volatile function pointer
//
// The EVP calls are emulated only for the call sequences sparkmobile makes; any
// other sequence returns 0, which sparkmobile's CheckOpenSSL turns into an
// exception (fail closed, never silently different output).
// Equivalence with OpenSSL 3 is tested natively by pwa/spark/native/aead_diff.cpp
// and end to end by the golden vectors (native build with real OpenSSL).

#include "openssl/crypto.h"
#include "openssl/evp.h"
#include "openssl/rand.h"

#include "bitcoin/crypto/sha512.h"     // sparkmobile
#include <crypto/chacha20poly1305.h>   // Bitcoin Core v27.2
#include <crypto/common.h>             // Bitcoin Core v27.2: ReadLE32/ReadLE64

#include <cstdint>
#include <cstring>
#include <new>
#include <string.h>
#include <vector>

#ifdef __EMSCRIPTEN__
extern "C" int spark_random_fill(unsigned char* buf, int len); // library_spark.js
#else
#include <stdlib.h> // arc4random_buf (macOS, BSD, glibc >= 2.36)
#endif

namespace {
// A memset the optimiser cannot prove dead (called through a volatile pointer).
void* (*const volatile kMemset)(void*, int, size_t) = &std::memset;
void SecureZero(void* p, size_t n)
{
    if (p && n) kMemset(p, 0, n);
}
} // namespace

struct sparkshim_md {
    int size;
};
struct sparkshim_cipher {
    int kind;
};

namespace {

const sparkshim_md kSha512 = {64};
const sparkshim_cipher kChaCha20Poly1305 = {1};

constexpr int kKeyLen = 32;
constexpr int kIvLen = 12;
constexpr int kTagLen = 16;

} // namespace

struct sparkshim_md_ctx {
    CSHA512 sha;
    bool initialized = false;
};

struct sparkshim_cipher_ctx {
    enum class Mode { None, Encrypt, Decrypt } mode = Mode::None;
    unsigned char key[kKeyLen];
    unsigned char iv[kIvLen];
    std::vector<unsigned char> aad;
    std::vector<unsigned char> text;   // ciphertext (both directions) once the data update happened
    std::vector<unsigned char> plain;  // plaintext handed out by a decrypt update
    unsigned char tag[kTagLen];
    bool have_data = false;
    bool have_tag = false;    // encrypt: tag computed; decrypt: expected tag set
    bool finalized = false;

    void wipe()
    {
        SecureZero(key, sizeof(key));
        SecureZero(iv, sizeof(iv));
        SecureZero(tag, sizeof(tag));
        if (!aad.empty()) SecureZero(aad.data(), aad.size());
        if (!text.empty()) SecureZero(text.data(), text.size());
        if (!plain.empty()) SecureZero(plain.data(), plain.size());
        aad.clear();
        text.clear();
        plain.clear();
        mode = Mode::None;
        have_data = have_tag = finalized = false;
    }
    ~sparkshim_cipher_ctx() { wipe(); }
};

namespace {

AEADChaCha20Poly1305::Nonce96 NonceFromIv(const unsigned char* iv)
{
    // RFC 8439 2.3: the nonce is state words 13..15, little endian; Bitcoin Core's
    // Nonce96 = {LE32(iv[0..4]), LE64(iv[4..12])} (chacha20.h:49-57).
    return {ReadLE32(iv), ReadLE64(iv + 4)};
}

Span<const std::byte> Bytes(const unsigned char* p, size_t n)
{
    return Span<const std::byte>(reinterpret_cast<const std::byte*>(p), n);
}

Span<std::byte> MutBytes(unsigned char* p, size_t n)
{
    return Span<std::byte>(reinterpret_cast<std::byte*>(p), n);
}

int CipherInit(EVP_CIPHER_CTX* ctx, sparkshim_cipher_ctx::Mode mode, const EVP_CIPHER* type,
               ENGINE* impl, const unsigned char* key, const unsigned char* iv)
{
    if (!ctx || type != &kChaCha20Poly1305 || impl != nullptr || !key || !iv) return 0;
    ctx->wipe();
    ctx->mode = mode;
    std::memcpy(ctx->key, key, kKeyLen);
    std::memcpy(ctx->iv, iv, kIvLen);
    return 1;
}

} // namespace

extern "C" {

// ---- SHA-512 ------------------------------------------------------------------

EVP_MD_CTX* EVP_MD_CTX_new(void)
{
    return new (std::nothrow) sparkshim_md_ctx();
}

void EVP_MD_CTX_free(EVP_MD_CTX* ctx)
{
    if (!ctx) return;
    SecureZero(static_cast<void*>(&ctx->sha), sizeof(ctx->sha));
    delete ctx;
}

const EVP_MD* EVP_sha512(void)
{
    return &kSha512;
}

int EVP_MD_size(const EVP_MD* md)
{
    return md ? md->size : -1;
}

int EVP_DigestInit_ex(EVP_MD_CTX* ctx, const EVP_MD* type, ENGINE* impl)
{
    if (!ctx || type != &kSha512 || impl != nullptr) return 0;
    ctx->sha.Reset();
    ctx->initialized = true;
    return 1;
}

int EVP_DigestUpdate(EVP_MD_CTX* ctx, const void* d, size_t cnt)
{
    if (!ctx || !ctx->initialized || (cnt > 0 && !d)) return 0;
    if (cnt > 0) ctx->sha.Write(static_cast<const unsigned char*>(d), cnt);
    return 1;
}

int EVP_DigestFinal_ex(EVP_MD_CTX* ctx, unsigned char* md, unsigned int* s)
{
    if (!ctx || !ctx->initialized || !md) return 0;
    ctx->sha.Finalize(md);
    ctx->initialized = false; // as OpenSSL: a finalized context needs a new Init
    if (s) *s = CSHA512::OUTPUT_SIZE;
    return 1;
}

int EVP_MD_CTX_copy_ex(EVP_MD_CTX* out, const EVP_MD_CTX* in)
{
    if (!out || !in || !in->initialized) return 0;
    out->sha = in->sha;
    out->initialized = true;
    return 1;
}

// ---- ChaCha20-Poly1305 (RFC 8439) -------------------------------------------------

EVP_CIPHER_CTX* EVP_CIPHER_CTX_new(void)
{
    return new (std::nothrow) sparkshim_cipher_ctx();
}

void EVP_CIPHER_CTX_free(EVP_CIPHER_CTX* ctx)
{
    delete ctx; // the destructor wipes
}

const EVP_CIPHER* EVP_chacha20_poly1305(void)
{
    return &kChaCha20Poly1305;
}

int EVP_EncryptInit_ex(EVP_CIPHER_CTX* ctx, const EVP_CIPHER* type, ENGINE* impl,
                       const unsigned char* key, const unsigned char* iv)
{
    return CipherInit(ctx, sparkshim_cipher_ctx::Mode::Encrypt, type, impl, key, iv);
}

int EVP_DecryptInit_ex(EVP_CIPHER_CTX* ctx, const EVP_CIPHER* type, ENGINE* impl,
                       const unsigned char* key, const unsigned char* iv)
{
    return CipherInit(ctx, sparkshim_cipher_ctx::Mode::Decrypt, type, impl, key, iv);
}

// Accepted sequence (what aead.cpp does): any number of AAD updates (out == NULL),
// then at most ONE data update, then Final, with the tag control call after Final
// (encrypt) or before Final (decrypt).
int EVP_EncryptUpdate(EVP_CIPHER_CTX* ctx, unsigned char* out, int* outl,
                      const unsigned char* in, int inl)
{
    if (!ctx || ctx->mode != sparkshim_cipher_ctx::Mode::Encrypt || ctx->finalized || inl < 0 || (inl > 0 && !in)) return 0;
    if (out == nullptr) { // additional authenticated data
        if (ctx->have_data) return 0;
        ctx->aad.insert(ctx->aad.end(), in, in + inl);
        if (outl) *outl = inl;
        return 1;
    }
    if (ctx->have_data) return 0;
    ctx->have_data = true;
    std::vector<unsigned char> cipher(static_cast<size_t>(inl) + kTagLen);
    AEADChaCha20Poly1305 aead(Bytes(ctx->key, kKeyLen));
    aead.Encrypt(Bytes(in, inl), Bytes(ctx->aad.data(), ctx->aad.size()), NonceFromIv(ctx->iv),
                 MutBytes(cipher.data(), cipher.size()));
    std::memcpy(out, cipher.data(), inl);
    std::memcpy(ctx->tag, cipher.data() + inl, kTagLen);
    ctx->have_tag = true;
    if (outl) *outl = inl;
    return 1;
}

int EVP_EncryptFinal_ex(EVP_CIPHER_CTX* ctx, unsigned char* out, int* outl)
{
    (void)out;
    if (!ctx || ctx->mode != sparkshim_cipher_ctx::Mode::Encrypt || ctx->finalized) return 0;
    if (!ctx->have_data) {
        // Empty plaintext: the tag still covers the AAD.
        unsigned char tagonly[kTagLen];
        AEADChaCha20Poly1305 aead(Bytes(ctx->key, kKeyLen));
        aead.Encrypt(Bytes(nullptr, 0), Bytes(ctx->aad.data(), ctx->aad.size()), NonceFromIv(ctx->iv),
                     MutBytes(tagonly, kTagLen));
        std::memcpy(ctx->tag, tagonly, kTagLen);
        ctx->have_data = true;
        ctx->have_tag = true;
    }
    ctx->finalized = true;
    if (outl) *outl = 0;
    return 1;
}

int EVP_DecryptUpdate(EVP_CIPHER_CTX* ctx, unsigned char* out, int* outl,
                      const unsigned char* in, int inl)
{
    if (!ctx || ctx->mode != sparkshim_cipher_ctx::Mode::Decrypt || ctx->finalized || inl < 0 || (inl > 0 && !in)) return 0;
    if (out == nullptr) {
        if (ctx->have_data) return 0;
        ctx->aad.insert(ctx->aad.end(), in, in + inl);
        if (outl) *outl = inl;
        return 1;
    }
    if (ctx->have_data) return 0;
    ctx->have_data = true;
    ctx->text.assign(in, in + inl);
    // As OpenSSL, plaintext is written now and authenticated by Final; the caller
    // (aead.cpp) throws away its buffer when Final fails.
    ctx->plain.resize(inl);
    AEADChaCha20Poly1305 aead(Bytes(ctx->key, kKeyLen));
    aead.Keystream(NonceFromIv(ctx->iv), MutBytes(ctx->plain.data(), ctx->plain.size()));
    for (int i = 0; i < inl; i++) ctx->plain[i] ^= in[i];
    std::memcpy(out, ctx->plain.data(), inl);
    if (outl) *outl = inl;
    return 1;
}

int EVP_DecryptFinal_ex(EVP_CIPHER_CTX* ctx, unsigned char* outm, int* outl)
{
    (void)outm;
    if (!ctx || ctx->mode != sparkshim_cipher_ctx::Mode::Decrypt || ctx->finalized || !ctx->have_tag) return 0;
    ctx->finalized = true;
    if (outl) *outl = 0;
    std::vector<unsigned char> cipher(ctx->text);
    cipher.insert(cipher.end(), ctx->tag, ctx->tag + kTagLen);
    std::vector<unsigned char> check(ctx->text.size());
    AEADChaCha20Poly1305 aead(Bytes(ctx->key, kKeyLen));
    const bool ok = aead.Decrypt(Bytes(cipher.data(), cipher.size()), Bytes(ctx->aad.data(), ctx->aad.size()),
                                 NonceFromIv(ctx->iv), MutBytes(check.data(), check.size()));
    const bool same = ok && check == ctx->plain;
    if (!check.empty()) SecureZero(check.data(), check.size());
    return same ? 1 : 0;
}

int EVP_CIPHER_CTX_ctrl(EVP_CIPHER_CTX* ctx, int type, int arg, void* ptr)
{
    if (!ctx || arg != kTagLen || !ptr) return 0;
    if (type == EVP_CTRL_AEAD_GET_TAG) {
        if (ctx->mode != sparkshim_cipher_ctx::Mode::Encrypt || !ctx->finalized || !ctx->have_tag) return 0;
        std::memcpy(ptr, ctx->tag, kTagLen);
        return 1;
    }
    if (type == EVP_CTRL_AEAD_SET_TAG) {
        if (ctx->mode != sparkshim_cipher_ctx::Mode::Decrypt || ctx->finalized) return 0;
        std::memcpy(ctx->tag, ptr, kTagLen);
        ctx->have_tag = true;
        return 1;
    }
    return 0;
}

// ---- RAND / cleanse --------------------------------------------------------------

int RAND_bytes(unsigned char* buf, int num)
{
    if (num < 0 || (num > 0 && !buf)) return 0;
    if (num == 0) return 1;
#ifdef __EMSCRIPTEN__
    return spark_random_fill(buf, num) == 1 ? 1 : 0;
#else
    arc4random_buf(buf, static_cast<size_t>(num));
    return 1;
#endif
}

void OPENSSL_cleanse(void* ptr, size_t len)
{
    SecureZero(ptr, len);
}

} // extern "C"
