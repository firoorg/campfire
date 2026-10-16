// SPDX-License-Identifier: MIT
// Golden vectors for the Campfire PWA Spark module, produced by Campfire's OWN C ABI
// (cypherstack/flutter_libsparkmobile 3fdcb21 src/flutter_libsparkmobile.cpp over
// sparkmobile a9d0789) built natively with real OpenSSL 3.
//
// Every vector is also run through our C ABI (pwa/spark/src/spark_wasm.cpp) natively
// and must match byte for byte before anything is written; the Node test then runs the
// wasm build against the file (pwa/test/unit/firo_spark.test.mjs).
//
// Randomized operations (mints, spends, proofs) are made reproducible by replacing
// RAND_bytes, the library's only randomness source, with a fixed stream:
//   block i = SHA-256(SHA-256(label) || LE64(i)), bytes handed out in order.
// The Node test feeds crypto.getRandomValues the same stream, so the wasm must
// produce the very same bytes. (Only these tools do this; the shipped module always
// uses crypto.getRandomValues.)
//
// Usage: vectors <out.json>
#include "flutter_libsparkmobile.h"
#include "utils.h"
#include "deps/sparkmobile/include/spark.h"
#include "deps/sparkmobile/src/spend_transaction.h"
#include "deps/sparkmobile/bitcoin/hash.h"
#include "codec.h"

#include <openssl/crypto.h>
#include <openssl/rand.h>
#include <openssl/sha.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <functional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using campfire_spark::Reader;
using campfire_spark::Writer;
using Bytes = std::vector<unsigned char>;

// ---- our C ABI (natively) --------------------------------------------------------------------
extern "C" {
uint8_t* spark_full_view_key(const uint8_t*, uint32_t);
uint8_t* spark_get_address(const uint8_t*, uint32_t);
uint8_t* spark_address_from_fvk(const uint8_t*, uint32_t);
uint8_t* spark_validate_address(const uint8_t*, uint32_t);
uint8_t* spark_identify_coins(const uint8_t*, uint32_t);
uint8_t* spark_hash_tags(const uint8_t*, uint32_t);
uint8_t* spark_hash_tag(const uint8_t*, uint32_t);
uint8_t* spark_serialize_mint_context(const uint8_t*, uint32_t);
uint8_t* spark_mint_recipients(const uint8_t*, uint32_t);
uint8_t* spark_estimate_fee(const uint8_t*, uint32_t);
uint8_t* spark_create_spend(const uint8_t*, uint32_t);
uint8_t* spark_verify_spend(const uint8_t*, uint32_t);
uint8_t* spark_name_script(const uint8_t*, uint32_t);
uint8_t* spark_name_commitment(const uint8_t*, uint32_t);
uint8_t* spark_ownership_proof(const uint8_t*, uint32_t);
uint8_t* spark_verify_ownership_proof(const uint8_t*, uint32_t);
void spark_free(uint8_t*);
}

// ---- reproducible randomness -----------------------------------------------------------------
namespace rng {
bool seeded = false;
unsigned char seed[32];
uint64_t counter = 0;
unsigned char block[32];
int pos = 32;
uint64_t used = 0;
} // namespace rng

void SeedRng(const std::string& label)
{
    SHA256(reinterpret_cast<const unsigned char*>(label.data()), label.size(), rng::seed);
    rng::counter = 0;
    rng::pos = 32;
    rng::used = 0;
    rng::seeded = true;
}
void UnseedRng() { rng::seeded = false; }

extern "C" int RAND_bytes(unsigned char* buf, int num)
{
    if (num < 0) return 0;
    if (!rng::seeded) {
        arc4random_buf(buf, static_cast<size_t>(num));
        return 1;
    }
    for (int i = 0; i < num; i++) {
        if (rng::pos == 32) {
            unsigned char in[40];
            std::memcpy(in, rng::seed, 32);
            for (int b = 0; b < 8; b++) in[32 + b] = static_cast<unsigned char>(rng::counter >> (8 * b));
            SHA256(in, sizeof(in), rng::block);
            rng::counter++;
            rng::pos = 0;
        }
        buf[i] = rng::block[rng::pos++];
    }
    rng::used += static_cast<uint64_t>(num);
    return 1;
}

// ---- helpers ----------------------------------------------------------------------------------
[[noreturn]] void Fail(const std::string& what)
{
    std::fprintf(stderr, "vectors: %s\n", what.c_str());
    std::exit(1);
}

std::string Hex(const unsigned char* p, size_t n)
{
    static const char* d = "0123456789abcdef";
    std::string s;
    s.reserve(2 * n);
    for (size_t i = 0; i < n; i++) {
        s.push_back(d[p[i] >> 4]);
        s.push_back(d[p[i] & 15]);
    }
    return s;
}
std::string Hex(const Bytes& b) { return Hex(b.data(), b.size()); }
Bytes Unhex(const std::string& h)
{
    Bytes v;
    for (size_t i = 0; i + 1 < h.size(); i += 2) v.push_back(static_cast<unsigned char>(std::stoul(h.substr(i, 2), nullptr, 16)));
    return v;
}
Bytes Sha(const std::string& s)
{
    Bytes out(32);
    SHA256(reinterpret_cast<const unsigned char*>(s.data()), s.size(), out.data());
    return out;
}
Bytes Rev(Bytes b) { return Bytes(b.rbegin(), b.rend()); }

