# Sourced by pwa/spark/build.sh (wasm) and pwa/spark/native/build_native.sh (golden vectors):
# fetches the pinned upstream sources and refuses anything that differs from spark.lock.json.
# Expects: HERE (pwa/spark), DEPS (download/cache dir), die(), log().
# Provides: lock <dotted.key>, sha256_of <file>, fetch <url> <dest> <sha256>,
#           prepare_sources <dir>  ->  <dir>/sparkmobile, <dir>/bitcoin-core/src/...

LOCK="${HERE}/spark.lock.json"
command -v node > /dev/null || die "node is needed to read ${LOCK}"

sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }

lock() {
    node -e '
        const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        let v = l;
        for (const k of process.argv[2].split(".")) v = v?.[k];
        if (v === undefined) process.exit(3);
        process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
    ' "$LOCK" "$1"
}

fetch() { # url dest sha256
    local url="$1" dest="$2" want="$3"
    if [[ ! -f "$dest" ]]; then
        log "downloading ${url}"
        mkdir -p "$(dirname "$dest")"
        curl -sSfL --retry 3 -o "${dest}.part" "$url" || die "download failed: ${url}"
        mv "${dest}.part" "$dest"
    fi
    local got
    got="$(sha256_of "$dest")"
    [[ "$got" == "$want" ]] || die "REFUSED $(basename "$dest"): sha256 ${got} != pinned ${want}"
}

prepare_sources() { # dir
    local dir="$1" sm_commit sm_tree sm_sha sm_url btc_commit tgz tree f want n=0
    sm_commit="$(lock sources.sparkmobile.commit)"
    sm_tree="$(lock sources.sparkmobile.git_tree)"
    sm_sha="$(lock sources.sparkmobile.tarball_sha256)"
    sm_url="$(lock sources.sparkmobile.tarball_url)"
    btc_commit="$(lock sources.bitcoin_core.commit)"

    tgz="${DEPS}/dl/sparkmobile-${sm_commit}.tar.gz"
    fetch "$sm_url" "$tgz" "$sm_sha"
    rm -rf "${dir}/sparkmobile" "${dir}/bitcoin-core"
    mkdir -p "${dir}/sparkmobile" "${dir}/bitcoin-core"
    tar xzf "$tgz" -C "${dir}/sparkmobile" --strip-components=1

    # The unpacked files must be exactly the pinned commit's tree (GitHub may
    # regenerate tarballs; the tree id is what the commit actually contains).
    tree="$(cd "${dir}/sparkmobile" && export GIT_DIR="${dir}/.treecheck.git" GIT_WORK_TREE=. \
            && git init -q && git add -A -f && git write-tree)"
    rm -rf "${dir}/.treecheck.git"
    [[ "$tree" == "$sm_tree" ]] || die "REFUSED sparkmobile: git tree ${tree} != pinned ${sm_tree}"
    log "sparkmobile ${sm_commit:0:10}: tarball sha256 and git tree ${tree:0:10} verified"

    for f in $(lock sources.bitcoin_core.files | node -e 'process.stdout.write(Object.keys(JSON.parse(require("fs").readFileSync(0, "utf8"))).join("\n"))'); do
        want="$(node -e 'const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(l.sources.bitcoin_core.files[process.argv[2]])' "$LOCK" "$f")"
        fetch "https://raw.githubusercontent.com/bitcoin/bitcoin/${btc_commit}/${f}" "${DEPS}/dl/bitcoin-core-${btc_commit:0:12}/${f}" "$want"
        mkdir -p "$(dirname "${dir}/bitcoin-core/${f}")"
        cp "${DEPS}/dl/bitcoin-core-${btc_commit:0:12}/${f}" "${dir}/bitcoin-core/${f}"
        n=$((n + 1))
    done
    log "Bitcoin Core ${btc_commit:0:10}: ${n} files verified"
}
