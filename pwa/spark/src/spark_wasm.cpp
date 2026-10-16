// SPDX-License-Identifier: MIT
// Campfire PWA: the C ABI of the Spark WebAssembly module.
//
// The same operations, with the same semantics, as the C ABI that Campfire calls
// through Dart FFI: cypherstack/flutter_libsparkmobile @ 3fdcb21 src/flutter_libsparkmobile.cpp
// (MIT, Cypher Stack), over Firo's sparkmobile @ a9d0789 (MIT). Only the
// marshalling differs: instead of C structs and pointers, every export takes one
// request buffer and returns one result buffer (codec.h), so JS never has to
// mirror C struct layouts and anonymity sets travel as bytes, never JSON.
// The Emscripten build of sparkmobile by Gevorg Voskanyan for Enkrypt
// (gevorgvoskanyan/sparkmobile_enkrypt, MIT) showed this code needs no changes
// to run in wasm; no code was taken from it.
//
// Result buffer (malloc'd; JS reads it and frees it with spark_free):
//   u32 status   0 = ok, 1 = error
//   u32 length
//   bytes        ok: the payload listed per export below; error: UTF-8 message
//
// Exports and their request -> payload (codec.h field types):
//   spark_full_view_key      fixed32 key, u32 index                         -> raw serialized FullViewKey
//   spark_get_address        fixed32 key, u32 index, u64 d, u8 testnet      -> raw address (ASCII)
//   spark_address_from_fvk   bytes fvk, u64 d, u8 testnet                   -> raw address
//   spark_validate_address   str address, u8 testnet                        -> u8 valid, str error
//   spark_identify_coins     bytes fvk, u8 testnet, u32 n, n*(bytes coin, bytes context)
//                                                                           -> u32 found, u32 unreadable, found*(u32 index, COIN)
//       COIN = u8 type, u64 diversifier, u64 value, str address, bytes memo, str lTagHash,
//              bytes encryptedDiversifier, str nonceHex, str serialHex, fixed34 tag
//   spark_hash_tags          u32 n, n*fixed34 tag                           -> n*64 ASCII hex (uint256::GetHex)
//   spark_hash_tag           str x, str y (hex)                             -> raw ASCII hex
//   spark_serialize_mint_context  u32 n, n*(fixed32 txid internal order, u32 vout) -> raw bytes
//   spark_mint_recipients    u32 n, n*(str address, u64 value, bytes memo), bytes serialContext, u8 generate
//                                                                           -> u32 n, n*(bytes script, u64 amount, u8 subtractFee)
//   spark_estimate_fee       fixed32 key, u32 index, i64 amount, u8 subtractFee, COINS,
//                            u32 privateRecipients, u32 utxoNum, u32 additionalTxSize, u8 version -> i64 fee
//       COINS = u32 n, n*(bytes coin, bytes context, u32 groupId, i32 height)
//   spark_create_spend       fixed32 key, u32 index,
//                            u32 n, n*(i64 amount, u8 subtractFee),                       transparent recipients
//                            u32 n, n*(str address, u64 value, bytes memo, u8 subtractFee), Spark recipients
//                            COINS, SETS,
//                            u32 n, n*(u32 setId, fixed32 blockHash),
//                            fixed32 txHashSig, u32 additionalTxSize, u8 version, fixed32 extensionCommitment
//                                                                           -> bytes spend, u32 n, n*bytes script, i64 fee, USED
//       SETS = u32 n, n*(u32 setId, bytes setHash, u32 m, m*bytes coin)
//       USED = u32 n, n*(bytes coin, bytes context, u32 groupId, i32 height)
//   spark_verify_spend       u8 version, bytes spend, u32 n, n*bytes script, u64 transparentOut,
//                            SETS, fixed32 txHashSig                        -> u8 valid, str reason
//   spark_name_script        u32 validityBlocks, str name, str info, fixed32 ownershipDigest, u8 version,
//                            fixed32 key, u32 index, u32 d, u8 testnet, u32 hashFailSafe, u8 withoutProof
//                                                                           -> bytes script, u32 size
//   spark_name_commitment    bytes serializedNameData                       -> fixed32 commitment
//   spark_ownership_proof    bytes message, fixed32 key, u32 index, u32 d   -> raw proof
//   spark_verify_ownership_proof  bytes message, str address, bytes proof, u8 testnet -> u8 valid
//   spark_build_info         (empty)                                         -> raw ASCII
//
// Key material arrives in request buffers that the JS side zeroes after the call;
// here it lives in SpendKeyData (cleansed by its destructor) and sparkmobile's key
// objects for the duration of one call.