std::string Q(const std::string& s)
{
    std::string o = "\"";
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') { o.push_back('\\'); o.push_back(static_cast<char>(c)); }
        else if (c < 0x20 || c >= 0x7f) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o.push_back(static_cast<char>(c));
    }
    return o + "\"";
}
std::string Num(uint64_t v) { return Q(std::to_string(v)); }      // amounts as decimal strings
std::string Int(long long v) { return std::to_string(v); }           // small numbers as JSON numbers
std::string Bool(bool b) { return b ? "true" : "false"; }
std::string Obj(const std::vector<std::pair<std::string, std::string>>& kv)
{
    std::string o = "{";
    for (size_t i = 0; i < kv.size(); i++) o += (i ? ", " : "") + Q(kv[i].first) + ": " + kv[i].second;
    return o + "}";
}
std::string Arr(const std::vector<std::string>& items, bool multiline = false)
{
    std::string o = "[";
    for (size_t i = 0; i < items.size(); i++) o += (i ? (multiline ? ",\n    " : ", ") : (multiline ? "\n    " : "")) + items[i];
    return o + (multiline && !items.empty() ? "\n  ]" : "]");
}

struct Out {
    uint32_t status;
    Bytes data;
    std::string text() const { return std::string(data.begin(), data.end()); }
};
Out Call(uint8_t* (*fn)(const uint8_t*, uint32_t), Writer& w)
{
    std::vector<uint8_t>& req = w.buffer();
    uint8_t* r = fn(req.data(), static_cast<uint32_t>(req.size()));
    if (!r) Fail("our ABI returned null");
    Out o;
    o.status = uint32_t(r[0]) | uint32_t(r[1]) << 8 | uint32_t(r[2]) << 16 | uint32_t(r[3]) << 24;
    const uint32_t len = uint32_t(r[4]) | uint32_t(r[5]) << 8 | uint32_t(r[6]) << 16 | uint32_t(r[7]) << 24;
    o.data.assign(r + 8, r + 8 + len);
    spark_free(r);
    return o;
}
Out CallOk(uint8_t* (*fn)(const uint8_t*, uint32_t), Writer& w, const std::string& what)
{
    Out o = Call(fn, w);
    if (o.status != 0) Fail(what + ": our ABI failed: " + o.text());
    return o;
}
void Same(const std::string& a, const std::string& b, const std::string& what)
{
    if (a != b) Fail("MISMATCH " + what + "\n  campfire: " + a + "\n  ours:     " + b);
}

std::string CStr(const char* p, const std::string& what)
{
    if (!p) Fail(what + ": Campfire ABI returned null");
    std::string s(p);
    std::free(const_cast<char*>(p));
    return s;
}

// ---- inputs -------------------------------------------------------------------------------------
struct Key {
    std::string name;
    Bytes key;
    int index;
};

struct SetCoin { // an own coin as a wallet passes it to spend/fee calls
    Bytes coin;
    Bytes context;
    int groupId;
    int height;
};

Bytes CoinFromScript(const Bytes& script)
{
    if (script.size() < 2) Fail("short script");
    return Bytes(script.begin() + 1, script.end()); // OP_SPARKMINT / OP_SPARKSMINT, then the coin
}

void WriteCoins(Writer& w, const std::vector<SetCoin>& coins)
{
    w.u32(coins.size());
    for (const auto& c : coins) {
        w.bytes(c.coin);
        w.bytes(c.context);
        w.u32(static_cast<uint32_t>(c.groupId));
        w.i32(c.height);
    }
}

std::string CoinsJson(const std::vector<SetCoin>& coins)
{
    std::vector<std::string> items;
    for (const auto& c : coins)
        items.push_back(Obj({{"coin", Q(Hex(c.coin))}, {"context", Q(Hex(c.context))}, {"groupId", Int(c.groupId)}, {"height", Int(c.height)}}));
    return Arr(items);
}

// Campfire's DartSpendCoinData array (owns its storage via the vectors below).
struct CampfireCoins {
    std::vector<CCDataStream> coinStreams, ctxStreams;
    std::vector<DartSpendCoinData> items;
    explicit CampfireCoins(std::vector<SetCoin>& coins)
    {
        coinStreams.resize(coins.size());
        ctxStreams.resize(coins.size());
        items.resize(coins.size());
        for (size_t i = 0; i < coins.size(); i++) {
            coinStreams[i] = {coins[i].coin.data(), static_cast<int>(coins[i].coin.size())};
            ctxStreams[i] = {coins[i].context.data(), static_cast<int>(coins[i].context.size())};
            items[i] = {&coinStreams[i], &ctxStreams[i], coins[i].groupId, coins[i].height};
        }
    }
};

