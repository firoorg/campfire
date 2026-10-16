// Money values in the person's currency: the one question on Home before any price is asked of
// CoinGecko, the line under the balance, and the Settings rows. The rules live in lib/fiat.js.
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { secondary, textButton, toast } from '../lib/ui.js';
import { fiatEstimate, fiatAllowed, fiatUnasked, currencyOf, currencyWords, FIAT_CURRENCIES, firoPrice } from '../lib/fiat.js';

/** FIRO's price to show now ({price, currency}), asking CoinGecko in the background when due and allowed. */
export const priceNow = (app) => firoPrice(app).get();

/** "≈ $12.34" for `sats`, or null without a price. */
export const moneyOf = (app, sats) => fiatEstimate(sats, priceNow(app));

/** The question before any price is asked: once, remembered either way. onAnswer re-renders. */
export function priceQuestion(app, onAnswer) {
  const words = currencyWords(currencyOf(app.prefs));
  const answer = async (yes) => {
    await app.setPrefs({ fiatPrices: yes });
    if (yes) firoPrice(app).refresh({ force: true });
    else toast(`No prices are asked. Settings → Values in ${words} turns them on.`, 4000);
    onAnswer();
  };
  return h(
    'div',
    { class: 'card price-ask', 'data-testid': 'price-ask' },
    h('div', { class: 't', text: `Show values in ${words}?` }),
    h('p', { class: 'small', text: "This asks CoinGecko for FIRO's price; it sees your IP address, not your wallet." }),
    h('div', { class: 'btn-row prompt-actions' }, secondary(`Show in ${words}`, () => answer(true), { class: 'btn btn-secondary btn-small', 'data-testid': 'price-allow' }), textButton('Not now', () => answer(false), { class: 'btn btn-text btn-small', 'data-testid': 'price-refuse' })),
  );
}

/** Whether Home should ask (not asked yet, and there is something to value). */
export const shouldAsk = (app, hasFunds) => hasFunds && fiatUnasked(app.prefs);

/** Settings' rows: values in the person's currency, and which currency. */
export function priceSettings(app) {
  const box = h('div');
  function render() {
    const on = fiatAllowed(app.prefs);
    const cur = currencyOf(app.prefs);
    const sw = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': `Values in ${currencyWords(cur)}`, 'data-testid': 'price-switch', checked: on });
    sw.addEventListener('change', async () => {
      await app.setPrefs({ fiatPrices: sw.checked });
      if (sw.checked) firoPrice(app).refresh({ force: true });
      else firoPrice(app).forget();
      toast(sw.checked ? `Values in ${currencyWords(cur)} are on` : 'Prices are off: nothing is asked of CoinGecko');
      render();
    });
    const sel = h('select', { class: 'inline', 'aria-label': 'Currency', 'data-testid': 'currency-select' }, ...FIAT_CURRENCIES.map(([code, name]) => h('option', { value: code, text: `${code} · ${name}` })));
    sel.value = cur;
    sel.addEventListener('change', async () => {
      await app.setPrefs({ fiatCurrency: sel.value });
      firoPrice(app).forget();
      firoPrice(app).refresh({ force: true });
      toast(`Values in ${sel.value}`);
      render();
    });
    put(
      box,
      h(
        'label',
        { class: 'row' },
        h('span', { class: 'ico' }, icon('globe')),
        h('span', { class: 'main' }, h('div', { class: 't', text: `Values in ${currencyWords(cur)}` }), h('div', { class: 's wrap', text: "FIRO's price from CoinGecko, which sees your IP address. Off: values in FIRO only." })),
        sw,
      ),
      on ? h('div', { class: 'row' }, h('span', { class: 'ico' }, icon('settings')), h('span', { class: 'main' }, h('div', { class: 't', text: 'Currency' })), sel) : null,
    );
  }
  render();
  return box;
}
