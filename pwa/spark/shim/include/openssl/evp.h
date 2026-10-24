// SPDX-License-Identifier: MIT
// Campfire PWA: the subset of OpenSSL's EVP API that Firo's sparkmobile uses,
// implemented without OpenSSL (pwa/spark/shim/openssl_shim.cpp).
//
// sparkmobile (a9d0789) uses exactly:
//   SHA-512:            EVP_MD_CTX_new/free, EVP_sha512, EVP_MD_size,
//                       EVP_DigestInit_ex, EVP_DigestUpdate, EVP_DigestFinal_ex,
//                       EVP_MD_CTX_copy_ex                (hash, kdf, transcript, util, f4grumble)
//   ChaCha20-Poly1305:  EVP_CIPHER_CTX_new/free, EVP_chacha20_poly1305,
//                       EVP_{En,De}cryptInit_ex/Update/Final_ex, EVP_CIPHER_CTX_ctrl
//                       with EVP_CTRL_AEAD_{GET,SET}_TAG     (aead.cpp)
// Anything else is deliberately missing, so a new use upstream fails to compile
// instead of silently linking something unreviewed.
//
// The real symbols are prefixed (sparkshim_*) so a native test can link this
// shim next to real OpenSSL and compare them (pwa/spark/native/aead_diff.cpp).
#ifndef CAMPFIRE_SPARK_SHIM_OPENSSL_EVP_H
#define CAMPFIRE_SPARK_SHIM_OPENSSL_EVP_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct sparkshim_md_ctx EVP_MD_CTX;
typedef struct sparkshim_cipher_ctx EVP_CIPHER_CTX;
typedef struct sparkshim_md EVP_MD;
typedef struct sparkshim_cipher EVP_CIPHER;
typedef struct sparkshim_engine ENGINE;

#define EVP_CTRL_AEAD_GET_TAG 0x10
#define EVP_CTRL_AEAD_SET_TAG 0x11

#define EVP_MD_CTX_new sparkshim_EVP_MD_CTX_new
#define EVP_MD_CTX_free sparkshim_EVP_MD_CTX_free
#define EVP_sha512 sparkshim_EVP_sha512
#define EVP_MD_size sparkshim_EVP_MD_size
#define EVP_DigestInit_ex sparkshim_EVP_DigestInit_ex
#define EVP_DigestUpdate sparkshim_EVP_DigestUpdate
#define EVP_DigestFinal_ex sparkshim_EVP_DigestFinal_ex
#define EVP_MD_CTX_copy_ex sparkshim_EVP_MD_CTX_copy_ex
#define EVP_CIPHER_CTX_new sparkshim_EVP_CIPHER_CTX_new
#define EVP_CIPHER_CTX_free sparkshim_EVP_CIPHER_CTX_free
#define EVP_chacha20_poly1305 sparkshim_EVP_chacha20_poly1305
#define EVP_EncryptInit_ex sparkshim_EVP_EncryptInit_ex
#define EVP_EncryptUpdate sparkshim_EVP_EncryptUpdate
#define EVP_EncryptFinal_ex sparkshim_EVP_EncryptFinal_ex
#define EVP_DecryptInit_ex sparkshim_EVP_DecryptInit_ex
#define EVP_DecryptUpdate sparkshim_EVP_DecryptUpdate
#define EVP_DecryptFinal_ex sparkshim_EVP_DecryptFinal_ex
#define EVP_CIPHER_CTX_ctrl sparkshim_EVP_CIPHER_CTX_ctrl

EVP_MD_CTX* EVP_MD_CTX_new(void);
void EVP_MD_CTX_free(EVP_MD_CTX* ctx);
const EVP_MD* EVP_sha512(void);
int EVP_MD_size(const EVP_MD* md);
int EVP_DigestInit_ex(EVP_MD_CTX* ctx, const EVP_MD* type, ENGINE* impl);
int EVP_DigestUpdate(EVP_MD_CTX* ctx, const void* d, size_t cnt);
int EVP_DigestFinal_ex(EVP_MD_CTX* ctx, unsigned char* md, unsigned int* s);
int EVP_MD_CTX_copy_ex(EVP_MD_CTX* out, const EVP_MD_CTX* in);

EVP_CIPHER_CTX* EVP_CIPHER_CTX_new(void);
void EVP_CIPHER_CTX_free(EVP_CIPHER_CTX* ctx);
const EVP_CIPHER* EVP_chacha20_poly1305(void);
int EVP_EncryptInit_ex(EVP_CIPHER_CTX* ctx, const EVP_CIPHER* type, ENGINE* impl,
                       const unsigned char* key, const unsigned char* iv);
int EVP_EncryptUpdate(EVP_CIPHER_CTX* ctx, unsigned char* out, int* outl,
                      const unsigned char* in, int inl);
int EVP_EncryptFinal_ex(EVP_CIPHER_CTX* ctx, unsigned char* out, int* outl);
int EVP_DecryptInit_ex(EVP_CIPHER_CTX* ctx, const EVP_CIPHER* type, ENGINE* impl,
                       const unsigned char* key, const unsigned char* iv);
int EVP_DecryptUpdate(EVP_CIPHER_CTX* ctx, unsigned char* out, int* outl,
                      const unsigned char* in, int inl);
int EVP_DecryptFinal_ex(EVP_CIPHER_CTX* ctx, unsigned char* outm, int* outl);
int EVP_CIPHER_CTX_ctrl(EVP_CIPHER_CTX* ctx, int type, int arg, void* ptr);

#ifdef __cplusplus
}
#endif

#endif
