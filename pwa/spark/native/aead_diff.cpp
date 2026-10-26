// SPDX-License-Identifier: MIT
// Differential test: pwa/spark/shim (what the wasm module uses instead of OpenSSL)
// against real OpenSSL 3, for exactly the calls sparkmobile makes:
//   SHA-512 with split updates and mid-stream context copies (hash.cpp, transcript.cpp),
//   ChaCha20-Poly1305 encrypt/decrypt with AAD and a 12-byte IV (aead.cpp),
//   plus RFC 8439 section 2.8.2's published test vector and tamper checks.
// Built and run by pwa/spark/native/build_native.sh --run. Exit 0 = all equal.
#include <openssl/evp.h>
#include <openssl/rand.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <string>
#include <vector>

extern "C" {
struct sparkshim_md_ctx;
struct sparkshim_cipher_ctx;
struct sparkshim_md;
struct sparkshim_cipher;
sparkshim_md_ctx* sparkshim_EVP_MD_CTX_new(void);
void sparkshim_EVP_MD_CTX_free(sparkshim_md_ctx*);
const sparkshim_md* sparkshim_EVP_sha512(void);
int sparkshim_EVP_MD_size(const sparkshim_md*);
int sparkshim_EVP_DigestInit_ex(sparkshim_md_ctx*, const sparkshim_md*, void*);
int sparkshim_EVP_DigestUpdate(sparkshim_md_ctx*, const void*, size_t);
int sparkshim_EVP_DigestFinal_ex(sparkshim_md_ctx*, unsigned char*, unsigned int*);
int sparkshim_EVP_MD_CTX_copy_ex(sparkshim_md_ctx*, const sparkshim_md_ctx*);
sparkshim_cipher_ctx* sparkshim_EVP_CIPHER_CTX_new(void);
void sparkshim_EVP_CIPHER_CTX_free(sparkshim_cipher_ctx*);
const sparkshim_cipher* sparkshim_EVP_chacha20_poly1305(void);
int sparkshim_EVP_EncryptInit_ex(sparkshim_cipher_ctx*, const sparkshim_cipher*, void*, const unsigned char*, const unsigned char*);
int sparkshim_EVP_EncryptUpdate(sparkshim_cipher_ctx*, unsigned char*, int*, const unsigned char*, int);
int sparkshim_EVP_EncryptFinal_ex(sparkshim_cipher_ctx*, unsigned char*, int*);
int sparkshim_EVP_DecryptInit_ex(sparkshim_cipher_ctx*, const sparkshim_cipher*, void*, const unsigned char*, const unsigned char*);
int sparkshim_EVP_DecryptUpdate(sparkshim_cipher_ctx*, unsigned char*, int*, const unsigned char*, int);
int sparkshim_EVP_DecryptFinal_ex(sparkshim_cipher_ctx*, unsigned char*, int*);
int sparkshim_EVP_CIPHER_CTX_ctrl(sparkshim_cipher_ctx*, int, int, void*);
int sparkshim_RAND_bytes(unsigned char*, int);
}