#include "codec.h"

#include "include/spark.h"
#include "src/sparkname.h"
#include "src/spend_transaction.h"
#include "bitcoin/hash.h"
#include "bitcoin/serialize.h"
#include "bitcoin/streams.h"
#include "bitcoin/uint256.h"

#include <cstdlib>
#include <cstring>
#include <limits>
#include <list>
#include <map>
#include <string>
#include <unordered_map>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define SPARK_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define SPARK_EXPORT extern "C" __attribute__((visibility("default")))
#endif

#ifndef CAMPFIRE_SPARK_BUILD_INFO
#define CAMPFIRE_SPARK_BUILD_INFO "sparkmobile a9d078955312b3467f5bb14cbd64ab2ed8852256"
#endif

using namespace campfire_spark;

namespace {

const uint32_t kStatusOk = 0;
const uint32_t kStatusError = 1;
const size_t kTagSize = 34;   // serialized GroupElement
const size_t kHashSize = 32;

uint8_t* MakeResult(uint32_t status, const uint8_t* data, size_t len)
{
    if (len > 0xffffffffu - 8) return nullptr;
    uint8_t* out = static_cast<uint8_t*>(std::malloc(8 + len));
    if (!out) return nullptr;
    for (int i = 0; i < 4; i++) out[i] = uint8_t(status >> (8 * i));
    for (int i = 0; i < 4; i++) out[4 + i] = uint8_t(uint32_t(len) >> (8 * i));
    if (len) std::memcpy(out + 8, data, len);
    return out;
}

uint8_t* Error(const char* message)
{
    return MakeResult(kStatusError, reinterpret_cast<const uint8_t*>(message), std::strlen(message));
}

template <typename F>
uint8_t* Run(const uint8_t* req, uint32_t len, F body)
{
    try {
        if (!req && len) return Error("request: null buffer");
        Reader r(req, len);
        Writer w;
        body(r, w);
        r.end();
        std::vector<uint8_t>& b = w.buffer();
        return MakeResult(kStatusOk, b.data(), b.size());
    } catch (const std::bad_alloc&) {
        return Error("out of memory");
    } catch (const std::exception& e) {
        return Error(e.what()[0] ? e.what() : "error");
    } catch (...) {
        return Error("unknown error");
    }
}

int32_t ReadIndex(Reader& r)
{
    const uint32_t index = r.u32();
    if (index > uint32_t(std::numeric_limits<int32_t>::max()))
        throw std::invalid_argument("Spark key index out of range");
    return static_cast<int32_t>(index);
}

spark::SpendKey ReadSpendKey(Reader& r)
{
    const Reader::View key = r.fixed(32);
    const int32_t index = ReadIndex(r);
    SpendKeyData data(key.data, index); // cleansed when it goes out of scope
    return createSpendKey(data);
}

unsigned char Network(bool testnet)
{
    return testnet ? spark::ADDRESS_NETWORK_TESTNET : spark::ADDRESS_NETWORK_MAINNET;
}

spark::FullViewKey LoadFullViewKey(const Reader::View& v)
{
    // As flutter_libsparkmobile deserializeFullViewKey: exact size, then decode.
    spark::FullViewKey fvk(spark::Params::get_default());
    const size_t expected = GetSerializeSize(fvk, SER_NETWORK, PROTOCOL_VERSION);
    if (v.size != expected) throw std::invalid_argument("full view key: wrong length");
    CDataStream s(v.vec(), SER_NETWORK, PROTOCOL_VERSION);
    s >> fvk;
    return fvk;
}

spark::Coin ReadCoinBytes(const Reader::View& v)
{
    // As flutter_libsparkmobile deserializeCoin: bytes after the coin are ignored
    // (the ElectrumX set entry carries the tx hash and context after it).
    CDataStream stream(v.vec(), SER_NETWORK, PROTOCOL_VERSION);
    spark::Coin coin(spark::Params::get_default());
    stream >> coin;
    return coin;
}

uint256 ReadHash(Reader& r)
{
    return uint256(r.fixed(kHashSize).vec());
}

spark::SpendTransactionVersion ReadVersion(Reader& r)
{
    const uint8_t v = r.u8();
    if (v != uint8_t(spark::SpendTransactionVersion::V1) && v != uint8_t(spark::SpendTransactionVersion::V2))
        throw std::invalid_argument("Unsupported Spark spend version");
    return static_cast<spark::SpendTransactionVersion>(v);
}

struct WalletCoin {
    spark::Coin coin;
    int32_t groupId;
    int32_t height;
};

// COINS: own coins with their serial context (flutter_libsparkmobile DartSpendCoinData)
std::list<CSparkMintMeta> ReadOwnCoins(Reader& r, const spark::IncomingViewKey& ivk)
{
    std::list<CSparkMintMeta> coins;
    const uint32_t n = r.count(4 + 4 + 4 + 4);
    for (uint32_t i = 0; i < n; i++) {
        spark::Coin coin = ReadCoinBytes(r.bytes());
        coin.setSerialContext(r.bytes().vec());
        const int32_t groupId = static_cast<int32_t>(r.u32());
        const int32_t height = r.i32();
        CSparkMintMeta meta = getMetadata(coin, ivk);
        meta.nId = groupId;
        meta.nHeight = height;
        meta.coin = coin;
        coins.push_back(meta);
    }
    return coins;
}

// SETS: anonymity sets. Coins are decoded straight from the request bytes.
std::unordered_map<uint64_t, spark::CoverSetData> ReadSets(Reader& r)
{
    std::unordered_map<uint64_t, spark::CoverSetData> sets;
    const uint32_t n = r.count(4 + 4 + 4);
    for (uint32_t i = 0; i < n; i++) {
        const uint32_t setId = r.u32();
        spark::CoverSetData data;
        data.cover_set_representation = r.bytes().vec();
        const uint32_t m = r.count(4);
        data.cover_set.reserve(m);
        for (uint32_t j = 0; j < m; j++) data.cover_set.push_back(ReadCoinBytes(r.bytes()));
        if (!sets.emplace(setId, std::move(data)).second)
            throw std::invalid_argument("anonymity set listed twice");
    }
    return sets;
}

void WriteUsedCoin(Writer& w, const CSparkMintMeta& meta)
{
    CDataStream coinStream(SER_NETWORK, PROTOCOL_VERSION);
    coinStream << meta.coin;
    w.bytes(coinStream.data(), coinStream.size());
    w.bytes(meta.serial_context);
    w.u32(static_cast<uint32_t>(meta.nId));
    w.i32(meta.nHeight);
}

} // namespace

