import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { sealWithPassword, openWithPassword, sealWithPrf, openWithPrf, newDbPassword, randomBytes, EnvelopeError, PBKDF2_MIN_ITERATIONS, KEK_INFO, SCRYPT, passwordEnvelopeOutdated } from '../../src/lib/envelope.js';
import { scrypt as nodeScrypt } from 'node:crypto';

// The old kind (version 1, PBKDF2), as earlier versions wrote it: still opened.
const PBKDF2 = { kdf: 'pbkdf2' };

const secret = newDbPassword();

test('database password: 32 random bytes as hex', () => {
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.notEqual(newDbPassword(), newDbPassword());
});

test('password envelope (version 1, PBKDF2): round trip, >= 600k rounds, fresh salt and IV; marked outdated', async () => {
  const e1 = await sealWithPassword(secret, 'correct horse', 'w1', PBKDF2);
  const e2 = await sealWithPassword(secret, 'correct horse', 'w1', PBKDF2);
  assert.equal(passwordEnvelopeOutdated(e1), true);
  assert.equal(e1.iterations, PBKDF2_MIN_ITERATIONS);
  assert.ok(e1.iterations >= 600000);
  assert.notEqual(e1.salt, e2.salt);
  assert.notEqual(e1.iv, e2.iv);
  assert.notEqual(e1.ct, e2.ct);
  assert.ok(!JSON.stringify(e1).includes(secret), 'the secret is not in the envelope');
  assert.equal(await openWithPassword(e1, 'correct horse'), secret);
});

test('wrong password is refused', async () => {
  const e = await sealWithPassword(secret, 'correct horse', 'w1');
  await assert.rejects(openWithPassword(e, 'correct horsf'), (x) => x instanceof EnvelopeError && x.code === 'wrong_secret');
  await assert.rejects(openWithPassword(e, ''), (x) => x.code === 'wrong_secret');
});

test('tampering is detected (version 1): ciphertext, IV, wallet id, and a lowered round count', async () => {
  const e = await sealWithPassword(secret, 'pw-12345678', 'w1', PBKDF2);
  const flip = (b64) => {
    const b = Buffer.from(b64, 'base64');
    b[0] ^= 1;
    return b.toString('base64');
  };
  await assert.rejects(openWithPassword({ ...e, ct: flip(e.ct) }, 'pw-12345678'), (x) => x.code === 'wrong_secret');
  await assert.rejects(openWithPassword({ ...e, iv: flip(e.iv) }, 'pw-12345678'), (x) => x.code === 'wrong_secret');
  await assert.rejects(openWithPassword({ ...e, walletId: 'w2' }, 'pw-12345678'), (x) => x.code === 'wrong_secret');
  await assert.rejects(openWithPassword({ ...e, iterations: 1000 }, 'pw-12345678'), (x) => x.code === 'weak');
  await assert.rejects(openWithPassword({ ...e, iterations: 700000 }, 'pw-12345678'), (x) => x.code === 'wrong_secret');
  await assert.rejects(openWithPassword({ ...e, kind: 'passkey' }, 'pw-12345678'), (x) => x.code === 'malformed');
});

test('refuses to seal with fewer than 600,000 rounds', async () => {
  await assert.rejects(sealWithPassword(secret, 'pw-12345678', 'w1', { kdf: 'pbkdf2', iterations: 100000 }), (x) => x.code === 'weak');
});

test('passkey envelope: HKDF(PRF output, info) round trip, wrong PRF refused', async () => {
  const prf = randomBytes(32);
  const prfSalt = randomBytes(32);
  const e = await sealWithPrf(secret, prf, 'w1', 'cred-abc', prfSalt);
  assert.equal(e.kind, 'passkey');
  assert.equal(e.credId, 'cred-abc');
  assert.equal(await openWithPrf(e, prf), secret);
  await assert.rejects(openWithPrf(e, randomBytes(32)), (x) => x.code === 'wrong_secret');
  await assert.rejects(openWithPrf({ ...e, credId: 'cred-other' }, prf), (x) => x.code === 'wrong_secret');
  await assert.rejects(openWithPrf(e, randomBytes(16)), (x) => x.code === 'malformed');
});