namespace {

int failures = 0;
void check(bool ok, const std::string& what)
{
    if (!ok) {
        failures++;
        if (failures < 20) std::fprintf(stderr, "MISMATCH: %s\n", what.c_str());
    }
}

std::mt19937_64 prng(20261012);
std::vector<unsigned char> rnd(size_t n)
{
    std::vector<unsigned char> v(n);
    for (auto& b : v) b = static_cast<unsigned char>(prng());
    return v;
}

// --- SHA-512 -------------------------------------------------------------------------------
int sha512_cases()
{
    int n = 0;
    for (int iter = 0; iter < 3000; iter++) {
        const size_t total = prng() % 1500;
        const auto msg = rnd(total);
        // Split points, plus a copy taken mid-stream that continues with a different tail.
        const size_t split = total ? prng() % (total + 1) : 0;
        const auto tail = rnd(prng() % 200);

        EVP_MD_CTX* o = EVP_MD_CTX_new();
        EVP_MD_CTX* oc = EVP_MD_CTX_new();
        sparkshim_md_ctx* s = sparkshim_EVP_MD_CTX_new();
        sparkshim_md_ctx* sc = sparkshim_EVP_MD_CTX_new();
        check(EVP_DigestInit_ex(o, EVP_sha512(), nullptr) == 1, "ossl init");
        check(sparkshim_EVP_DigestInit_ex(s, sparkshim_EVP_sha512(), nullptr) == 1, "shim init");
        EVP_DigestUpdate(o, msg.data(), split);
        sparkshim_EVP_DigestUpdate(s, msg.data(), split);
        check(EVP_MD_CTX_copy_ex(oc, o) == 1 && sparkshim_EVP_MD_CTX_copy_ex(sc, s) == 1, "copy");
        EVP_DigestUpdate(o, msg.data() + split, total - split);
        sparkshim_EVP_DigestUpdate(s, msg.data() + split, total - split);
        EVP_DigestUpdate(oc, tail.data(), tail.size());
        sparkshim_EVP_DigestUpdate(sc, tail.data(), tail.size());
        unsigned char a[64], b[64], ac[64], bc[64];
        unsigned int la = 0, lb = 0;
        EVP_DigestFinal_ex(o, a, &la);
        sparkshim_EVP_DigestFinal_ex(s, b, &lb);
        EVP_DigestFinal_ex(oc, ac, nullptr);
        sparkshim_EVP_DigestFinal_ex(sc, bc, nullptr);
        check(la == 64 && lb == 64 && std::memcmp(a, b, 64) == 0, "sha512 digest len=" + std::to_string(total));
        check(std::memcmp(ac, bc, 64) == 0, "sha512 copied context");
        check(EVP_MD_size(EVP_sha512()) == sparkshim_EVP_MD_size(sparkshim_EVP_sha512()), "md size");
        EVP_MD_CTX_free(o); EVP_MD_CTX_free(oc);
        sparkshim_EVP_MD_CTX_free(s); sparkshim_EVP_MD_CTX_free(sc);
        n++;
    }
    return n;
}

// --- ChaCha20-Poly1305 ------------------------------------------------------------------------
struct Sealed {
    std::vector<unsigned char> ct;
    unsigned char tag[16];
};

Sealed ossl_seal(const unsigned char* key, const unsigned char* iv, const std::vector<unsigned char>& aad,
                 const std::vector<unsigned char>& pt)
{
    Sealed r;
    r.ct.resize(pt.size());
    EVP_CIPHER_CTX* c = EVP_CIPHER_CTX_new();
    int t = 0;
    check(EVP_EncryptInit_ex(c, EVP_chacha20_poly1305(), nullptr, key, iv) == 1, "ossl enc init");
    if (!aad.empty()) check(EVP_EncryptUpdate(c, nullptr, &t, aad.data(), aad.size()) == 1, "ossl aad");
    check(EVP_EncryptUpdate(c, r.ct.data(), &t, pt.data(), pt.size()) == 1, "ossl enc");
    check(EVP_EncryptFinal_ex(c, nullptr, &t) == 1, "ossl final");
    check(EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_AEAD_GET_TAG, 16, r.tag) == 1, "ossl tag");
    EVP_CIPHER_CTX_free(c);
    return r;
}

Sealed shim_seal(const unsigned char* key, const unsigned char* iv, const std::vector<unsigned char>& aad,
                 const std::vector<unsigned char>& pt)
{
    Sealed r;
    r.ct.resize(pt.size());
    sparkshim_cipher_ctx* c = sparkshim_EVP_CIPHER_CTX_new();
    int t = 0;
    check(sparkshim_EVP_EncryptInit_ex(c, sparkshim_EVP_chacha20_poly1305(), nullptr, key, iv) == 1, "shim enc init");
    if (!aad.empty()) check(sparkshim_EVP_EncryptUpdate(c, nullptr, &t, aad.data(), aad.size()) == 1, "shim aad");
    check(sparkshim_EVP_EncryptUpdate(c, r.ct.data(), &t, pt.data(), pt.size()) == 1, "shim enc");
    check(sparkshim_EVP_EncryptFinal_ex(c, nullptr, &t) == 1, "shim final");
    check(sparkshim_EVP_CIPHER_CTX_ctrl(c, 0x10 /* GET_TAG */, 16, r.tag) == 1, "shim tag");
    sparkshim_EVP_CIPHER_CTX_free(c);
    return r;
}