SPARK_EXPORT uint8_t* spark_alloc(uint32_t size)
{
    return static_cast<uint8_t*>(std::malloc(size ? size : 1));
}

SPARK_EXPORT void spark_free(uint8_t* ptr)
{
    std::free(ptr);
}

SPARK_EXPORT uint8_t* spark_full_view_key(const uint8_t* req, uint32_t len)
{
    return Run(req, len, [](Reader& r, Writer& w) {
        spark::SpendKey spendKey = ReadSpendKey(r);
        spark::FullViewKey fullViewKey(spendKey);
        CDataStream s(SER_NETWORK, PROTOCOL_VERSION);
        s << fullViewKey;
        w.raw(s.data(), s.size());
    });
}

SPARK_EXPORT uint8_t* spark_get_address(const uint8_t* req, uint32_t len)
{
    return Run(req, len, [](Reader& r, Writer& w) {
        spark::SpendKey spendKey = ReadSpendKey(r);
        const uint64_t d = r.u64();
        const bool testnet = r.flag();
        spark::FullViewKey fullViewKey(spendKey);
        spark::IncomingViewKey incomingViewKey(fullViewKey);
        const std::string address = spark::Address(incomingViewKey, d).encode(Network(testnet));
        w.raw(address.data(), address.size());
    });
}

