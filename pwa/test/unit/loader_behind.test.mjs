// When a page counts as still running under an older loader's headers (lib/loader.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isLoaderBehind, loaderBehind } from '../../src/lib/loader.js';

const ORIGIN = 'https://wallet.example.org/app/';
const OLD = `${ORIGIN}sw-1111111111111111.js`;
const NEW = 'sw-2222222222222222.js';
const C1 = 'a'.repeat(64);
const C2 = 'b'.repeat(64);

test('served by the release\'s own loader, or not controlled at all: not behind', () => {
  assert.equal(isLoaderBehind({ servedBy: `${ORIGIN}${NEW}`, loader: NEW, servedCompat: null, releaseCompat: C1 }), false);
  assert.equal(isLoaderBehind({ servedBy: `${ORIGIN}${NEW}?v=1`, loader: NEW, servedCompat: null, releaseCompat: C1 }), false);
  assert.equal(isLoaderBehind({ servedBy: null, loader: NEW, servedCompat: null, releaseCompat: C1 }), false);
});

test('another loader with the same loader_compat serves the same headers: not behind (no banner, no move)', () => {
  assert.equal(isLoaderBehind({ servedBy: OLD, loader: NEW, servedCompat: C1, releaseCompat: C1 }), false);
});

test('another loader that serves pages differently, or has not said: behind (retry the move at each start)', () => {
  assert.equal(isLoaderBehind({ servedBy: OLD, loader: NEW, servedCompat: C2, releaseCompat: C1 }), true, 'different compat');
  assert.equal(isLoaderBehind({ servedBy: OLD, loader: NEW, servedCompat: null, releaseCompat: C1 }), true, 'an older loader that reports no compat (0.1.8)');
  assert.equal(isLoaderBehind({ servedBy: OLD, loader: NEW, servedCompat: C1, releaseCompat: null }), true, 'an unbuilt page knows no compat');
  assert.equal(isLoaderBehind({ servedBy: OLD, loader: NEW, servedCompat: '', releaseCompat: '' }), true, 'empty values prove nothing');
});

test('outside a browser (no service worker) the page is not behind', () => {
  assert.equal(loaderBehind(), false);
});
