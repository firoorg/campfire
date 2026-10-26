// Firo network parameters, taken from Firo Core (firoorg/firo, src/chainparams.cpp,
// src/firo_params.h, src/policy/policy.h, src/sparkname.cpp at 44aff224eb,
// 2026-10-11). Values are facts about the chain; where Campfire chose a
// stricter wallet-side value (dust) both are given and the comment says
// which one the wallet uses.
import { t, tk } from '../i18n.js';

const COIN = 100000000n;

/** Spark name fee per year, in whole FIRO, indexed by name length (1..20). Firo Core `standardSparkNamesFee`. */
const SPARK_NAME_FEE_FIRO = Object.freeze([-1, 1000, 100, 10, 10, 10, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);

const MAIN = Object.freeze({
  id: 'main',
  name: 'Firo',
  ticker: 'FIRO',
  decimals: 8,
  coin: COIN,
  maxMoney: 21000000n * COIN,
  genesisHash: '4381deb85b1b2c9843c222944b616d997516dcbd6a964e1eaf0def0830695233',

  // base58Prefixes
  p2pkh: 82, // 0x52, addresses start with "a" or "Z"
  p2sh: 7,
  wif: 210, // 0xd2
  exAddress: Object.freeze([0x01, 0xb9, 0xbb]), // EXX: exchange addresses "EX…"
  bip32: Object.freeze({ public: 0x0488b21e, private: 0x0488ade4 }), // xpub / xprv
  coinType: 136, // BIP44 (SLIP-44 136)
  messagePrefix: '\x16Zcoin Signed Message:\n', // i18n-ignore: part of every signed message (consensus), never shown

  // policy
  /** Smallest output the wallet creates (Campfire's `dustLimit`). Firo Core's own P2PKH dust threshold is 546. */
  dust: 1000n,
  nodeDustP2PKH: 546n,
  /** DEFAULT_MIN_RELAY_TX_FEE: sat per 1000 bytes. */
  minRelayFeePerKb: 1000n,
  /**
   * The highest fee rate the wallet pays, whatever a server asks (audit D-03 / B-2): 100 times the
   * relay minimum, 0.001 FIRO per kB. Firo's blocks are far from full; the rate measured on
   * mainnet in 2026-10 was the minimum. A server asking more is ignored, not obeyed.
   */
  maxFeePerKb: 100000n,
  /** MAX_OP_RETURN_RELAY: the largest standard OP_RETURN script. */
  maxOpReturnRelay: 16384,
  /** MAX_STANDARD_TX_WEIGHT / 4 (no witness): the largest standard transaction in bytes. */
  maxStandardTxSize: 100000,
  coinbaseMaturity: 100,
  targetBlockSeconds: 150,

  // privacy history (heights)
  lelantusStartBlock: 336888,
  /** After this height Lelantus coins can no longer be spent (LELANTUS_GRACEFUL_PERIOD). */
  lelantusGracefulPeriod: 1223500,
  sparkStartBlock: 819300,
  /** Firo v0.14.17.2: one Spark input per spend from here until chaum v2. */
  sparkSingleInputStartBlock: 1355970,
  /** Firo v0.14.18.0 hard fork: Spark spends use tx type 11 (chaum v2) from this height. */
  sparkChaumV2StartBlock: 1371000,
  exchangeAddressStartBlock: 819300,
  sparkOutLimitPerTx: 16,
  sparkValueSpendLimitPerTx: 10000n * COIN,
  sparkMaxMintsPerGroup: 32000,
  sparkSetStartSize: 8000,
  /** Spark address bech32m HRP is "s" + network byte. */
  sparkNetwork: 'm',
  sparkHrp: 'sm',

  // Spark names
  sparkNamesStartBlock: 1104500,
  /** Names can be transferred from here (SPARK_NAME_TRANSFER_MAINNET_START_BLOCK); fees moved to the community fund. */
  sparkNamesV2StartBlock: 1205100,
  /** From here renewals keep remaining validity and up to 15 years are allowed. */
  sparkNamesV21StartBlock: 1329000,
  sparkNameFeeFiro: SPARK_NAME_FEE_FIRO,
  /** Name fees are paid here since block 1,205,100 (stage3CommunityFundAddress). */
  sparkNameFeeAddress: 'aFA2TbqG9cnhhzX5Yny2pBJRK5EaEqLCH7',
  /** …and before it (+100 blocks of grace) to the development fund (stage3DevelopmentFundAddress). */
  sparkNameFeeAddressOld: 'aLgRaYSFk6iVw2FqY1oei8Tdn2aTsGPVmP',

  /** ElectrumX over secure WebSocket: Firo's own four servers (port 50004, measured 2026-10-11). */
  servers: Object.freeze([
    'wss://electrumx.firo.org:50004',
    'wss://electrumx01.firo.org:50004',
    'wss://electrumx02.firo.org:50004',
    'wss://electrumx03.firo.org:50004',
  ]),
  /**
   * Used Spark tags as the servers counted them on 2026-10-12 (240,045; tools/firo_sync_probe.mjs).
   * A NEW wallet starts its tag sync here: no tag before its own first coin can concern it.
   * A restored wallet always starts from 0.
   */
  sparkTagsCheckpoint: 240000,
});

const TEST = Object.freeze({
  ...MAIN,
  id: 'test',
  name: 'tFiro',
  ticker: 'tFIRO',
  genesisHash: 'aa22adcc12becaf436027ffe62a8fb21b234c58c23865291e5dc52cf53f64fca',
  p2pkh: 65, // 0x41, "T…"
  p2sh: 178,
  wif: 185, // 0xb9
  exAddress: Object.freeze([0x01, 0xb9, 0xb1]), // EXT
  bip32: Object.freeze({ public: 0x043587cf, private: 0x04358394 }), // tpub / tprv
  coinType: 1,
  lelantusStartBlock: null,
  lelantusGracefulPeriod: null,
  sparkStartBlock: 107000,
  sparkSingleInputStartBlock: 210700,
  sparkChaumV2StartBlock: 210800,
  exchangeAddressStartBlock: 107000,
  sparkNetwork: 't',
  sparkHrp: 'st',
  sparkNamesStartBlock: 174000,
  sparkNamesV2StartBlock: 189800,
  sparkNamesV21StartBlock: 200000,
  sparkNameFeeAddress: 'TCkC4uoErEyCB4MK3d6ouyJELoXnuyqe9L',
  sparkNameFeeAddressOld: 'TWDxLLKsFp6qcV1LL4U2uNmW4HwMcapmMU',
  servers: Object.freeze(['wss://firo-testnet.stackwallet.com:50004']),
  sparkTagsCheckpoint: 0,
});

export const NETWORKS = Object.freeze({ main: MAIN, test: TEST });

/** 'main' | 'test' → its parameters; throws on anything else. */
export function network(id = 'main') {
  const n = NETWORKS[id];
  if (!n) throw new Error(t('Unknown Firo network: {id}', { id }));
  return n;
}

// ---------------------------------------------------------------- BIP44 paths

/** Transparent BIP44 chains: 0 receive, 1 change. Spark key material lives on chain 6. */
export const CHAIN_RECEIVE = 0;
export const CHAIN_CHANGE = 1;
export const CHAIN_SPARK = 6;
/** The BIP32 index of the Spark key on chain 6 (Campfire's kDefaultSparkIndex), not a diversifier. */
export const SPARK_KEY_INDEX = 1;
/** Spark change goes to diversifier 0x270F. */
export const SPARK_CHANGE_DIVERSIFIER = 9999;
/** Address discovery stops after this many unused addresses in a row on each chain. */
export const GAP_LIMIT = 20;

/** m/44'/coin'/0'/chain/index */
export function bip44Path(net, chain, index, account = 0) {
  return `m/44'/${net.coinType}'/${account}'/${chain}/${index}`;
}

export function sparkKeyPath(net) {
  return bip44Path(net, CHAIN_SPARK, SPARK_KEY_INDEX);
}

// ---------------------------------------------------------------- Spark tx versions

export const TX_TYPE = Object.freeze({
  NORMAL: 0,
  PROVIDER_REGISTER: 1,
  PROVIDER_UPDATE_SERVICE: 2,
  PROVIDER_UPDATE_REGISTRAR: 3,
  PROVIDER_UPDATE_REVOKE: 4,
  COINBASE: 5,
  QUORUM_COMMITMENT: 6,
  SPORK: 7,
  LELANTUS: 8,
  SPARK: 9,
  ALIAS: 10,
  SPARK_V2: 11,
});

/** The 32-bit nVersion of a Spark spend for the block it will be mined in: 3 | type << 16. */
export function sparkSpendTxVersion(net, nextBlockHeight) {
  const type = nextBlockHeight >= net.sparkChaumV2StartBlock ? TX_TYPE.SPARK_V2 : TX_TYPE.SPARK;
  return { type, version: 3 | (type << 16), spendVersion: type === TX_TYPE.SPARK_V2 ? 2 : 1, multiInput: type === TX_TYPE.SPARK_V2 || nextBlockHeight < net.sparkSingleInputStartBlock };
}

// ---------------------------------------------------------------- Spark names

export const SPARK_NAME_MAX_LENGTH = 20;
export const SPARK_NAME_RE = /^[a-zA-Z0-9.-]{1,20}$/;
export const SPARK_NAME_MAX_INFO_BYTES = 1024;
/** 24 blocks an hour (sparkname.cpp nBlockPerYear). */
export const SPARK_NAME_BLOCKS_PER_YEAR = 365 * 24 * 24;

/** Whether `name` is a valid Spark name (Firo Core IsSparkNameValid). Names are case-insensitive. */
export function isValidSparkName(name) {
  return typeof name === 'string' && SPARK_NAME_RE.test(name);
}

/** Most years a name can be registered for at `height` (15 from the V2.1 fork, 10 before). */
export function sparkNameMaxYears(net, height) {
  return height >= net.sparkNamesV21StartBlock ? 15 : 10;
}

/** The registration fee in satoshi for `name` and `years`. */
export function sparkNameFee(net, name, years) {
  if (!isValidSparkName(name)) throw new Error(t('A Spark name is 1 to 20 letters, digits, dots or hyphens.'));
  if (!Number.isInteger(years) || years < 1 || years > 15) throw new Error(t('A Spark name is registered for 1 to 15 years.'));
  return BigInt(net.sparkNameFeeFiro[name.length]) * BigInt(years) * net.coin;
}