SPARK_EXPORT uint8_t* spark_address_from_fvk(const uint8_t* req, uint32_t len)
{
    return Run(req, len, [](Reader& r, Writer& w) {
        spark::FullViewKey fullViewKey = LoadFullViewKey(r.bytes());
        const uint64_t d = r.u64();
        const bool testnet = r.flag();
        spark::IncomingViewKey incomingViewKey(fullViewKey);
        const std::string address = spark::Address(incomingViewKey, d).encode(Network(testnet));
        w.raw(address.data(), address.size());
    });
}

SPARK_EXPORT uint8_t* spark_validate_address(const uint8_t* req, uint32_t len)
{
    return Run(req, len, [](Reader& r, Writer& w) {
        const std::string text = r.str();
        const bool testnet = r.flag();
        // As flutter_libsparkmobile isValidSparkAddress (it reads a C string, so
        // nothing after a NUL byte counts; here a NUL makes the address invalid).
        bool valid = false;
        std::string error;
        if (text.find('\0') != std::string::npos) {
            error = "address contains a NUL byte";
        } else {
            try {
                spark::Address address;
                valid = address.decode(text) == Network(testnet);
            } catch (const std::exception& e) {
                error = e.what();
            }
        }
        w.u8(valid ? 1 : 0);
        w.str(error);
    });
}

SPARK_EXPORT uint8_t* spark_identify_coins(const uint8_t* req, uint32_t len)
{
    return Run(req, len, [](Reader& r, Writer& w) {
        const spark::FullViewKey fullViewKey = LoadFullViewKey(r.bytes());
        const bool testnet = r.flag();
        const spark::IncomingViewKey incomingViewKey(fullViewKey);
        const unsigned char network = Network(testnet);
        const uint32_t n = r.count(8);

        Writer found;
        uint32_t foundCount = 0;
        uint32_t unreadable = 0;
        for (uint32_t i = 0; i < n; i++) {
            const Reader::View coinBytes = r.bytes();
            const Reader::View context = r.bytes();
            spark::Coin coin(spark::Params::get_default());
            try {
                coin = ReadCoinBytes(coinBytes);
            } catch (const std::exception&) {
                unreadable++;
                continue;
            }
            coin.setSerialContext(context.vec());
            // As idAndRecoverCoinByFullViewKey: identify, then recover; any failure
            // means "not ours" (a coin for someone else fails in identify).
            spark::IdentifiedCoinData data;
            spark::RecoveredCoinData recovered;
            try {
                data = coin.identify(incomingViewKey);
                recovered = coin.recover(fullViewKey, data);
            } catch (const std::exception&) {
                continue;
            }
            const std::string address = getAddress(incomingViewKey, data.i).encode(network);
            unsigned char tag[kTagSize];
            recovered.T.serialize(tag);

            found.u32(i);
            found.u8(static_cast<uint8_t>(coin.type));
            found.u64(data.i);
            found.u64(data.v);
            found.str(address);
            found.str(data.memo);
            found.str(primitives::GetLTagHash(recovered.T).GetHex());
            found.bytes(data.d);
            found.str(data.k.GetHex());
            found.str(recovered.s.GetHex());
            found.raw(tag, kTagSize);
            foundCount++;
        }
        w.u32(foundCount);
        w.u32(unreadable);
        w.raw(found.buffer().data(), found.buffer().size());
    });
}

