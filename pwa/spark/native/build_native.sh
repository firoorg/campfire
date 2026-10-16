#!/usr/bin/env bash
# Native (macOS/Linux) build of the SAME pinned Spark sources, for the golden vectors
# and the OpenSSL-shim differential test. Nothing built here ships.
#
# It compiles, with the host clang and real OpenSSL 3 (Homebrew openssl@3 or pkg-config):
#   - sparkmobile a9d0789 (verified exactly as build.sh does), 64-bit secp256k1 limbs
#     as flutter_libsparkmobile's CMake picks on 64-bit hosts;
#   - Campfire's own C ABI, cypherstack/flutter_libsparkmobile 3fdcb21 src/*.cpp
#     (git blob ids checked against spark.lock.json), so the vectors come from the
#     code Campfire runs;
#   - our C ABI (pwa/spark/src/spark_wasm.cpp), so the harness can also check it natively;
#   - native/vectors.cpp  -> bin/vectors  (writes pwa/test/fixtures/firo_spark_vectors.json)
#   - native/aead_diff.cpp + shim/openssl_shim.cpp -> bin/aead_diff (shim vs OpenSSL)
#
# Usage: pwa/spark/native/build_native.sh [--run]
#   --run  also runs aead_diff and regenerates the vectors file.
# Env: FIRO_DEPS (default ~/Desktop/Firo/deps), OPENSSL_PREFIX (default brew --prefix openssl@3),
#      BOOST_INCLUDE (Boost headers for boost::optional; default BEAM's pinned 1.90 headers,
#      else the shim), JOBS (default 4).
set -euo pipefail

