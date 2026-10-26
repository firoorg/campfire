#!/usr/bin/env python3
"""Independent Firo key vectors for pwa/test/fixtures/firo_keys.json.

A second implementation of BIP39 -> BIP32 -> BIP44 (m/44'/136'/0'/c/i) ->
P2PKH address and WIF, written against the BIPs with the Python standard
library only (hashlib PBKDF2/HMAC/SHA-256/RIPEMD-160 and textbook secp256k1
arithmetic), so the JavaScript in src/lib/firo/keys.js is checked against
code that shares nothing with it.

With --libspark PATH (a compiled libflutter_libsparkmobile, e.g. from a
Campfire desktop build) it also asks Firo's own Spark library for the Spark
addresses of each key and for the hashes of the linking tags in
--tags FILE (a JSON list of base64 tags), so the vectors pin those too.

  python3 -I tools/firo_vectors.py [--libspark PATH] [--tags FILE] > test/fixtures/firo_keys.json
"""
import argparse
import ctypes
import base64
import hashlib
import hmac
import json
import sys

# ------------------------------------------------------------------ secp256k1

P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)


def point_add(a, b):
    if a is None:
        return b
    if b is None:
        return a
    if a[0] == b[0] and (a[1] + b[1]) % P == 0:
        return None
    if a == b:
        lam = (3 * a[0] * a[0]) * pow(2 * a[1], P - 2, P) % P
    else:
        lam = (b[1] - a[1]) * pow(b[0] - a[0], P - 2, P) % P
    x = (lam * lam - a[0] - b[0]) % P
    return (x, (lam * (a[0] - x) - a[1]) % P)


def point_mul(k, pt=G):
    out = None
    while k:
        if k & 1:
            out = point_add(out, pt)
        pt = point_add(pt, pt)
        k >>= 1
    return out


def compressed(pt):
    return bytes([2 + (pt[1] & 1)]) + pt[0].to_bytes(32, 'big')


# ------------------------------------------------------------------ hashes, base58

def sha256(b):
    return hashlib.sha256(b).digest()


def hash160(b):
    r = hashlib.new('ripemd160')
    r.update(sha256(b))
    return r.digest()


B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'


def b58check(payload):
    data = payload + sha256(sha256(payload))[:4]
    n = int.from_bytes(data, 'big')
    s = ''
    while n:
        n, r = divmod(n, 58)
        s = B58[r] + s
    return '1' * (len(data) - len(data.lstrip(b'\0'))) + s


# ------------------------------------------------------------------ BIP32

def ser32(i):
    return i.to_bytes(4, 'big')


def master(seed):
    i = hmac.new(b'Bitcoin seed', seed, hashlib.sha512).digest()
    return int.from_bytes(i[:32], 'big'), i[32:]


def ckd_priv(k, c, index):
    if index >= 0x80000000:
        data = b'\0' + k.to_bytes(32, 'big') + ser32(index)
    else:
        data = compressed(point_mul(k)) + ser32(index)
    i = hmac.new(c, data, hashlib.sha512).digest()
    il = int.from_bytes(i[:32], 'big')
    assert il < N
    child = (il + k) % N
    assert child != 0
    return child, i[32:]


def derive(seed, path):
    k, c = master(seed)
    parent_pub = None
    depth = 0
    index = 0
    for part in path.split('/')[1:]:
        index = int(part.rstrip("'")) + (0x80000000 if part.endswith("'") else 0)
        parent_pub = compressed(point_mul(k))
        k, c = ckd_priv(k, c, index)
        depth += 1
    return k, c, depth, parent_pub, index


def xpub(seed, path, version):
    k, c, depth, parent_pub, index = derive(seed, path)
    fp = hash160(parent_pub)[:4]
    return b58check(version.to_bytes(4, 'big') + bytes([depth]) + fp + ser32(index) + c + compressed(point_mul(k)))


NETS = {
    'main': {'p2pkh': 0x52, 'wif': 0xd2, 'coin': 136, 'xpub': 0x0488b21e, 'test': 0},
    'test': {'p2pkh': 0x41, 'wif': 0xb9, 'coin': 1, 'xpub': 0x043587cf, 'test': 1},
}


def bip39_seed(mnemonic, passphrase):
    return hashlib.pbkdf2_hmac('sha512', mnemonic.encode('utf-8'), ('mnemonic' + passphrase).encode('utf-8'), 2048)


# ------------------------------------------------------------------ libspark (optional)

