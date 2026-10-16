// Block heights from dates (lib/heights.js), against blocks the chain itself gives (public audit,
// P18: at 5 minutes a block throughout, a date before the anchor came out far too late, and a
// restore from it could miss payments). Every estimate must be on the safe side, earlier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { heightAt, heightForDate, birthdayNow, timeOfHeight, BLOCK_SEC, STAGE3, ANCHOR } from '../../src/lib/heights.js';

const at = (iso) => Date.parse(iso) / 1000;

test('2.5-minute blocks since stage 3 (block 486,221, 16 June 2022), 5 minutes before', () => {
  assert.equal(BLOCK_SEC, 150);
  assert.deepEqual(STAGE3, { height: 486221, time: 1655380800 });
  // The measured anchor, and stage 3 itself, from either side.
  assert.equal(heightAt(ANCHOR.time), 1393023);
  const s3 = heightAt(STAGE3.time);
  assert.ok(s3 <= 486221 && s3 > 486221 - 5000, `stage 3: ${s3}, at or a little before 486,221`);
  assert.equal(heightAt(STAGE3.time - 1), 486221);
  assert.equal(heightAt(STAGE3.time - 300 * 1000), 486221 - 1000, 'five minutes a block before it');
  // A day is 576 blocks now.
  assert.equal(heightAt(ANCHOR.time + 86400) - heightAt(ANCHOR.time), 576);
});

test('"Restore from a date" before the anchor starts early enough: Spark\'s first block (819,300, January 2024)', () => {
  // Spark started on mainnet at block 819,300, in January 2024: 1 January 2024 is at or before it.
  const h = heightForDate('2024-01-01');
  assert.ok(h < 819300, `${h}: before Spark's first block`);
  assert.ok(h > 790000, `${h}: not needlessly far back`);
  assert.equal(heightForDate('not a date'), null);
  assert.equal(heightForDate('2026-10-12'), 1393023 - 2 * 576, 'two days early');
});

test('a new wallet\'s birthday is a day early; times of blocks go back across stage 3', () => {
  assert.equal(birthdayNow(ANCHOR.time), 1393023 - 576);
  assert.equal(timeOfHeight(1393023 - 576), ANCHOR.time - 86400);
  const ref = { height: ANCHOR.height, time: ANCHOR.time };
  const s3 = timeOfHeight(STAGE3.height, ref);
  assert.equal(timeOfHeight(STAGE3.height - 12, ref), s3 - 12 * 300, '5 minutes a block before stage 3');
});
