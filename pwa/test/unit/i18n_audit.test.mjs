// The release audit of the languages (0.1.12): what a language must never change.
//   - The person's own text (a BIP39 passphrase, a memo, a name) is never retouched: Chinese and
//     Japanese typesetting applies to the app's own templates only. A passphrase shown without the
//     space after "，" restores a different, empty wallet.
//   - The CSV file stays English (spreadsheets and tax tools read it).
//   - A search for a coin finds it by its English name in every language.
//   - An element named twice by a translation stands in one place only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { body } from './helpers/fake_dom.mjs';
import { h, append } from '../../src/lib/dom.js';
import { activateLanguage, t, tn, tNodes, sentences } from '../../src/lib/i18n.js';
import { buildCsv } from '../../src/lib/tx_csv.js';
import { chainName, chainNameEnglish } from '../../src/lib/buy/buyfiro.js';

const storage = { getItem: () => null, setItem() {}, removeItem() {} };
const doc = { documentElement: { setAttribute() {} } };
async function inLanguage(lang, catalog, fn) {
  try {
    await activateLanguage(lang, { storage, doc, fetchImpl: async () => ({ ok: true, json: async () => catalog }), notify: false });
    return await fn();
  } finally {
    await activateLanguage('en', { storage, doc, notify: false });
  }
}

const PASSPHRASE = '我的钱包， 2024。 第二';

test('Chinese and Japanese: the person\'s own text keeps every space; only the app\'s templates are typeset', async () => {
  for (const lang of ['zh-Hans', 'ja']) {
    await inLanguage(lang, { 'Plus your passphrase: {p}': '加上口令： {p}', 'Done. Next.': '完成。 下一步。', '{n} codes': { other: '{n} 个代码。 好' } }, async () => {
      body.replaceChildren();
      const el = h('p', { text: PASSPHRASE });
      assert.equal(el.textContent, PASSPHRASE, `${lang}: a text prop as it is`);
      const p = append(h('p'), [t('Done. Next.'), ' ', PASSPHRASE]);
      assert.equal(p.textContent, `完成。下一步。 ${PASSPHRASE}`, `${lang}: children as they are`);
      assert.equal(t('Plus your passphrase: {p}', { p: PASSPHRASE }), `加上口令：${PASSPHRASE}`, `${lang}: the template typeset, the value untouched`);
      assert.equal(tn({ one: '{n} code', other: '{n} codes' }, 2), '2 个代码。好');
      assert.deepEqual(tNodes('Plus your passphrase: {p}', { p: PASSPHRASE }), ['加上口令：', PASSPHRASE]);
      assert.equal(sentences('完成。', PASSPHRASE), `完成。${PASSPHRASE}`, 'a join after a full stop: no space; the sentence itself as it is');
      assert.equal(sentences('完成。', null, '', '下一步。'), '完成。下一步。');
    });
  }
  assert.equal(sentences('Done.', null, 'Next one.'), 'Done. Next one.', 'English: a space');
  assert.equal(sentences('Done. ', 'Next.'), 'Done. Next.', 'never two spaces');
});

test('an element a translation names twice stands in one place; the second time it is its text', async () => {
  globalThis.Node = class {};
  const link = Object.assign(new globalThis.Node(), { textContent: 'Settings' });
  try {
    await inLanguage('de', { 'In {s}, look.': 'In {s} schauen: {s}.' }, async () => {
      assert.deepEqual(tNodes('In {s}, look.', { s: link }), ['In ', link, ' schauen: ', 'Settings', '.']);
    });
  } finally {
    delete globalThis.Node;
  }
});

test('the CSV file is English in every language: headers, kinds and states', async () => {
  const txs = [{ txid: 'a'.repeat(64), time: 1700000000, kind: 'spark', direction: 'in', amount: 150000000n, fee: 0n, confirmations: 3 }];
  const english = buildCsv(txs);
  await inLanguage('ru', { Received: 'Получен', Private: 'Приватный', Type: 'Тип', 'Waiting for confirmation': 'Ожидает' }, async () => {
    assert.equal(buildCsv(txs), english, 'the same bytes as in English');
  });
  assert.match(english, /^\uFEFF?Date \| Time,Type,Balance/, "after the byte-order mark spreadsheets read");
  assert.match(english, /Received,Private/);
});

test('a coin search matches the English name in every language', async () => {
  await inLanguage('zh-Hans', { Bitcoin: '比特币' }, async () => {
    assert.equal(chainName('btc'), '比特币', 'shown in the language');
    assert.equal(chainNameEnglish('btc'), 'Bitcoin', 'searched in English too');
  });
  assert.equal(chainNameEnglish('nochain'), 'NOCHAIN');
});