class LibSpark:
    def __init__(self, path):
        self.lib = ctypes.CDLL(path)
        self.lib.getAddress.restype = ctypes.c_char_p
        self.lib.getAddress.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_int, ctypes.c_int]
        self.lib.hashTags.restype = ctypes.c_void_p
        self.lib.hashTags.argtypes = [ctypes.c_char_p, ctypes.c_int]
        self.lib.getFullViewKeyFromPrivateKeyData.restype = ctypes.c_void_p
        self.lib.getFullViewKeyFromPrivateKeyData.argtypes = [ctypes.c_char_p, ctypes.c_int]
        self.lib.serializeFullViewKey.restype = ctypes.c_void_p
        self.lib.serializeFullViewKey.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]

    def address(self, key, index, diversifier, testnet):
        return self.lib.getAddress(key, index, diversifier, testnet).decode()

    def full_view_key(self, key, index):
        fvk = self.lib.getFullViewKeyFromPrivateKeyData(key, index)
        size = ctypes.c_int(0)
        ptr = self.lib.serializeFullViewKey(fvk, ctypes.byref(size))
        return ctypes.string_at(ptr, size.value).hex()

    def hash_tags(self, tags):
        buf = b''.join(tags)
        ptr = self.lib.hashTags(buf, len(tags))
        raw = ctypes.string_at(ptr, 64 * len(tags)).decode()
        return [raw[i * 64:(i + 1) * 64] for i in range(len(tags))]


# ------------------------------------------------------------------ vectors

CASES = [
    # The BIP39 reference phrase; with "TREZOR" its seed is the BIP39 test vector.
    ('main', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', ''),
    ('main', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 'TREZOR'),
    ('main', 'legal winner thank year wave sausage worth useful legal winner thank yellow', ''),
    ('main', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon '
             'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art', 'campfire'),
    ('test', 'legal winner thank year wave sausage worth useful legal winner thank yellow', ''),
]


def vector(net_id, mnemonic, passphrase, spark):
    net = NETS[net_id]
    seed = bip39_seed(mnemonic, passphrase)
    out = {
        'network': net_id,
        'mnemonic': mnemonic,
        'passphrase': passphrase,
        'seed': seed.hex(),
        'accountXpub': xpub(seed, f"m/44'/{net['coin']}'/0'", net['xpub']),
        'addresses': [],
    }
    for chain, count in ((0, 3), (1, 2)):
        for i in range(count):
            path = f"m/44'/{net['coin']}'/0'/{chain}/{i}"
            k, _, _, _, _ = derive(seed, path)
            pub = compressed(point_mul(k))
            out['addresses'].append({
                'path': path,
                'chain': chain,
                'index': i,
                'address': b58check(bytes([net['p2pkh']]) + hash160(pub)),
                'pubkey': pub.hex(),
                'privkey': k.to_bytes(32, 'big').hex(),
                'wif': b58check(bytes([net['wif']]) + k.to_bytes(32, 'big') + b'\x01'),
            })
    spath = f"m/44'/{net['coin']}'/0'/6/1"
    sk, _, _, _, _ = derive(seed, spath)
    skb = sk.to_bytes(32, 'big')
    out['spark'] = {'path': spath, 'keyMaterial': skb.hex()}
    if spark:
        out['spark']['source'] = 'libflutter_libsparkmobile getAddress(keyData, 1, d, isTestNet)'
        out['spark']['fullViewKey'] = spark.full_view_key(skb, 1)
        out['spark']['addresses'] = {str(d): spark.address(skb, 1, d, net['test']) for d in (0, 1, 2, 9999)}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--libspark')
    ap.add_argument('--tags')
    a = ap.parse_args()
    spark = LibSpark(a.libspark) if a.libspark else None
    doc = {
        'comment': 'Generated by tools/firo_vectors.py: an independent stdlib-only BIP39/BIP32/BIP44 implementation'
                   + (' plus Firo\'s Spark library (libflutter_libsparkmobile) for Spark addresses and tag hashes.' if spark else '.'),
        'bip39_reference': {
            'mnemonic': CASES[1][1], 'passphrase': 'TREZOR',
            'seed': 'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',
        },
        'vectors': [vector(n, m, p, spark) for n, m, p in CASES],
    }
    assert doc['vectors'][1]['seed'] == doc['bip39_reference']['seed'], 'BIP39 reference seed mismatch'
    if spark and a.tags:
        with open(a.tags) as f:
            tags = json.load(f)
        raw = [base64.b64decode(t) for t in tags]
        assert all(len(t) == 34 for t in raw)
        doc['tagHashes'] = {
            'source': 'libflutter_libsparkmobile hashTags (primitives::GetLTagHash)',
            'items': [{'tag': t, 'lTagHash': h} for t, h in zip(tags, spark.hash_tags(raw))],
        }
    json.dump(doc, sys.stdout, indent=1)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
