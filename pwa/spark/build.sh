#!/usr/bin/env bash
# Build Firo's Spark library as WebAssembly for the Campfire web wallet (pwa/).
#
# What goes in (every input pinned in pwa/spark/spark.lock.json and checked here):
#   - firoorg/sparkmobile a9d0789: the Spark code Campfire runs. Campfire staging
#     (ad945d43d) pins cypherstack/flutter_libsparkmobile 3fdcb21, which vendors
#     sparkmobile a9d0789 unchanged (apart from build files). Checked by tarball
#     SHA-256 AND by recomputing the git tree id of the unpacked files.
#   - Bitcoin Core v27.2 ChaCha20/Poly1305 (RFC 8439), per-file SHA-256.
#   - pwa/spark/shim: OpenSSL replaced (SHA-512, ChaCha20-Poly1305, RAND_bytes ->
#     crypto.getRandomValues, cleanse) and boost::optional; pwa/spark/src: our C ABI.
#   - emsdk 3.1.10 (commit 891b4491), the toolchain of BEAM's engine, with its own
#     Emscripten cache so another project's cache cannot change our output.
# sparkmobile itself is compiled unmodified, with the secp256k1 switches of
# flutter_libsparkmobile's CMake (wasm32 = 32-bit limbs: USE_FIELD_10X26/USE_SCALAR_8X32).
#
# What comes out: pwa/src/vendor/spark/spark.wasm and spark.js, an Emscripten
# MINIMAL_RUNTIME ES module factory: no eval (DYNAMIC_EXECUTION=0), no loader of its
# own (no fetch/XHR: pwa/src/lib/firo/spark/core.js hands it the wasm bytes), no file
# system. Single-threaded, no SharedArrayBuffer, wasm exceptions.
#
# Usage:
#   pwa/spark/build.sh                 build, refuse unless outputs match the lock, then install
#   pwa/spark/build.sh --update-lock   build, install, and write the new output hashes into the lock
#   pwa/spark/build.sh --check         build into a temp dir and only compare with the lock
# Env: FIRO_DEPS (default ~/Desktop/Firo/deps: downloads, unpacked sources, build dir, Emscripten cache),
#      EMSDK_DIR (default ~/Desktop/Beam/beam-core-build/wasm/emsdk), JOBS (default 4).
set -euo pipefail

MODE="verify"
case "${1:-}" in
    "") ;;
    --update-lock) MODE="update" ;;
    --check) MODE="check" ;;
    *) echo "usage: $0 [--update-lock|--check]" >&2; exit 2 ;;
esac

