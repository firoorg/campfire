/* Ethereum wallet: start (Home's switcher -> Ethereum, or Settings -> Ethereum wallet, when there is none)
 * Spec: ONE job: start an Ethereum wallet next to the Firo one - a new one, or one from its words or key.
 *       Primary CTA: "Create an Ethereum wallet" (secondary: "Import words or private key").
 *       Taps from app open: 1 (Home -> Ethereum); each choice is 1 more.
 * Exit-intent reasons and answers:
 *   - "Why another set of words?" -> said first: the Ethereum wallet has its own words; the Firo
 *     words do not open it.
 *   - "Is this a scam?" -> no account, no sign-up; the key stays on this device, locked with this
 *     wallet's password.
 *   - "Ethereum isn't private" -> said before anything connects (step 3 is the privacy screen).
 *   - "I already have an Ethereum wallet" -> its own button: its words (12 to 24) or its private key.
 */
import { h } from '../lib/dom.js';
import { screen, primary, secondary } from '../lib/ui.js';
import { chainSwitch } from './eth_screens.js';

// Opened for a task, it is a step of that task with a Back to it; otherwise it is the Ethereum side itself.
const OPENED_FROM = { settings: 'settings', buy: 'home', nearIntents: 'home', bridge: 'bridge', sell: 'sellFiro', sellRsfiro: 'home' };
// Opened on the way to rsFIRO: why this wallet is needed first.
const FOR_RSFIRO = new Set(['nearIntents', 'bridge', 'sellRsfiro']);
// Opened from Sell FIRO: the payout goes to this wallet.
const FOR_PAYOUT = new Set(['sell']);

export default function ethStart(app, params = {}) {
  const step = Object.hasOwn(OPENED_FROM, params.from);
  const back = () => app.back(OPENED_FROM[params.from]);
  const el = screen(
    {
      title: step ? 'Ethereum wallet' : null,
      brand: !step,
      back: step ? back : null,
      tabs: step ? null : 'home',
      app,
      actions: [
        primary('Create an Ethereum wallet', () => {
          app.ethSetup = { mode: 'create', from: params.from || 'home' };
          app.go('ethWords');
        }, { 'data-testid': 'eth-create' }),
        secondary('Import words or private key', () => {
          app.ethSetup = { mode: 'import', from: params.from || 'home' };
          app.go('ethImport');
        }, { 'data-testid': 'eth-import' }),
        h('p', { class: 'small center', text: 'No sign-up. The key stays on this device, locked with your Campfire password.' }),
      ],
    },
    step ? null : chainSwitch(app, 'eth'),
    h(
      'div',
      { class: 'hero eth-hero' },
      h('img', { src: 'img/eth.svg', alt: '' }),
      FOR_RSFIRO.has(params.from)
        ? h('h1', { 'data-testid': 'eth-start-why', text: 'First, a wallet for rsFIRO' })
        : FOR_PAYOUT.has(params.from)
          ? h('h1', { 'data-testid': 'eth-start-why', text: 'First, a wallet for your USDT' })
          : h('h1', { text: 'Add an Ethereum & BNB wallet' }),
      FOR_RSFIRO.has(params.from)
        ? h('p', { text: 'rsFIRO is FIRO on Ethereum and BNB Chain. It arrives in this wallet, next to your FIRO. Set it up once, then carry on.' })
        : FOR_PAYOUT.has(params.from)
          ? h('p', { text: 'buyfiro.app pays your USDT on BNB Chain to this wallet, next to your FIRO. Set it up once, then carry on with your sell.' })
          : h('p', { text: 'Hold ETH, BNB, rsFIRO, USDT and USDC next to your FIRO. One key for both chains.' }),
    ),
    h('div', { class: 'card flat' }, h('p', { class: 'small', text: 'It has its own recovery words, separate from your Firo words. Your Firo wallet is not changed.' })),
  );
  return { el };
}