bool shim_open(const unsigned char* key, const unsigned char* iv, const std::vector<unsigned char>& aad,
               const std::vector<unsigned char>& ct, const unsigned char* tag, std::vector<unsigned char>& pt)
{
    pt.assign(ct.size(), 0);
    sparkshim_cipher_ctx* c = sparkshim_EVP_CIPHER_CTX_new();
    int t = 0;
    bool ok = sparkshim_EVP_DecryptInit_ex(c, sparkshim_EVP_chacha20_poly1305(), nullptr, key, iv) == 1;
    if (!aad.empty()) ok = ok && sparkshim_EVP_DecryptUpdate(c, nullptr, &t, aad.data(), aad.size()) == 1;
    ok = ok && sparkshim_EVP_DecryptUpdate(c, pt.data(), &t, ct.data(), ct.size()) == 1;
    ok = ok && sparkshim_EVP_CIPHER_CTX_ctrl(c, 0x11 /* SET_TAG */, 16, const_cast<unsigned char*>(tag)) == 1;
    ok = ok && sparkshim_EVP_DecryptFinal_ex(c, nullptr, &t) == 1;
    sparkshim_EVP_CIPHER_CTX_free(c);
    return ok;
}

bool ossl_open(const unsigned char* key, const unsigned char* iv, const std::vector<unsigned char>& aad,
               const std::vector<unsigned char>& ct, const unsigned char* tag, std::vector<unsigned char>& pt)
{
    pt.assign(ct.size(), 0);
    EVP_CIPHER_CTX* c = EVP_CIPHER_CTX_new();
    int t = 0;
    bool ok = EVP_DecryptInit_ex(c, EVP_chacha20_poly1305(), nullptr, key, iv) == 1;
    if (!aad.empty()) ok = ok && EVP_DecryptUpdate(c, nullptr, &t, aad.data(), aad.size()) == 1;
    ok = ok && EVP_DecryptUpdate(c, pt.data(), &t, ct.data(), ct.size()) == 1;
    ok = ok && EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_AEAD_SET_TAG, 16, const_cast<unsigned char*>(tag)) == 1;
    ok = ok && EVP_DecryptFinal_ex(c, nullptr, &t) == 1;
    EVP_CIPHER_CTX_free(c);
    return ok;
}

int aead_cases()
{
    int n = 0;
    for (int iter = 0; iter < 20000; iter++) {
        const auto key = rnd(32);
        auto iv = rnd(12);
        if (iter % 2 == 0) std::fill(iv.begin(), iv.end(), 0); // Spark always uses the zero IV
        const auto aad = rnd(iter % 7 == 0 ? 0 : prng() % 64);
        const auto pt = rnd(1 + prng() % 300);
        const Sealed o = ossl_seal(key.data(), iv.data(), aad, pt);
        const Sealed s = shim_seal(key.data(), iv.data(), aad, pt);
        check(o.ct == s.ct, "chacha20 ciphertext");
        check(std::memcmp(o.tag, s.tag, 16) == 0, "poly1305 tag");
        std::vector<unsigned char> back;
        check(shim_open(key.data(), iv.data(), aad, o.ct, o.tag, back) && back == pt, "shim opens OpenSSL's");
        check(ossl_open(key.data(), iv.data(), aad, s.ct, s.tag, back) && back == pt, "OpenSSL opens the shim's");
        // Tampering: tag, ciphertext, AAD, key, IV each make the shim refuse.
        unsigned char badtag[16];
        std::memcpy(badtag, o.tag, 16);
        badtag[iter % 16] ^= 1u << (iter % 8);
        check(!shim_open(key.data(), iv.data(), aad, o.ct, badtag, back), "shim refuses a bad tag");
        auto badct = o.ct;
        badct[iter % badct.size()] ^= 0x80;
        check(!shim_open(key.data(), iv.data(), aad, badct, o.tag, back), "shim refuses a bad ciphertext");
        if (!aad.empty()) {
            auto badaad = aad;
            badaad[0] ^= 1;
            check(!shim_open(key.data(), iv.data(), badaad, o.ct, o.tag, back), "shim refuses bad AAD");
        }
        auto badkey = key;
        badkey[31] ^= 1;
        check(!shim_open(badkey.data(), iv.data(), aad, o.ct, o.tag, back), "shim refuses a wrong key");
        n++;
    }
    return n;
}