int main(int argc, char** argv)
{
    if (argc != 2) Fail("usage: vectors <out.json>");
    std::vector<std::pair<std::string, std::string>> doc;

    std::vector<Key> keys = {
        {"k1", Bytes(32), 1},
        {"k2", Sha("campfire pwa spark key 2"), 1},
        {"k3", Bytes(32, 0xff), 1},
        {"k1-index0", Bytes(32), 0},
        {"k1-index7", Bytes(32), 7},
    };
    for (int i = 0; i < 32; i++) keys[0].key[i] = keys[3].key[i] = keys[4].key[i] = static_cast<unsigned char>(i + 1);
    const Key& K1 = keys[0];
    const Key& K2 = keys[1];
    const Key& K3 = keys[2];

    // ---- keys and addresses -----------------------------------------------------------------------
    std::vector<std::string> keyItems;
    std::vector<std::string> fvkHex(keys.size());
    const std::vector<uint64_t> diversifiers = {0, 1, 2, 9999, 2147483647};
    for (size_t k = 0; k < keys.size(); k++) {
        Key& key = keys[k];
        void* fvk = getFullViewKeyFromPrivateKeyData(key.key.data(), key.index);
        int size = 0;
        unsigned char* ser = serializeFullViewKey(fvk, &size);
        fvkHex[k] = Hex(ser, size);
        delete[] ser;
        Writer w;
        w.raw(key.key.data(), 32);
        w.u32(key.index);
        Same(fvkHex[k], Hex(CallOk(spark_full_view_key, w, "fvk").data), "full view key " + key.name);

        std::vector<std::string> addrItems;
        for (uint64_t d : diversifiers) {
            std::string a[2];
            for (int test = 0; test < 2; test++) {
                a[test] = CStr(getAddress(key.key.data(), key.index, static_cast<int>(d), test), "getAddress");
                Same(a[test], CStr(getAddressFromFullViewKey(fvk, key.index, static_cast<int>(d), test), "fvk address"),
                     "address from fvk");
                Writer wa;
                wa.raw(key.key.data(), 32);
                wa.u32(key.index);
                wa.u64(d);
                wa.u8(test);
                Same(a[test], CallOk(spark_get_address, wa, "address").text(), "address " + key.name);
                Writer wf;
                wf.bytes(Unhex(fvkHex[k]));
                wf.u64(d);
                wf.u8(test);
                Same(a[test], CallOk(spark_address_from_fvk, wf, "fvk address").text(), "fvk address " + key.name);
            }
            addrItems.push_back(Obj({{"diversifier", Int(static_cast<long long>(d))}, {"main", Q(a[0])}, {"test", Q(a[1])}}));
        }
        deleteFullViewKey(fvk);
        keyItems.push_back(Obj({{"name", Q(key.name)}, {"privateKey", Q(Hex(key.key))}, {"index", Int(key.index)},
                                {"fullViewKey", Q(fvkHex[k])}, {"addresses", Arr(addrItems)}}));
    }
    doc.push_back({"keys", Arr(keyItems, true)});

    auto Address = [&](const Key& key, uint64_t d, bool test) {
        return CStr(getAddress(const_cast<unsigned char*>(key.key.data()), key.index, static_cast<int>(d), test), "getAddress");
    };
    const std::string K1main0 = Address(K1, 0, false);
    const std::string K1test0 = Address(K1, 0, true);

    // ---- validateAddress -------------------------------------------------------------------------------
    {
        std::string mutated = K1main0;
        mutated[mutated.size() - 3] = mutated[mutated.size() - 3] == 'q' ? 'p' : 'q';
        const std::vector<std::string> addrs = {K1main0, K1test0, mutated, "", "sm1", "aFA2TbqG9cnhhzX5Yny2pBJRK5EaEqLCH7",
                                                Address(K2, 9999, false)};
        std::vector<std::string> items;
        for (const auto& a : addrs) {
            for (int test = 0; test < 2; test++) {
                ValidateAddressResult* r = isValidSparkAddress(a.c_str(), test);
                const bool valid = r->isValid > 0;
                if (r->errorMessage) std::free(r->errorMessage);
                std::free(r);
                Writer w;
                w.str(a);
                w.u8(test);
                Out o = CallOk(spark_validate_address, w, "validate");
                Same(Bool(valid), Bool(o.data.at(0) == 1), "validate " + a);
                items.push_back(Obj({{"address", Q(a)}, {"isTestNet", Bool(test)}, {"valid", Bool(valid)}}));
            }
        }
        doc.push_back({"validateAddress", Arr(items, true)});
    }

    // ---- serializeMintContext ------------------------------------------------------------------------------
    // Wallet-facing txids are in display order; the C ABI takes internal order (Dart reverses).
    const std::vector<std::pair<std::string, uint32_t>> mintInputs = {
        {Hex(Sha("mint input 1")), 0}, {Hex(Sha("mint input 2")), 3}};
    Bytes mintContext;
    {
        std::vector<Bytes> internal;
        std::vector<DartInputData> in;
        for (const auto& [txid, vout] : mintInputs) internal.push_back(Rev(Unhex(txid)));
        for (size_t i = 0; i < mintInputs.size(); i++)
            in.push_back({internal[i].data(), 32, static_cast<int>(mintInputs[i].second)});
        SerializedMintContextResult* r = serializeMintContext(in.data(), in.size());
        mintContext.assign(r->context, r->context + r->contextLength);
        std::free(r->context);
        std::free(r);
        Writer w;
        w.u32(mintInputs.size());
        for (size_t i = 0; i < mintInputs.size(); i++) {
            w.raw(internal[i].data(), 32);
            w.u32(mintInputs[i].second);
        }
        Same(Hex(mintContext), Hex(CallOk(spark_serialize_mint_context, w, "mint context").data), "mint context");
        std::vector<std::string> ins;
        for (const auto& [txid, vout] : mintInputs) ins.push_back(Obj({{"txid", Q(txid)}, {"vout", Int(vout)}}));
        doc.push_back({"serializeMintContext", Arr({Obj({{"inputs", Arr(ins)}, {"context", Q(Hex(mintContext))}})})});
    }

    // ---- mints --------------------------------------------------------------------------------------------
    struct MintOut {
        std::string address;
        uint64_t value;
        std::string memo;
    };
    std::vector<std::string> mintItems;
    auto Mint = [&](const std::string& label, const std::vector<MintOut>& outs, const Bytes& context, bool generate) {
        std::vector<CMintedCoinData> c;
        for (const auto& o : outs) c.push_back({o.address.c_str(), o.value, o.memo.c_str()});
        SeedRng(label);
        CCRecipientList* list = cCreateSparkMintRecipients(c.data(), c.size(), const_cast<unsigned char*>(context.data()),
                                                           context.size(), generate);
        const uint64_t used = rng::used;
        UnseedRng();
        std::vector<Bytes> scripts;
        std::vector<std::string> recItems;
        Writer cmp;
        cmp.u32(list->length);
        for (int i = 0; i < list->length; i++) {
            Bytes s(list->list[i].pubKey, list->list[i].pubKey + list->list[i].pubKeyLength);
            scripts.push_back(s);
            recItems.push_back(Obj({{"scriptPubKey", Q(Hex(s))}, {"amount", Num(list->list[i].cAmount)},
                                    {"subtractFeeFromAmount", Bool(list->list[i].subtractFee > 0)}}));
            cmp.bytes(s);
            cmp.u64(list->list[i].cAmount);
            cmp.u8(list->list[i].subtractFee > 0);
            std::free(list->list[i].pubKey);
        }
        std::free(list->list);
        std::free(list);

        Writer w;
        w.u32(outs.size());
        for (const auto& o : outs) {
            w.str(o.address);
            w.u64(o.value);
            w.str(o.memo);
        }
        w.bytes(context);
        w.u8(generate);
        SeedRng(label);
        Out ours = CallOk(spark_mint_recipients, w, "mint");
        UnseedRng();
        Same(Hex(cmp.buffer()), Hex(ours.data), "mint " + label);

        std::vector<std::string> outItems;
        for (const auto& o : outs) outItems.push_back(Obj({{"address", Q(o.address)}, {"value", Num(o.value)}, {"memo", Q(o.memo)}}));
        mintItems.push_back(Obj({{"rngLabel", Q(label)}, {"rngBytes", Num(used)}, {"generate", Bool(generate)},
                                 {"outputs", Arr(outItems)}, {"serialContext", Q(Hex(context))}, {"recipients", Arr(recItems, true)}}));
        return scripts;
    };

    const std::vector<Bytes> mintA = Mint("mint-a",
        {{Address(K1, 1, false), 100000000, "hello"}, {Address(K1, 2, false), 12345, ""}, {Address(K2, 0, false), 50000000, "x"}},
        mintContext, true);
    Mint("mint-b", {{Address(K2, 3, false), 777, "not generated"}}, mintContext, false);
    const Bytes fillerContext = Unhex("01" + Hex(Sha("filler context")));
    std::vector<MintOut> fillerOuts;
    for (int i = 0; i < 6; i++) fillerOuts.push_back({Address(K3, i, false), static_cast<uint64_t>(1000 + i), ""});
    const std::vector<Bytes> fillers = Mint("fillers", fillerOuts, fillerContext, true);
    doc.push_back({"mints", Arr(mintItems, true)});

    // ---- identify ------------------------------------------------------------------------------------------
    std::vector<std::string> identifyItems;
    std::vector<std::string> tagItems;
    auto Identify = [&](size_t keyIndex, const Bytes& coin, const Bytes& context, bool test) {
        void* fvk = getFullViewKeyFromPrivateKeyData(keys[keyIndex].key.data(), keys[keyIndex].index);
        AggregateCoinData* r = idAndRecoverCoinByFullViewKey(coin.data(), coin.size(), fvk,
                                                             const_cast<unsigned char*>(context.data()), context.size(), test);
        std::string result = "null";
        Writer cmp;
        cmp.u32(r ? 1 : 0);
        cmp.u32(0);
        if (r) {
            // The tag itself (Campfire hands out only its hash) from sparkmobile directly.
            spark::Coin c = deserializeCoin(coin.data(), coin.size());
            c.setSerialContext(context);
            spark::FullViewKey* f = static_cast<spark::FullViewKey*>(fvk);
            spark::IncomingViewKey ivk(*f);
            spark::IdentifiedCoinData data = c.identify(ivk);
            spark::RecoveredCoinData rec = c.recover(*f, data);
            unsigned char tag[34];
            rec.T.serialize(tag);
            const std::string nonceHex(r->nonceHex, r->nonceHexLength);
            const std::string serialHex(reinterpret_cast<char*>(r->serial), r->serialLength);
            const std::string memo(r->memo);
            const Bytes encD(r->encryptedDiversifier, r->encryptedDiversifier + r->encryptedDiversifierLength);
            result = Obj({{"type", Int(r->type)}, {"diversifier", Num(r->diversifier)}, {"value", Num(r->value)},
                          {"address", Q(r->address)}, {"memo", Q(memo)}, {"lTagHash", Q(r->lTagHash)},
                          {"encryptedDiversifier", Q(Hex(encD))}, {"nonceHex", Q(nonceHex)}, {"serialHex", Q(serialHex)},
                          {"tag", Q(Hex(tag, 34))}});
            cmp.u32(0);
            cmp.u8(static_cast<uint8_t>(r->type));
            cmp.u64(r->diversifier);
            cmp.u64(r->value);
            cmp.str(r->address);
            cmp.str(memo);
            cmp.str(r->lTagHash);
            cmp.bytes(encD);
            cmp.str(nonceHex);
            cmp.str(serialHex);
            cmp.raw(tag, 34);

            // hashTag(x, y) as Campfire calls it for mempool tags "(x,y)", and hashTags(34-byte tags).
            const std::string gh = rec.T.GetHex();
            const size_t comma = gh.find(',');
            const std::string x = gh.substr(1, comma - 1), y = gh.substr(comma + 1, gh.size() - comma - 2);
            const std::string h1 = CStr(hashTag(x.c_str(), y.c_str()), "hashTag");
            const char* hs = hashTags(tag, 1);
            const std::string h2(hs, 64);
            std::free(const_cast<char*>(hs));
            Same(h1, r->lTagHash, "hashTag vs lTagHash");
            Same(h2, r->lTagHash, "hashTags vs lTagHash");
            Writer wt;
            wt.u32(1);
            wt.raw(tag, 34);
            Same(h2, CallOk(spark_hash_tags, wt, "hash tags").text(), "our hashTags");
            Writer wxy;
            wxy.str(x);
            wxy.str(y);
            Same(h1, CallOk(spark_hash_tag, wxy, "hash tag").text(), "our hashTag");
            tagItems.push_back(Obj({{"tag", Q(Hex(tag, 34))}, {"x", Q(x)}, {"y", Q(y)}, {"hash", Q(h1)}}));

            std::free(r->address);
            std::free(r->memo);
            std::free(r->lTagHash);
            std::free(r->encryptedDiversifier);
            std::free(r->nonceHex);
            std::free(r->serial);
            std::free(r);
        }
        deleteFullViewKey(fvk);
        Writer w;
        w.bytes(Unhex(fvkHex[keyIndex]));
        w.u8(test);
        w.u32(1);
        w.bytes(coin);
        w.bytes(context);
        Same(Hex(cmp.buffer()), Hex(CallOk(spark_identify_coins, w, "identify").data), "identify");
        identifyItems.push_back(Obj({{"key", Q(keys[keyIndex].name)}, {"fullViewKey", Q(fvkHex[keyIndex])}, {"coin", Q(Hex(coin))},
                                     {"context", Q(Hex(context))}, {"isTestNet", Bool(test)}, {"result", result}}));
    };
    for (const Bytes& s : mintA) {
        Identify(0, CoinFromScript(s), mintContext, false);
        Identify(1, CoinFromScript(s), mintContext, false);
    }
    Identify(0, CoinFromScript(mintA[0]), mintContext, true);    // the address comes back in testnet form
    Identify(0, CoinFromScript(mintA[0]), fillerContext, false); // wrong serial context: not recognised

    // ---- fee estimates ---------------------------------------------------------------------------------------
    std::vector<SetCoin> ownCoins = {{CoinFromScript(mintA[0]), mintContext, 1, 1000},
                                     {CoinFromScript(mintA[1]), mintContext, 1, 1001}};
    {
        struct FeeCase {
            int64_t amount;
            bool subtract;
            int priv, utxo, add, version;
        };
        const std::vector<FeeCase> cases = {{50000000, false, 1, 0, 0, 2}, {50000000, true, 1, 0, 0, 2}, {100000000, false, 1, 0, 0, 2},
                                            {50000000, false, 1, 2, 0, 1}, {20000000, false, 0, 1, 120, 2}, {200000000, false, 1, 0, 0, 2}};
        std::vector<std::string> items;
        CampfireCoins cc(ownCoins);
        for (const auto& c : cases) {
            SparkFeeResult* r = estimateSparkFee(const_cast<unsigned char*>(K1.key.data()), K1.index, c.amount, c.subtract,
                                                 cc.items.data(), cc.items.size(), c.priv, c.utxo, c.add, c.version);
            Writer w;
            w.raw(K1.key.data(), 32);
            w.u32(K1.index);
            w.i64(c.amount);
            w.u8(c.subtract);
            WriteCoins(w, ownCoins);
            w.u32(c.priv);
            w.u32(c.utxo);
            w.u32(c.add);
            w.u8(c.version);
            Out o = Call(spark_estimate_fee, w);
            std::string outcome;
            if (r->error) {
                if (o.status != 1) Fail("fee: Campfire failed, ours did not");
                Same(r->error, o.text(), "fee error");
                outcome = Q(r->error);
                std::free(r->error);
                items.push_back(Obj({{"sendAmount", Num(c.amount)}, {"subtractFeeFromAmount", Bool(c.subtract)},
                                     {"privateRecipientsCount", Int(c.priv)}, {"utxoNum", Int(c.utxo)}, {"additionalTxSize", Int(c.add)},
                                     {"spendVersion", Int(c.version)}, {"error", outcome}}));
            } else {
                if (o.status != 0) Fail("fee: ours failed: " + o.text());
                Reader rr(o.data.data(), o.data.size());
                Same(std::to_string(r->fee), std::to_string(rr.i64()), "fee");
                items.push_back(Obj({{"sendAmount", Num(c.amount)}, {"subtractFeeFromAmount", Bool(c.subtract)},
                                     {"privateRecipientsCount", Int(c.priv)}, {"utxoNum", Int(c.utxo)}, {"additionalTxSize", Int(c.add)},
                                     {"spendVersion", Int(c.version)}, {"fee", Num(r->fee)}}));
            }
            std::free(r);
        }
        doc.push_back({"estimateFee", Obj({{"key", Q(K1.name)}, {"coins", CoinsJson(ownCoins)}, {"cases", Arr(items, true)}})});
    }

    // ---- spends ------------------------------------------------------------------------------------------------
    std::vector<Bytes> setCoins;
    for (const Bytes& s : fillers) setCoins.push_back(CoinFromScript(s));
    setCoins.insert(setCoins.begin() + 2, CoinFromScript(mintA[0]));
    setCoins.push_back(CoinFromScript(mintA[2]));
    setCoins.push_back(CoinFromScript(mintA[1]));
    const Bytes setHash = Sha("set 1 hash");
    const Bytes blockHash = Sha("set 1 block");
    std::vector<std::string> spendItems;

    struct Transparent { int64_t amount; bool subtract; };
    struct Private { std::string address; uint64_t value; std::string memo; bool subtract; };
    auto Spend = [&](const std::string& label, const std::vector<Transparent>& tr, const std::vector<Private>& pr, int version,
                     const Bytes& txHashSig, const Bytes& extension) {
        // Campfire's ABI
        std::vector<CRecip> crec;
        for (const auto& t : tr) crec.push_back({static_cast<uint64_t>(t.amount), t.subtract});
        std::vector<COutputCoinData> cout(pr.size());
        std::vector<COutputRecipient> cpr(pr.size());
        for (size_t i = 0; i < pr.size(); i++) {
            cout[i] = {pr[i].address.c_str(), static_cast<int>(pr[i].address.size()), pr[i].value, pr[i].memo.c_str(),
                       static_cast<int>(pr[i].memo.size())};
            cpr[i] = {&cout[i], pr[i].subtract};
        }
        CampfireCoins cc(ownCoins);
        std::vector<CCDataStream> setStreams(setCoins.size());
        for (size_t i = 0; i < setCoins.size(); i++) setStreams[i] = {setCoins[i].data(), static_cast<int>(setCoins[i].size())};
        CCoverSetData cover = {setStreams.data(), static_cast<int>(setStreams.size()), setHash.data(), static_cast<int>(setHash.size()), 1};
        BlockHashAndId bh = {const_cast<unsigned char*>(blockHash.data()), 1};
        SeedRng(label);
        SparkSpendTransactionResult* r = cCreateSparkSpendTransaction(
            const_cast<unsigned char*>(K1.key.data()), K1.index, crec.data(), crec.size(), cpr.data(), cpr.size(),
            cc.items.data(), cc.items.size(), &cover, 1, &bh, 1, const_cast<unsigned char*>(txHashSig.data()), 0, version,
            extension.data());
        const uint64_t used = rng::used;
        UnseedRng();
        if (r->isError) Fail("spend " + label + ": " + std::string(reinterpret_cast<char*>(r->data), r->dataLength));
        Writer cmp;
        Bytes payload(r->data, r->data + r->dataLength);
        cmp.bytes(payload);
        cmp.u32(r->outputScriptsLength);
        std::vector<Bytes> scripts;
        for (int i = 0; i < r->outputScriptsLength; i++) {
            scripts.emplace_back(r->outputScripts[i].bytes, r->outputScripts[i].bytes + r->outputScripts[i].length);
            cmp.bytes(scripts.back());
        }
        cmp.i64(r->fee);
        cmp.u32(r->usedCoinsLength);
        std::vector<std::string> usedItems;
        for (int i = 0; i < r->usedCoinsLength; i++) {
            const UsedCoin& u = r->usedCoins[i];
            Bytes c(u.serializedCoin->data, u.serializedCoin->data + u.serializedCoin->length);
            Bytes x(u.serializedCoinContext->data, u.serializedCoinContext->data + u.serializedCoinContext->length);
            cmp.bytes(c);
            cmp.bytes(x);
            cmp.u32(static_cast<uint32_t>(u.groupId));
            cmp.i32(u.height);
            usedItems.push_back(Obj({{"coin", Q(Hex(c))}, {"context", Q(Hex(x))}, {"groupId", Int(u.groupId)}, {"height", Int(u.height)}}));
        }
        const int64_t fee = r->fee;

        // Ours, natively
        Writer w;
        w.raw(K1.key.data(), 32);
        w.u32(K1.index);
        w.u32(tr.size());
        for (const auto& t : tr) { w.i64(t.amount); w.u8(t.subtract); }
        w.u32(pr.size());
        for (const auto& p : pr) { w.str(p.address); w.u64(p.value); w.str(p.memo); w.u8(p.subtract); }
        WriteCoins(w, ownCoins);
        w.u32(1);
        w.u32(1);
        w.bytes(setHash);
        w.u32(setCoins.size());
        for (const auto& c : setCoins) w.bytes(c);
        w.u32(1);
        w.u32(1);
        w.raw(blockHash.data(), 32);
        w.raw(txHashSig.data(), 32);
        w.u32(0);
        w.u8(version);
        w.raw(extension.data(), 32);
        SeedRng(label);
        Out ours = CallOk(spark_create_spend, w, "spend");
        UnseedRng();
        Same(Hex(cmp.buffer()), Hex(ours.data), "spend " + label);

        // The proof verifies (our verify export, natively), and a flipped bit does not.
        uint64_t transparentOut = 0;
        for (const auto& t : tr) transparentOut += static_cast<uint64_t>(t.amount); // no fee subtraction in these cases
        auto verify = [&](const Bytes& p) {
            Writer v;
            v.u8(version);
            v.bytes(p);
            v.u32(scripts.size());
            for (const auto& s : scripts) v.bytes(s);
            v.u64(transparentOut);
            v.u32(1);
            v.u32(1);
            v.bytes(setHash);
            v.u32(setCoins.size());
            for (const auto& c : setCoins) v.bytes(c);
            v.raw(txHashSig.data(), 32);
            Out o = CallOk(spark_verify_spend, v, "verify");
            return o.data.at(0) == 1;
        };
        if (!verify(payload)) Fail("spend " + label + " does not verify");
        Bytes bad = payload;
        bad[bad.size() / 2] ^= 1;
        if (verify(bad)) Fail("spend " + label + ": a corrupted proof verifies");

        // Output coins: their serial context is the serialized vector of the spend's tags.
        spark::SpendTransaction parsed(spark::Params::get_default(), static_cast<spark::SpendTransactionVersion>(version), scripts.size());
        CDataStream ps(payload, SER_NETWORK, PROTOCOL_VERSION);
        ps >> parsed;
        CDataStream ctxStream(SER_NETWORK, PROTOCOL_VERSION);
        ctxStream << parsed.getUsedLTags();
        const Bytes outContext(ctxStream.begin(), ctxStream.end());

        std::vector<std::string> trItems, prItems, scriptItems;
        for (const auto& t : tr) trItems.push_back(Obj({{"amount", Num(t.amount)}, {"subtractFeeFromAmount", Bool(t.subtract)}}));
        for (const auto& p : pr)
            prItems.push_back(Obj({{"address", Q(p.address)}, {"amount", Num(p.value)}, {"memo", Q(p.memo)}, {"subtractFeeFromAmount", Bool(p.subtract)}}));
        for (const auto& s : scripts) scriptItems.push_back(Q(Hex(s)));
        std::vector<std::string> setItems;
        for (const auto& c : setCoins) setItems.push_back(Q(Hex(c)));
        spendItems.push_back(Obj({
            {"rngLabel", Q(label)}, {"rngBytes", Num(used)}, {"key", Q(K1.name)},
            {"recipients", Arr(trItems)}, {"privateRecipients", Arr(prItems)}, {"coins", CoinsJson(ownCoins)},
            {"anonymitySets", Arr({Obj({{"setId", "1"}, {"setHash", Q(Hex(setHash))}, {"coins", Arr(setItems, true)}})})},
            {"blockHashes", Arr({Obj({{"setId", "1"}, {"blockHash", Q(Hex(blockHash))}})})},
            {"txHashSig", Q(Hex(txHashSig))}, {"additionalTxSize", "0"}, {"spendVersion", Int(version)},
            {"extensionCommitment", Q(Hex(extension))},
            {"result", Obj({{"serializedSpendPayload", Q(Hex(payload))}, {"outputScripts", Arr(scriptItems, true)}, {"fee", Num(fee)},
                            {"usedCoins", Arr(usedItems, true)}})},
            {"transparentOut", Num(transparentOut)}, {"outputContext", Q(Hex(outContext))}, {"verifies", "true"}}));

        // Identify the outputs (spend-type coins): the recipient's and our change.
        for (const auto& s : scripts) {
            Identify(0, CoinFromScript(s), outContext, false);
            Identify(1, CoinFromScript(s), outContext, false);
        }
        for (int i = 0; i < r->outputScriptsLength; i++) std::free(r->outputScripts[i].bytes);
        std::free(r->outputScripts);
        for (int i = 0; i < r->usedCoinsLength; i++) {
            std::free(r->usedCoins[i].serializedCoin->data);
            std::free(r->usedCoins[i].serializedCoin);
            std::free(r->usedCoins[i].serializedCoinContext->data);
            std::free(r->usedCoins[i].serializedCoinContext);
        }
        std::free(r->usedCoins);
        std::free(r->data);
        std::free(r);
    };
    const Bytes zero32(32, 0);
    Spend("spend-v2-one-input", {{20000000, false}}, {{Address(K2, 5, false), 30000000, "vector memo", false}}, 2, Sha("tx 1"), zero32);
    Spend("spend-v2-two-inputs", {}, {{Address(K2, 6, false), 100000000, "two inputs", false}}, 2, Sha("tx 2"), zero32);
    Spend("spend-v2-extension", {{1000000, false}}, {}, 2, Sha("tx 3"), Sha("extension"));
    Spend("spend-v1", {{10000000, false}}, {}, 1, Sha("tx 4"), zero32);
    doc.push_back({"spends", Arr(spendItems, true)});
    doc.push_back({"identify", Arr(identifyItems, true)});
    doc.push_back({"hashTags", Arr(tagItems, true)});

    // ---- Spark names ------------------------------------------------------------------------------------------------
    {
        struct NameCase {
            std::string label;
            uint32_t validity;
            std::string name, info;
            Bytes digest; // as the C ABI takes it (Dart reverses the hex it is given)
            int version;
            uint32_t d;
            bool test;
            uint32_t failsafe;
            bool withoutProof;
        };
        const std::vector<NameCase> cases = {
            {"name-noproof", 210240, "campfire", "", Bytes(32, 0), 2, 0, false, 0, true},
            {"name-v2", 210240, "campfire", "https://firo.org", Sha("name digest"), 2, 0, false, 0, false},
            {"name-v2-test", 105120, "Pwa-1.test", "", Sha("name digest test"), 2, 3, true, 0, false},
            {"name-v1", 210240, "campfire", "", Sha("name digest v1"), 1, 0, false, 0, false},
        };
        std::vector<std::string> items;
        for (const auto& c : cases) {
            SeedRng(c.label);
            SparkNameScript* r = createSparkNameScript(c.validity, c.name.c_str(), c.info.c_str(), c.digest.data(), c.version,
                                                       const_cast<unsigned char*>(K1.key.data()), K1.index, c.d, c.test, c.failsafe,
                                                       c.withoutProof);
            const uint64_t used = rng::used;
            UnseedRng();
            Writer w;
            w.u32(c.validity);
            w.str(c.name);
            w.str(c.info);
            w.raw(c.digest.data(), 32);
            w.u8(c.version);
            w.raw(K1.key.data(), 32);
            w.u32(K1.index);
            w.u32(c.d);
            w.u8(c.test);
            w.u32(c.failsafe);
            w.u8(c.withoutProof);
            SeedRng(c.label);
            Out o = Call(spark_name_script, w);
            UnseedRng();
            std::vector<std::pair<std::string, std::string>> item = {
                {"rngLabel", Q(c.label)}, {"rngBytes", Num(used)}, {"validityBlocks", Int(c.validity)}, {"name", Q(c.name)},
                {"additionalInfo", Q(c.info)}, {"ownershipDigest", Q(Hex(c.digest))}, {"spendVersion", Int(c.version)},
                {"key", Q(K1.name)}, {"diversifier", Int(c.d)}, {"isTestNet", Bool(c.test)}, {"hashFailSafe", Int(c.failsafe)},
                {"withoutProof", Bool(c.withoutProof)}};
            if (r->error) {
                if (o.status != 1) Fail("name " + c.label + ": Campfire failed, ours did not");
                Same(r->error, o.text(), "name error");
                item.push_back({"error", Q(r->error)});
                std::free(r->error);
            } else {
                const Bytes script(r->script, r->script + r->scriptLength);
                Writer cmp;
                cmp.bytes(script);
                cmp.u32(r->size);
                if (o.status != 0) Fail("name " + c.label + ": ours failed: " + o.text());
                Same(Hex(cmp.buffer()), Hex(o.data), "name " + c.label);
                item.push_back({"script", Q(Hex(script))});
                item.push_back({"size", Int(r->size)});
                if (c.withoutProof) {
                    SparkNameCommitmentResult* cm = cGetSparkNameCommitment(script.data(), script.size());
                    if (cm->error) Fail(std::string("commitment: ") + cm->error);
                    const Bytes commitment(cm->commitment, cm->commitment + cm->commitmentLength);
                    Writer wc;
                    wc.bytes(script);
                    Same(Hex(commitment), Hex(CallOk(spark_name_commitment, wc, "commitment").data), "name commitment");
                    item.push_back({"commitment", Q(Hex(commitment))});
                    std::free(cm->commitment);
                    std::free(cm);
                }
                std::free(r->script);
            }
            std::free(r);
            items.push_back(Obj(item));
        }
        doc.push_back({"sparkNames", Arr(items, true)});
    }

    // ---- address ownership proofs ------------------------------------------------------------------------------------
    {
        std::vector<std::string> items;
        const std::vector<std::pair<std::string, uint32_t>> cases = {{"Campfire PWA ownership vector", 0}, {"", 7}};
        int n = 0;
        for (const auto& [message, d] : cases) {
            const std::string label = "ownership-" + std::to_string(n++);
            SeedRng(label);
            SparkAddressOwnershipProofResult* r = createSparkAddressOwnershipProof(
                reinterpret_cast<const unsigned char*>(message.data()), message.size(), const_cast<unsigned char*>(K1.key.data()),
                K1.index, d);
            const uint64_t used = rng::used;
            UnseedRng();
            if (r->error) Fail(std::string("ownership: ") + r->error);
            const Bytes proof(r->proof, r->proof + r->proofLength);
            std::free(r->proof);
            std::free(r);
            Writer w;
            w.bytes(Bytes(message.begin(), message.end()));
            w.raw(K1.key.data(), 32);
            w.u32(K1.index);
            w.u32(d);
            SeedRng(label);
            Same(Hex(proof), Hex(CallOk(spark_ownership_proof, w, "ownership").data), "ownership proof");
            UnseedRng();
            const std::string address = Address(K1, d, false);
            const std::string other = message + "!";
            const bool ok = verifySparkAddressOwnershipProof(reinterpret_cast<const unsigned char*>(message.data()), message.size(),
                                                             address.c_str(), proof.data(), proof.size(), 0) == 1;
            const bool okWrong = verifySparkAddressOwnershipProof(reinterpret_cast<const unsigned char*>(other.data()), other.size(),
                                                                  address.c_str(), proof.data(), proof.size(), 0) == 1;
            const bool okTest = verifySparkAddressOwnershipProof(reinterpret_cast<const unsigned char*>(message.data()), message.size(),
                                                                 address.c_str(), proof.data(), proof.size(), 1) == 1;
            if (!ok || okWrong || okTest) Fail("ownership verification outcomes");
            for (const auto& [msg, test, want] : std::vector<std::tuple<std::string, int, bool>>{{message, 0, true}, {other, 0, false}, {message, 1, false}}) {
                Writer v;
                v.bytes(Bytes(msg.begin(), msg.end()));
                v.str(address);
                v.bytes(proof);
                v.u8(test);
                Same(Bool(want), Bool(CallOk(spark_verify_ownership_proof, v, "verify ownership").data.at(0) == 1), "verify ownership");
            }
            items.push_back(Obj({{"rngLabel", Q(label)}, {"rngBytes", Num(used)}, {"message", Q(message)}, {"key", Q(K1.name)},
                                 {"diversifier", Int(d)}, {"address", Q(address)}, {"proof", Q(Hex(proof))},
                                 {"verifies", "true"}, {"verifiesOtherMessage", "false"}, {"verifiesOnTestnet", "false"}}));
        }
        doc.push_back({"ownershipProofs", Arr(items, true)});
    }

    // ---- write ---------------------------------------------------------------------------------------------------------
    std::string gen = Obj({{"by", Q("pwa/spark/native/vectors.cpp")},
                           {"abi", Q("cypherstack/flutter_libsparkmobile 3fdcb21160a39c051a0e73d7ae04f987134ecd5f src/flutter_libsparkmobile.cpp")},
                           {"sparkmobile", Q("firoorg/sparkmobile a9d078955312b3467f5bb14cbd64ab2ed8852256")},
                           {"openssl", Q(OpenSSL_version(OPENSSL_VERSION))},
                           {"compiler", Q(__VERSION__)},
                           {"rng", Q("block i = SHA-256(SHA-256(utf8(rngLabel)) || LE64(i)); RAND_bytes takes bytes in order; rngBytes = bytes taken")},
                           {"crossChecked", Q("every vector also produced by pwa/spark/src/spark_wasm.cpp natively, byte for byte")}});
    std::ostringstream os;
    os << "{\n  \"about\": " << Q("Golden vectors for the Campfire PWA Spark wasm module (see generator). Amounts are decimal strings; bytes are hex.")
       << ",\n  \"generator\": " << gen;
    for (const auto& [k, v] : doc) os << ",\n  " << Q(k) << ": " << v;
    os << "\n}\n";
    std::ofstream f(argv[1]);
    f << os.str();
    if (!f) Fail("cannot write " + std::string(argv[1]));
    std::printf("vectors: wrote %s (%zu bytes): %zu keys, %zu identify, %zu spends, all cross-checked\n", argv[1], os.str().size(),
                keys.size(), identifyItems.size(), spendItems.size());
    return 0;
}