SPARK_EXPORT uint8_t* spark_hash_tags(const uint8_t* req, uint32_t len)
{
    return Run(req, len, [](Reader& r, Writer& w) {
        const uint32_t n = r.count(kTagSize);
        for (uint32_t i = 0; i < n; i++) {
            const Reader::View t = r.fixed(kTagSize);
            secp_primitives::GroupElement tag;
            tag.deserialize(t.data);
            const std::string hex = primitives::GetLTagHash(tag).GetHex();
            if (hex.size() != 64) throw std::runtime_error("tag hash: unexpected length");
            w.raw(hex.data(), hex.size());
        }
    });
}

SPARK_EXPORT uint8_t* spark_hash_tag(const uint8_t* req, uint32_t len)
{
    return Run(req, len, [](Reader& r, Writer& w) {
        const std::string x = r.str();
        const std::string y = r.str();
        if (x.empty() || y.empty() || x.find('\0') != std::string::npos || y.find('\0') != std::string::npos)
            throw std::invalid_argument("tag coordinates must be non-empty hex");
        secp_primitives::GroupElement tag(x.c_str(), y.c_str(), 16);
        const std::string hex = primitives::GetLTagHash(tag).GetHex();
        w.raw(hex.data(), hex.size());
    });
}

SPARK_EXPORT uint8_t* spark_serialize_mint_context(const uint8_t* req, uint32_t len)
{
    return Run(req, len, [](Reader& r, Writer& w) {
        // flutter_libsparkmobile serializeMintContext streams
        // CTxIn(uint256(txHash), vout, CScript(), 0xfffffffe) per input:
        // prevout.hash (32), prevout.n (LE32), empty scriptSig (compact size 0), nSequence (LE32).
        const uint32_t n = r.count(kHashSize + 4);
        CDataStream s(SER_NETWORK, PROTOCOL_VERSION);
        for (uint32_t i = 0; i < n; i++) {
            const uint256 hash = ReadHash(r);
            const uint32_t vout = r.u32();
            s << hash;
            s << vout;
            WriteCompactSize(s, 0);
            s << uint32_t(std::numeric_limits<unsigned int>::max() - 1);
        }
        w.raw(s.data(), s.size());
    });
}

SPARK_EXPORT uint8_t* spark_mint_recipients(const uint8_t* req, uint32_t len)
{
    return Run(req, len, [](Reader& r, Writer& w) {
        std::vector<spark::MintedCoinData> outputs;
        const uint32_t n = r.count(4 + 8 + 4);
        for (uint32_t i = 0; i < n; i++) {
            spark::MintedCoinData data;
            const std::string address = r.str();
            data.address.decode(address); // flutter_libsparkmobile decodeAddress: network not checked here
            data.v = r.u64();
            data.memo = r.str();
            outputs.push_back(data);
        }
        const std::vector<unsigned char> serialContext = r.bytes().vec();
        const bool generate = r.flag();
        const std::vector<CRecipient> recipients = createSparkMintRecipients(outputs, serialContext, generate);
        w.u32(static_cast<uint32_t>(recipients.size()));
        for (const CRecipient& rec : recipients) {
            w.bytes(std::vector<unsigned char>(rec.pubKey.begin(), rec.pubKey.end())); // CScript (prevector) has no data()
            w.u64(static_cast<uint64_t>(rec.amount));
            w.u8(rec.subtractFeeFromAmount ? 1 : 0);
        }
    });
}

