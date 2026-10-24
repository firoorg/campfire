// SPDX-License-Identifier: MIT
// Campfire PWA: OpenSSL's RAND_bytes for sparkmobile, without OpenSSL.
// It is the ONLY randomness source of the Spark library (secp256k1/src/cpp/
// Scalar.cpp and GroupElement.cpp). In the browser it is crypto.getRandomValues
// (pwa/spark/src/library_spark.js); natively (tests only) it is arc4random_buf.
#ifndef CAMPFIRE_SPARK_SHIM_OPENSSL_RAND_H
#define CAMPFIRE_SPARK_SHIM_OPENSSL_RAND_H

#ifdef __cplusplus
extern "C" {
#endif

#define RAND_bytes sparkshim_RAND_bytes

// Returns 1 and fills buf with num random bytes, or returns 0 (callers throw).
int RAND_bytes(unsigned char* buf, int num);

#ifdef __cplusplus
}
#endif

#endif