test('passkey KEK is HKDF-SHA256 with info "campfire-firo-kek-v1", bound as additional data (independent derivation decrypts it)', async () => {
  const prf = randomBytes(32);
  const e = await sealWithPrf(secret, prf, 'w9', 'c1', randomBytes(32));
  assert.equal(KEK_INFO, 'campfire-firo-kek-v1');
  const s = webcrypto.subtle;
  const base = await s.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  const kek = await s.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: Buffer.from(e.salt, 'base64'), info: new TextEncoder().encode('campfire-firo-kek-v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const aad = new TextEncoder().encode(JSON.stringify([e.v, e.kind, e.walletId, 0, e.credId, e.salt, e.info]));
  const pt = await s.decrypt({ name: 'AES-GCM', iv: Buffer.from(e.iv, 'base64'), additionalData: aad }, kek, Buffer.from(e.ct, 'base64'));
  assert.equal(new TextDecoder().decode(pt), secret);
});

test("passkey envelopes carry Campfire for Firo's own label; one made before it (no label) still opens; another label does not", async () => {
  const { sealWithPrf, openWithPrf, KEK_INFO } = await import('../../src/lib/envelope.js');
  assert.equal(KEK_INFO, 'campfire-firo-kek-v1');
  const prf = new Uint8Array(32).fill(7);
  const env = await sealWithPrf('ab'.repeat(32), prf, 'w1', 'cred1', new Uint8Array(32).fill(1));
  assert.equal(env.info, 'campfire-firo-kek-v1');
  assert.equal(await openWithPrf(env, prf), 'ab'.repeat(32));
  // An envelope as 0.1.0-0.1.3 made it: HKDF info "beam-campfire-kek-v1", no info field, info not bound.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  const kek = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('beam-campfire-kek-v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const b64 = (u) => Buffer.from(u).toString('base64');
  const old = { v: 1, kind: 'passkey', walletId: 'w1', credId: 'cred1', prfSalt: b64(new Uint8Array(32).fill(1)), salt: b64(salt) };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(JSON.stringify([old.v, old.kind, old.walletId, 0, old.credId, old.salt]));
  old.iv = b64(iv);
  old.ct = b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, kek, new TextEncoder().encode('cd'.repeat(32)))));
  assert.equal(await openWithPrf(old, prf), 'cd'.repeat(32), 'a passkey set up before the change still unlocks');
  await assert.rejects(openWithPrf({ ...env, info: 'beam-campfire-kek-v1' }, prf), /Not a Campfire envelope/);
});

test("a new passkey is named for Campfire for Firo in the device's passkey list", async () => {
  const { passkeyNames } = await import('../../src/lib/passkey.js');
  assert.deepEqual(passkeyNames('abcdef123', 'Savings'), { name: 'Campfire Firo wallet abcdef', displayName: 'Campfire (Firo): Savings' });
  assert.deepEqual(passkeyNames('abcdef123'), { name: 'Campfire Firo wallet abcdef', displayName: 'Campfire Firo wallet' });
});

test('PN-keys: a record asking for an implausible number of rounds is refused before any work (it would hang the unlock)', async () => {
  const e = await sealWithPassword(newDbPassword(), 'correct horse', 'w1', PBKDF2);
  const t0 = Date.now();
  await assert.rejects(openWithPassword({ ...e, iterations: 2 ** 40 }, 'correct horse'), (x) => x instanceof EnvelopeError && x.code === 'malformed' && /implausible number of key rounds/.test(x.message));
  assert.ok(Date.now() - t0 < 500, 'refused at once');
});

test('P9: a new password envelope is scrypt (N 2^16, r 8, p 1), version 2; its cost is bound and capped; an independent scrypt opens it', async () => {
  const e = await sealWithPassword(secret, 'correct horse', 'w1');
  assert.deepEqual([e.v, e.kdf, e.N, e.r, e.p], [2, 'scrypt', 2 ** 16, 8, 1]);
  assert.deepEqual(SCRYPT, { N: 2 ** 16, r: 8, p: 1 });
  assert.equal(e.iterations, undefined);
  assert.equal(passwordEnvelopeOutdated(e), false);
  assert.equal(await openWithPassword(e, 'correct horse'), secret);
  await assert.rejects(openWithPassword(e, 'correct horsf'), (x) => x.code === 'wrong_secret');
  // A lowered cost is refused or does not open; an inflated one is refused before any work.
  await assert.rejects(openWithPassword({ ...e, N: 2 ** 10 }, 'correct horse'), (x) => x.code === 'weak');
  await assert.rejects(openWithPassword({ ...e, N: 2 ** 15 }, 'correct horse'), (x) => x.code === 'wrong_secret');
  await assert.rejects(openWithPassword({ ...e, N: 2 ** 30 }, 'correct horse'), (x) => x.code === 'malformed');
  await assert.rejects(openWithPassword({ ...e, N: 3000 }, 'correct horse'), (x) => x.code === 'malformed');
  await assert.rejects(openWithPassword({ ...e, p: 64 }, 'correct horse'), (x) => x.code === 'malformed');
  await assert.rejects(openWithPassword({ ...e, kdf: 'pbkdf2' }, 'correct horse'), (x) => x.code === 'malformed');
  await assert.rejects(openWithPassword({ ...e, walletId: 'w2' }, 'correct horse'), (x) => x.code === 'wrong_secret');
  // Node's own scrypt and AES-GCM, with the additional data as documented, decrypt it.
  const kek = await new Promise((res, rej) => nodeScrypt(Buffer.from('correct horse'.normalize('NFC')), Buffer.from(e.salt, 'base64'), 32, { N: e.N, r: e.r, p: e.p, maxmem: 256 * 1024 * 1024 }, (err, k) => (err ? rej(err) : res(k))));
  const s = webcrypto.subtle;
  const key = await s.importKey('raw', kek, 'AES-GCM', false, ['decrypt']);
  const aad = new TextEncoder().encode(JSON.stringify([e.v, e.kind, e.walletId, 0, '', e.salt, 'scrypt', e.N, e.r, e.p]));
  const pt = await s.decrypt({ name: 'AES-GCM', iv: Buffer.from(e.iv, 'base64'), additionalData: aad }, key, Buffer.from(e.ct, 'base64'));
  assert.equal(new TextDecoder().decode(pt), secret);
});