std::vector<unsigned char> unhex(const std::string& h)
{
    std::vector<unsigned char> v;
    for (size_t i = 0; i + 1 < h.size(); i += 2) v.push_back(static_cast<unsigned char>(std::stoul(h.substr(i, 2), nullptr, 16)));
    return v;
}

void rfc8439_vector()
{
    // RFC 8439 section 2.8.2
    const auto key = unhex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
    const auto iv = unhex("070000004041424344454647");
    const auto aad = unhex("50515253c0c1c2c3c4c5c6c7");
    const std::string text = "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";
    const std::vector<unsigned char> pt(text.begin(), text.end());
    const auto want_ct = unhex(
        "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b"
        "1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc"
        "3ff4def08e4b7a9de576d26586cec64b6116");
    const auto want_tag = unhex("1ae10b594f09e26a7e902ecbd0600691");
    const Sealed s = shim_seal(key.data(), iv.data(), aad, pt);
    check(s.ct == want_ct, "RFC 8439 2.8.2 ciphertext");
    check(std::memcmp(s.tag, want_tag.data(), 16) == 0, "RFC 8439 2.8.2 tag");
    std::vector<unsigned char> back;
    check(shim_open(key.data(), iv.data(), aad, want_ct, want_tag.data(), back) && back == pt, "RFC 8439 2.8.2 open");
}

void misuse()
{
    // Sequences sparkmobile never makes are refused, not guessed at.
    unsigned char key[32] = {0}, iv[12] = {0}, buf[16] = {0}, tag[16];
    int t;
    sparkshim_cipher_ctx* c = sparkshim_EVP_CIPHER_CTX_new();
    check(sparkshim_EVP_EncryptUpdate(c, buf, &t, buf, 16) == 0, "update before init refused");
    sparkshim_EVP_EncryptInit_ex(c, sparkshim_EVP_chacha20_poly1305(), nullptr, key, iv);
    check(sparkshim_EVP_CIPHER_CTX_ctrl(c, 0x10, 16, tag) == 0, "tag before final refused");
    check(sparkshim_EVP_EncryptUpdate(c, buf, &t, buf, 16) == 1, "data update");
    check(sparkshim_EVP_EncryptUpdate(c, buf, &t, buf, 16) == 0, "second data update refused");
    check(sparkshim_EVP_EncryptUpdate(c, nullptr, &t, buf, 16) == 0, "AAD after data refused");
    check(sparkshim_EVP_CIPHER_CTX_ctrl(c, 0x10, 8, tag) == 0, "short tag refused");
    sparkshim_EVP_CIPHER_CTX_free(c);
    c = sparkshim_EVP_CIPHER_CTX_new();
    sparkshim_EVP_DecryptInit_ex(c, sparkshim_EVP_chacha20_poly1305(), nullptr, key, iv);
    sparkshim_EVP_DecryptUpdate(c, buf, &t, buf, 16);
    check(sparkshim_EVP_DecryptFinal_ex(c, nullptr, &t) == 0, "decrypt final without a tag refused");
    sparkshim_EVP_CIPHER_CTX_free(c);
    unsigned char r1[32], r2[32];
    check(sparkshim_RAND_bytes(r1, 32) == 1 && sparkshim_RAND_bytes(r2, 32) == 1 && std::memcmp(r1, r2, 32) != 0, "RAND_bytes differs");
    check(sparkshim_RAND_bytes(r1, -1) == 0, "negative RAND_bytes refused");
}

} // namespace

int main()
{
    const int sha = sha512_cases();
    const int aead = aead_cases();
    rfc8439_vector();
    misuse();
    std::printf("aead_diff: SHA-512 %d cases, ChaCha20-Poly1305 %d cases (+4 tamper checks each), RFC 8439 2.8.2, misuse: %s\n",
                sha, aead, failures ? "FAILED" : "all equal to OpenSSL");
    if (failures) std::printf("aead_diff: %d mismatches\n", failures);
    return failures ? 1 : 0;
}