SPARK_EXPORT uint8_t* spark_estimate_fee(const uint8_t* req, uint32_t len)
{
    return Run(req, len, [](Reader& r, Writer& w) {
        spark::SpendKey spendKey = ReadSpendKey(r);
        spark::FullViewKey fullViewKey(spendKey);
        spark::IncomingViewKey incomingViewKey(fullViewKey);
        const int64_t sendAmount = r.i64();
        const bool subtractFee = r.flag();
        std::list<CSparkMintMeta> coins = ReadOwnCoins(r, incomingViewKey);
        const uint32_t privateRecipients = r.u32();
        const uint32_t utxoNum = r.u32();
        const uint32_t additionalTxSize = r.u32();
        const spark::SpendTransactionVersion version = ReadVersion(r);
        const std::pair<CAmount, std::vector<CSparkMintMeta>> estimated = SelectSparkCoins(
            sendAmount, subtractFee, coins, privateRecipients, utxoNum, additionalTxSize, version);
        w.i64(estimated.first);
    });
}

SPARK_EXPORT uint8_t* spark_create_spend(const uint8_t* req, uint32_t len)
{
    return Run(req, len, [](Reader& r, Writer& w) {
        spark::SpendKey spendKey = ReadSpendKey(r);
        spark::FullViewKey fullViewKey(spendKey);
        spark::IncomingViewKey incomingViewKey(fullViewKey);

        std::vector<std::pair<CAmount, bool>> recipients;
        const uint32_t nRecipients = r.count(8 + 1);
        for (uint32_t i = 0; i < nRecipients; i++) {
            const int64_t amount = r.i64();
            const bool subtractFee = r.flag();
            recipients.emplace_back(amount, subtractFee);
        }

        std::vector<std::pair<spark::OutputCoinData, bool>> privateRecipients;
        const uint32_t nPrivate = r.count(4 + 8 + 4 + 1);
        for (uint32_t i = 0; i < nPrivate; i++) {
            spark::OutputCoinData output;
            const std::string address = r.str();
            output.address.decode(address);
            output.v = r.u64();
            output.memo = r.str();
            const bool subtractFee = r.flag();
            privateRecipients.emplace_back(output, subtractFee);
        }

        std::list<CSparkMintMeta> coins = ReadOwnCoins(r, incomingViewKey);
        std::unordered_map<uint64_t, spark::CoverSetData> sets = ReadSets(r);

        std::map<uint64_t, uint256> blockHashes;
        const uint32_t nHashes = r.count(4 + kHashSize);
        for (uint32_t i = 0; i < nHashes; i++) {
            const uint32_t setId = r.u32();
            blockHashes[setId] = ReadHash(r);
        }
        const uint256 txHashSig = ReadHash(r);
        const uint32_t additionalTxSize = r.u32();
        const spark::SpendTransactionVersion version = ReadVersion(r);
        const uint256 extensionCommitment = ReadHash(r);

        CAmount fee = 0;
        std::vector<uint8_t> serializedSpend;
        std::vector<std::vector<unsigned char>> outputScripts;
        std::vector<CSparkMintMeta> spentCoins;
        createSparkSpendTransaction(spendKey, fullViewKey, incomingViewKey, recipients, privateRecipients,
                                    std::move(coins), sets, blockHashes, txHashSig, additionalTxSize,
                                    version, extensionCommitment, fee, serializedSpend, outputScripts,
                                    spentCoins);

        w.bytes(serializedSpend);
        w.u32(static_cast<uint32_t>(outputScripts.size()));
        for (const auto& script : outputScripts) w.bytes(script);
        w.i64(fee);
        w.u32(static_cast<uint32_t>(spentCoins.size()));
        for (const CSparkMintMeta& meta : spentCoins) WriteUsedCoin(w, meta);
    });
}

