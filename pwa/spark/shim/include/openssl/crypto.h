// SPDX-License-Identifier: MIT
// Campfire PWA: OpenSSL's OPENSSL_cleanse for sparkmobile (bitcoin/support/cleanse.cpp).
#ifndef CAMPFIRE_SPARK_SHIM_OPENSSL_CRYPTO_H
#define CAMPFIRE_SPARK_SHIM_OPENSSL_CRYPTO_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define OPENSSL_cleanse sparkshim_OPENSSL_cleanse

// Overwrites len bytes at ptr with zeros in a way the compiler may not drop.
void OPENSSL_cleanse(void* ptr, size_t len);

#ifdef __cplusplus
}
#endif

#endif