die() { echo "build_native.sh: $*" >&2; exit 1; }
log() { echo "build_native.sh: $*"; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PWA="$(cd "${HERE}/.." && pwd)"
DEPS="${FIRO_DEPS:-${HOME}/Desktop/Firo/deps}"
JOBS="${JOBS:-4}"
# shellcheck source=../sources.sh
source "${HERE}/sources.sh"

OPENSSL_PREFIX="${OPENSSL_PREFIX:-$(brew --prefix openssl@3 2>/dev/null || true)}"
[[ -f "${OPENSSL_PREFIX}/include/openssl/evp.h" ]] || die "no OpenSSL 3 headers (set OPENSSL_PREFIX)"
BOOST_INCLUDE="${BOOST_INCLUDE:-${HOME}/Desktop/Beam/beam-core-build/wasm/deps/boost/include}"
if [[ -f "${BOOST_INCLUDE}/boost/optional.hpp" ]]; then
    BOOST_FLAG="-I${BOOST_INCLUDE}"
    BOOST_NOTE="boost headers ${BOOST_INCLUDE}"
else
    mkdir -p "${DEPS}/build-spark-native/boostshim/boost"
    cp "${HERE}/shim/include/boost/optional.hpp" "${DEPS}/build-spark-native/boostshim/boost/"
    BOOST_FLAG="-I${DEPS}/build-spark-native/boostshim"
    BOOST_NOTE="boost::optional shim (no Boost headers found)"
fi
CXX="${CXX:-clang++}"
CC="${CC:-clang}"

NB="${DEPS}/build-spark-native"
SRC="${NB}/src"
OBJ="${NB}/obj"
BIN="${NB}/bin"
rm -rf "$SRC" "$OBJ" "$BIN"
mkdir -p "$SRC" "$OBJ" "$BIN"
prepare_sources "$SRC"

# ---- flutter_libsparkmobile's C ABI (Campfire) -------------------------------------------
FLS_COMMIT="$(lock sources.flutter_libsparkmobile.commit)"
FLS="${SRC}/flutter_libsparkmobile"
mkdir -p "${FLS}/src/deps"
for f in src/flutter_libsparkmobile.cpp src/flutter_libsparkmobile.h src/structs.h src/utils.cpp src/utils.h src/transaction.cpp src/transaction.h LICENSE; do
    cached="${DEPS}/dl/flutter_libsparkmobile-${FLS_COMMIT:0:12}/${f}"
    if [[ ! -f "$cached" ]]; then
        mkdir -p "$(dirname "$cached")"
        log "downloading flutter_libsparkmobile ${f}"
        curl -sSfL --retry 3 -o "${cached}.part" "https://raw.githubusercontent.com/cypherstack/flutter_libsparkmobile/${FLS_COMMIT}/${f}" \
            || die "download failed: ${f}"
        mv "${cached}.part" "$cached"
    fi
    want="$(node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((l.sources.flutter_libsparkmobile.c_abi_blobs||{})[process.argv[2]]||"")' "$LOCK" "$f")"
    if [[ -n "$want" ]]; then
        got="$(git hash-object "$cached")"
        [[ "$got" == "$want" ]] || die "REFUSED flutter_libsparkmobile ${f}: git blob ${got} != pinned ${want}"
    fi
    cp "$cached" "${FLS}/${f}"
done
ln -s ../../../sparkmobile "${FLS}/src/deps/sparkmobile"
log "flutter_libsparkmobile ${FLS_COMMIT:0:10}: C ABI sources verified"

# ---- compile ----------------------------------------------------------------------------
SM="${SRC}/sparkmobile"
BTC="${SRC}/bitcoin-core/src"
SECP_DEFS="-DENABLE_MODULE_ECDH=1 -DUSE_ENDOMORPHISM=1 -DUSE_NUM_NONE=1 -DUSE_FIELD_INV_BUILTIN=1 -DUSE_SCALAR_INV_BUILTIN=1 -DHAVE___INT128=1 -DUSE_FIELD_5X52=1 -DUSE_SCALAR_4X64=1"
COMMON="-O2 -g0 -w ${SECP_DEFS} -I${OPENSSL_PREFIX}/include ${BOOST_FLAG} -I${SM}/secp256k1 -I${SM}/secp256k1/include -I${SM}/secp256k1/src"

JOBDIR="${NB}/jobs"
rm -rf "$JOBDIR"; mkdir -p "$JOBDIR"
N=0
job() { N=$((N + 1)); printf '%s\n' "$*" > "$(printf '%s/%03d.sh' "$JOBDIR" "$N")"; }
objname() { echo "${OBJ}/$(echo "${1#"${SRC}"/}" | tr '/' '_').o"; }
LIBOBJS=()
for f in "${SM}"/src/*.cpp "${SM}"/bitcoin/*.cpp "${SM}"/bitcoin/support/*.cpp "${SM}"/bitcoin/crypto/*.cpp \
         "${SM}"/secp256k1/src/cpp/GroupElement.cpp "${SM}"/secp256k1/src/cpp/MultiExponent.cpp "${SM}"/secp256k1/src/cpp/Scalar.cpp; do
    o="$(objname "$f")"; LIBOBJS+=("$o")
    job "${CXX} -std=c++17 ${COMMON} -c ${f} -o ${o}"
done
o="$(objname "${SM}/secp256k1/src/secp256k1.c")"; LIBOBJS+=("$o")
job "${CC} ${COMMON} -c ${SM}/secp256k1/src/secp256k1.c -o ${o}"
FLSOBJS=()
for f in "${FLS}"/src/flutter_libsparkmobile.cpp "${FLS}"/src/utils.cpp "${FLS}"/src/transaction.cpp; do
    o="$(objname "$f")"; FLSOBJS+=("$o")
    job "${CXX} -std=c++17 ${COMMON} -I${FLS}/src -c ${f} -o ${o}"
done
OURS="$(objname "${HERE}/src/spark_wasm.cpp")"
cp "${HERE}/src/spark_wasm.cpp" "${HERE}/src/codec.h" "${SRC}/"
OURS="${OBJ}/spark_wasm.o"
job "${CXX} -std=c++17 ${COMMON} -I${SM} -c ${SRC}/spark_wasm.cpp -o ${OURS}"
cp "${HERE}/native/vectors.cpp" "${HERE}/native/aead_diff.cpp" "${SRC}/"
job "${CXX} -std=c++17 ${COMMON} -I${SM} -I${FLS}/src -I${SRC} -c ${SRC}/vectors.cpp -o ${OBJ}/vectors.o"
# The shim, natively: its symbols are sparkshim_*, so it links next to real OpenSSL.
mkdir -p "${SRC}/shim"
cp -R "${HERE}/shim/." "${SRC}/shim/"
SHIMINC="-I${SRC}/shim/include -I${SM} -I${BTC}"
for f in "${BTC}/crypto/chacha20.cpp" "${BTC}/crypto/poly1305.cpp" "${BTC}/crypto/chacha20poly1305.cpp"; do
    job "${CXX} -std=c++20 -O2 -w -I${BTC} -c ${f} -o $(objname "$f")"
done
job "${CXX} -std=c++20 -O2 -w ${SHIMINC} -c ${SRC}/shim/openssl_shim.cpp -o ${OBJ}/openssl_shim.o"
job "${CXX} -std=c++17 -O2 -w -I${OPENSSL_PREFIX}/include -I${SRC} -c ${SRC}/aead_diff.cpp -o ${OBJ}/aead_diff.o"

log "compiling ${N} files with $(${CXX} --version | head -1) (${BOOST_NOTE})"
ls "$JOBDIR"/*.sh | xargs -P "$JOBS" -n 1 sh -c 'sh "$1" > "$1.log" 2>&1 || { echo "FAILED: $(cat "$1")"; cat "$1.log"; exit 255; }' _ \
    || die "compile failed"

LIBCRYPTO="${OPENSSL_PREFIX}/lib/libcrypto.dylib"
[[ -f "$LIBCRYPTO" ]] || LIBCRYPTO="${OPENSSL_PREFIX}/lib/libcrypto.so"
"${CXX}" -o "${BIN}/vectors" "${OBJ}/vectors.o" "${FLSOBJS[@]}" "$OURS" "${LIBOBJS[@]}" "$LIBCRYPTO" -Wl,-rpath,"${OPENSSL_PREFIX}/lib"
"${CXX}" -o "${BIN}/aead_diff" "${OBJ}/aead_diff.o" "${OBJ}/openssl_shim.o" "${OBJ}/sparkmobile_bitcoin_crypto_sha512.cpp.o" "${OBJ}/sparkmobile_bitcoin_support_cleanse.cpp.o" \
    "$(objname "${BTC}/crypto/chacha20.cpp")" "$(objname "${BTC}/crypto/poly1305.cpp")" "$(objname "${BTC}/crypto/chacha20poly1305.cpp")" \
    "$LIBCRYPTO" -Wl,-rpath,"${OPENSSL_PREFIX}/lib"
log "built ${BIN}/vectors and ${BIN}/aead_diff"

if [[ "${1:-}" == "--run" ]]; then
    "${BIN}/aead_diff"
    "${BIN}/vectors" "${PWA}/test/fixtures/firo_spark_vectors.json"
fi