SPARK_EXPORT uint8_t* spark_verify_spend(const uint8_t* req, uint32_t len)
{
    return Run(req, len, [](Reader& r, Writer& w) {
        // What a Firo node checks of the proof itself (spark/state.cpp CheckSparkSpendTransaction):
        // the spend payload against the transaction's Spark outputs, transparent total
        // and the anonymity sets it names. Double spends and set membership by height
        // are the node's business and not checked here.
        const spark::SpendTransactionVersion version = ReadVersion(r);
        const Reader::View spendBytes = r.bytes();
        std::vector<spark::Coin> outCoins;
        const uint32_t nScripts = r.count(4);
        for (uint32_t i = 0; i < nScripts; i++) {
            const Reader::View script = r.bytes();
            if (script.size < 213 || script.data[0] != OP_SPARKSMINT)
                throw std::invalid_argument("output script is not a Spark spend output");
            CDataStream stream(std::vector<unsigned char>(script.data + 1, script.data + script.size),
                               SER_NETWORK, PROTOCOL_VERSION);
            spark::Coin coin(spark::Params::get_default());
            stream >> coin;
            outCoins.push_back(coin);
        }
        const uint64_t transparentOut = r.u64();
        std::unordered_map<uint64_t, spark::CoverSetData> sets = ReadSets(r);
        const uint256 txHashSig = ReadHash(r);

        bool valid = false;
        std::string reason;
        try {
            const spark::Params* params = spark::Params::get_default();
            spark::SpendTransaction spend(params, version, outCoins.size());
            CDataStream stream(spendBytes.vec(), SER_NETWORK, PROTOCOL_VERSION);
            stream >> spend;
            if (!stream.empty()) throw std::invalid_argument("spend payload has trailing bytes");
            spend.setOutCoins(outCoins);
            spend.setVout(transparentOut);
            std::unordered_map<uint64_t, std::vector<spark::Coin>> coverSets;
            for (auto& entry : sets) {
                entry.second.cover_set_representation.insert(entry.second.cover_set_representation.end(),
                                                              txHashSig.begin(), txHashSig.end());
                coverSets[entry.first] = entry.second.cover_set;
            }
            spend.setCoverSets(sets);
            valid = spark::SpendTransaction::verify(spend, coverSets);
            if (!valid) reason = "proof does not verify";
        } catch (const std::exception& e) {
            reason = e.what();
        }
        w.u8(valid ? 1 : 0);
        w.str(reason);
    });
}

SPARK_EXPORT uint8_t* spark_name_script(const uint8_t* req, uint32_t len)
{
    return Run(req, len, [](Reader& r, Writer& w) {
        const uint32_t validityBlocks = r.u32();
        const std::string name = r.str();
        const std::string info = r.str();
        const uint256 ownershipDigest = ReadHash(r);
        const spark::SpendTransactionVersion version = ReadVersion(r);
        spark::SpendKey spendKey = ReadSpendKey(r);
        const uint32_t d = r.u32();
        const bool testnet = r.flag();
        const uint32_t hashFailSafe = r.u32();
        const bool withoutProof = r.flag();
        if (name.find('\0') != std::string::npos || info.find('\0') != std::string::npos)
            throw std::invalid_argument("name and additional info must not contain NUL bytes");

        spark::FullViewKey fullViewKey(spendKey);
        spark::IncomingViewKey incomingViewKey(fullViewKey);
        spark::CSparkNameTxData nameTxData;
        nameTxData.name = name;
        nameTxData.sparkAddress = getAddress(incomingViewKey, d).encode(Network(testnet));
        nameTxData.sparkNameValidityBlocks = validityBlocks;
        nameTxData.additionalInfo = info;
        nameTxData.hashFailsafe = hashFailSafe;

        std::vector<unsigned char> outputScript;
        if (withoutProof) {
            nameTxData.addressOwnershipProof.clear();
            CDataStream s(SER_NETWORK, PROTOCOL_VERSION);
            s << nameTxData;
            outputScript.assign(s.begin(), s.end());
        } else {
            if (version == spark::SpendTransactionVersion::V1) {
                // flutter_libsparkmobile answers "hash fail" when the V1 digest is
                // not a valid scalar; the caller retries with another hashFailSafe.
                try {
                    getSparkNameOwnershipMessage(ownershipDigest, version);
                } catch (const std::exception&) {
                    throw std::runtime_error("hash fail");
                }
            }
            GetSparkNameScript(nameTxData, ownershipDigest, version, spendKey, incomingViewKey, outputScript);
        }
        w.bytes(outputScript);
        w.u32(static_cast<uint32_t>(getSparkNameTxDataSize(nameTxData)));
    });
}

