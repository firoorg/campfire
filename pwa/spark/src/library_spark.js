// SPDX-License-Identifier: MIT
// Emscripten JS library for the Campfire PWA Spark module (pwa/spark/build.sh).
//
// spark_random_fill is the only randomness the Spark library gets: every nonce,
// blinding factor and proof randomizer comes from RAND_bytes (shim/openssl_shim.cpp),
// which calls this. It reads crypto.getRandomValues on each call (the Web Crypto
// CSPRNG: browsers, workers, Node >= 19) and fails closed (returns 0, the C++
// side throws) when there is none: no fallback to anything weaker.
// The module is built without shared memory, so the view into the heap is an
// ordinary ArrayBuffer view, which getRandomValues accepts.
mergeInto(LibraryManager.library, {
  spark_random_fill: function (ptr, len) {
    var c = (typeof globalThis === 'object' && globalThis) ? globalThis.crypto : undefined;
    if (!c || typeof c.getRandomValues !== 'function') return 0;
    if (ptr <= 0 || len < 0 || ptr + len > HEAPU8.length) return 0;
    // getRandomValues fills at most 65,536 bytes per call.
    for (var off = 0; off < len; off += 65536) {
      var n = Math.min(65536, len - off);
      c.getRandomValues(HEAPU8.subarray(ptr + off, ptr + off + n));
    }
    return 1;
  },
});