die() { echo "build.sh: $*" >&2; exit 1; }
log() { echo "build.sh: $*"; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PWA="$(cd "${HERE}/.." && pwd)"
DEPS="${FIRO_DEPS:-${HOME}/Desktop/Firo/deps}"
EMSDK_DIR="${EMSDK_DIR:-${HOME}/Desktop/Beam/beam-core-build/wasm/emsdk}"
JOBS="${JOBS:-4}"
INSTALL_DIR="${PWA}/src/vendor/spark"
# shellcheck source=sources.sh
source "${HERE}/sources.sh"

EMSDK_VERSION="$(lock toolchain.emsdk_version)"
EMSDK_COMMIT="$(lock toolchain.emsdk_commit)"

# ---- toolchain -------------------------------------------------------------------------
[[ -d "${EMSDK_DIR}" ]] || die "no emsdk at ${EMSDK_DIR} (set EMSDK_DIR)"
[[ "$(git -C "$EMSDK_DIR" rev-parse HEAD)" == "$EMSDK_COMMIT" ]] || die "emsdk is not at ${EMSDK_COMMIT}"
# shellcheck disable=SC1091
source "${EMSDK_DIR}/emsdk_env.sh" > /dev/null 2>&1
emcc --version | head -1 | grep -q " ${EMSDK_VERSION} " || die "emcc is not ${EMSDK_VERSION}"
export EM_CACHE="${DEPS}/emcache-${EMSDK_VERSION}"
EMSCRIPTEN_ROOT="$(cd "$(dirname "$(command -v emcc)")" && pwd)"

# ---- sources ---------------------------------------------------------------------------
BUILD="${DEPS}/build-spark-wasm"
SRC="${BUILD}/src"
OBJ="${BUILD}/obj"
rm -rf "$BUILD"
mkdir -p "$SRC" "$OBJ" "${BUILD}/out"
prepare_sources "$SRC"
cp -R "${HERE}/shim" "${SRC}/shim"
cp -R "${HERE}/src" "${SRC}/campfire"

# ---- compile ----------------------------------------------------------------------------
SM="${SRC}/sparkmobile"
BTC="${SRC}/bitcoin-core/src"
# Paths inside the output name nothing on this machine.
MAP="-ffile-prefix-map=${SRC}=/spark -ffile-prefix-map=${EMSCRIPTEN_ROOT}=/emscripten -ffile-prefix-map=${BUILD}=/build"
SECP_DEFS="-DENABLE_MODULE_ECDH=1 -DUSE_ENDOMORPHISM=1 -DUSE_NUM_NONE=1 -DUSE_FIELD_INV_BUILTIN=1 -DUSE_SCALAR_INV_BUILTIN=1 -DUSE_FIELD_10X26=1 -DUSE_SCALAR_8X32=1"
CFLAGS_COMMON="-O3 ${MAP} ${SECP_DEFS} -I${SRC}/shim/include -I${SM}/secp256k1 -I${SM}/secp256k1/include -I${SM}/secp256k1/src"
CXXFLAGS_COMMON="${CFLAGS_COMMON} -fwasm-exceptions"

JOBDIR="${BUILD}/jobs"
mkdir -p "$JOBDIR"
NJOBS=0
add_job() { # std source
    local std="$1" src="$2" obj
    obj="${OBJ}/$(echo "${src#"${SRC}"/}" | tr '/' '_').o"
    NJOBS=$((NJOBS + 1))
    if [[ "$std" == "c" ]]; then
        echo "emcc ${CFLAGS_COMMON} -c ${src} -o ${obj}" > "$(printf '%s/%03d.sh' "$JOBDIR" "$NJOBS")"
    else
        echo "em++ -std=${std} ${CXXFLAGS_COMMON} ${EXTRA_INC:-} -c ${src} -o ${obj}" > "$(printf '%s/%03d.sh' "$JOBDIR" "$NJOBS")"
    fi
}
for f in "${SM}"/src/*.cpp "${SM}"/bitcoin/*.cpp "${SM}"/bitcoin/support/*.cpp "${SM}"/bitcoin/crypto/*.cpp \
         "${SM}"/secp256k1/src/cpp/GroupElement.cpp "${SM}"/secp256k1/src/cpp/MultiExponent.cpp "${SM}"/secp256k1/src/cpp/Scalar.cpp; do
    add_job c++17 "$f"
done
add_job c "${SM}/secp256k1/src/secp256k1.c"
EXTRA_INC="-I${BTC}"
for f in "${BTC}/crypto/chacha20.cpp" "${BTC}/crypto/poly1305.cpp" "${BTC}/crypto/chacha20poly1305.cpp"; do
    add_job c++20 "$f"
done
EXTRA_INC="-I${BTC} -I${SM}"
add_job c++20 "${SRC}/shim/openssl_shim.cpp"
EXTRA_INC="-I${SM}"
add_job c++17 "${SRC}/campfire/spark_wasm.cpp"
unset EXTRA_INC

log "compiling ${NJOBS} files (JOBS=${JOBS}; cache ${EM_CACHE})"
# Warm the Emscripten cache once, serially, so parallel jobs do not race to build it.
echo 'int main(){return 0;}' > "${BUILD}/warm.cpp"
em++ -fwasm-exceptions -O3 "${BUILD}/warm.cpp" -o "${BUILD}/warm.js" > "${BUILD}/warm.log" 2>&1 || { cat "${BUILD}/warm.log"; die "toolchain warm-up failed"; }
: > "${BUILD}/compile.log"
ls "$JOBDIR"/*.sh | xargs -P "$JOBS" -n 1 sh -c 'sh "$1" >> "$1.log" 2>&1 || { echo "FAILED: $(cat "$1")"; cat "$1.log"; exit 255; }' _ \
    > "${BUILD}/compile.log" 2>&1 \
    || { grep -E 'error|FAILED' "${BUILD}/compile.log" | head -40; die "compile failed (${BUILD}/compile.log)"; }

# ---- link -------------------------------------------------------------------------------
# MINIMAL_RUNTIME: a 14 KB glue with no loader of its own (no fetch, XHR or importScripts:
# core.js hands it the wasm bytes), no eval, no file system. With MODULARIZE its exports
# stay inside the factory, so a generated --post-js hands them out as Module.sparkExports().
EXPORT_NAMES="$(lock build.exports | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).join(" "))')"
EXPORTS="$(for n in $EXPORT_NAMES; do printf '_%s,' "$n"; done | sed 's/,$//')"
{
    echo "// Generated by pwa/spark/build.sh: the exports, and the heap as it is after any growth."
    echo "Module['sparkExports'] = function () {"
    echo "  return {"
    echo "    HEAPU8: HEAPU8,"
    for n in $EXPORT_NAMES; do echo "    ${n}: _${n},"; done
    echo "  };"
    echo "};"
} > "${BUILD}/post.js"
OBJS="$(ls "${OBJ}"/*.o | LC_ALL=C sort | tr '\n' ' ')"
# shellcheck disable=SC2086
em++ -O3 -fwasm-exceptions ${MAP} ${OBJS} \
    --js-library "${SRC}/campfire/library_spark.js" --post-js "${BUILD}/post.js" \
    -sMINIMAL_RUNTIME=1 -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createSparkModule \
    -sENVIRONMENT=web,worker \
    -sFILESYSTEM=0 -sDYNAMIC_EXECUTION=0 \
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sMAXIMUM_MEMORY=1073741824 \
    -sSUPPORT_LONGJMP=0 -sASSERTIONS=0 \
    "-sEXPORTED_FUNCTIONS=${EXPORTS}" "-sEXPORTED_RUNTIME_METHODS=[]" \
    -o "${BUILD}/out/spark.js" > "${BUILD}/link.log" 2>&1 || { cat "${BUILD}/link.log"; die "link failed"; }

OUT="${BUILD}/out"
for f in spark.js spark.wasm; do [[ -s "${OUT}/$f" ]] || die "missing output $f"; done
# ("/home/web_user" is Emscripten's fixed default $HOME, not this machine.)
if LC_ALL=C command grep -a -l -E "${HOME}|${DEPS}|/Users/|/private/|/home/runner" "${OUT}"/spark.* ; then
    die "an output names a local path (above)"
fi
if LC_ALL=C command grep -E -n '(^|[^A-Za-z0-9_$.])eval\(|new Function\(' "${OUT}/spark.js"; then
    die "the glue uses eval or new Function (the CSP has no 'unsafe-eval')"
fi
# Vendored code makes no requests of its own (the rule pwa/test/unit/config.test.mjs applies to src/vendor).
if LC_ALL=C command grep -E -n '\b(fetch\(|XMLHttpRequest|WebSocket|importScripts|sendBeacon|EventSource)' "${OUT}/spark.js"; then
    die "the glue can make requests"
fi
JS_SHA="$(sha256_of "${OUT}/spark.js")"
WASM_SHA="$(sha256_of "${OUT}/spark.wasm")"
printf '%s  spark.js\n%s  spark.wasm\n' "$JS_SHA" "$WASM_SHA" | tee "${OUT}/SHA256SUMS.txt"
log "spark.wasm $(wc -c < "${OUT}/spark.wasm" | tr -d ' ') bytes, spark.js $(wc -c < "${OUT}/spark.js" | tr -d ' ') bytes, ${SECONDS}s"

WANT_JS="$(node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((l.files||{})["spark.js"]||"")' "$LOCK")"
WANT_WASM="$(node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((l.files||{})["spark.wasm"]||"")' "$LOCK")"

case "$MODE" in
    check)
        [[ "$JS_SHA" == "$WANT_JS" && "$WASM_SHA" == "$WANT_WASM" ]] || die "outputs differ from the lock (js ${WANT_JS:0:12}…, wasm ${WANT_WASM:0:12}…)"
        log "reproduced: outputs match spark.lock.json"
        exit 0
        ;;
    verify)
        [[ "$JS_SHA" == "$WANT_JS" && "$WASM_SHA" == "$WANT_WASM" ]] || die "outputs differ from the lock; nothing installed (run with --update-lock to accept them)"
        ;;
    update)
        node -e '
            const fs = require("fs");
            const [file, js, wasm] = process.argv.slice(1);
            const l = JSON.parse(fs.readFileSync(file, "utf8"));
            l.files = { "spark.js": js, "spark.wasm": wasm };
            fs.writeFileSync(file, JSON.stringify(l, null, 2) + "\n");
        ' "$LOCK" "$JS_SHA" "$WASM_SHA"
        log "spark.lock.json updated"
        ;;
esac
mkdir -p "$INSTALL_DIR"
cp "${OUT}/spark.js" "${OUT}/spark.wasm" "$INSTALL_DIR/"
log "installed into ${INSTALL_DIR#"${PWA}"/}"