SPARK_EXPORT uint8_t* spark_name_commitment(const uint8_t* req, uint32_t len)
{
    return Run(req, len, [](Reader& r, Writer& w) {
        const Reader::View data = r.bytes();
        if (data.size == 0) throw std::invalid_argument("Serialized Spark Name data must not be empty");
        CDataStream stream(data.vec(), SER_NETWORK, PROTOCOL_VERSION);
        spark::CSparkNameTxData nameTxData;
        stream >> nameTxData;
        if (!stream.empty()) throw std::invalid_argument("Serialized Spark Name data contains trailing bytes");
        const uint256 commitment = getSparkNameCommitment(nameTxData);
        w.raw(commitment.begin(), commitment.size());
    });
}

namespace {
Scalar OwnershipMessage(const Reader::View& message)
{
    // As flutter_libsparkmobile: Hash("Zcoin Signed Message:\n", message) as a scalar.
    CHashWriter messageHash(SER_GETHASH, 0);
    messageHash << std::string("Zcoin Signed Message:\n") << message.str();
    Scalar m;
    m.SetHex(messageHash.GetHash().GetHex());
    return m;
}
} // namespace

SPARK_EXPORT uint8_t* spark_ownership_proof(const uint8_t* req, uint32_t len)
{
    return Run(req, len, [](Reader& r, Writer& w) {
        const Reader::View message = r.bytes();
        spark::SpendKey spendKey = ReadSpendKey(r);
        const uint32_t d = r.u32();
        if (d > uint32_t(std::numeric_limits<int32_t>::max())) throw std::invalid_argument("Invalid Spark key parameters");
        const Scalar m = OwnershipMessage(message);
        spark::FullViewKey fullViewKey(spendKey);
        spark::IncomingViewKey incomingViewKey(fullViewKey);
        spark::Address address(incomingViewKey, d);
        spark::OwnershipProof proof;
        address.prove_own(m, spendKey, incomingViewKey, proof);
        CDataStream s(SER_NETWORK, PROTOCOL_VERSION);
        s << proof;
        w.raw(s.data(), s.size());
    });
}

SPARK_EXPORT uint8_t* spark_verify_ownership_proof(const uint8_t* req, uint32_t len)
{
    return Run(req, len, [](Reader& r, Writer& w) {
        const Reader::View message = r.bytes();
        const std::string encoded = r.str();
        const Reader::View proofBytes = r.bytes();
        const bool testnet = r.flag();
        bool valid = false;
        try {
            spark::OwnershipProof proof;
            if (encoded.empty() || encoded.find('\0') != std::string::npos ||
                proofBytes.size != proof.memoryRequired())
                throw std::invalid_argument("bad input");
            spark::Address address;
            if (address.decode(encoded) != Network(testnet)) throw std::invalid_argument("wrong network");
            const std::vector<unsigned char> bytes = proofBytes.vec();
            CDataStream stream(bytes, SER_NETWORK, PROTOCOL_VERSION);
            stream >> proof;
            // Reject alternate encodings, as flutter_libsparkmobile does.
            CDataStream canonical(SER_NETWORK, PROTOCOL_VERSION);
            canonical << proof;
            if (bytes != std::vector<unsigned char>(canonical.begin(), canonical.end()))
                throw std::invalid_argument("non-canonical proof");
            valid = address.verify_own(OwnershipMessage(message), proof);
        } catch (const std::exception&) {
            valid = false;
        }
        w.u8(valid ? 1 : 0);
    });
}

SPARK_EXPORT uint8_t* spark_build_info(const uint8_t* req, uint32_t len)
{
    return Run(req, len, [](Reader&, Writer& w) {
        const std::string info = CAMPFIRE_SPARK_BUILD_INFO;
        w.raw(info.data(), info.size());
    });
}
