/* Ethereum words (create, step 1 of 3)
 * Spec: ONE job: write down the Ethereum wallet's 12 words.
 *       Primary CTA: "I wrote them down" (enabled once the words are shown).
 *       Taps from app open: 2 (Home -> Ethereum -> Create).
 * Exit-intent reasons and answers:
 *   - "More words? I already wrote mine" -> said plainly: these are different from the Firo words,
 *     and only they bring the Ethereum wallet back.
 *   - "Someone could see my screen" -> blurred until tapped (the same grid as the Firo words).
 *   - "Can I screenshot it?" -> no, and why (photos sync to the cloud).
 *   - "Can I see them later?" -> no: they are never stored; said here, before the person moves on.
 */
import { h } from '../lib/dom.js';
import { screen, primary, notice } from '../lib/ui.js';
import { wordReveal } from './backup.js';
import { newMnemonic } from '../lib/eth/crypto.js';

export default function ethWords(app) {
  if (!app.ethSetup || app.ethSetup.mode !== 'create') app.ethSetup = { mode: 'create', from: 'home' };
  if (!app.ethSetup.words) app.ethSetup.words = newMnemonic(12).split(' ');
  const cta = primary('I wrote them down', () => app.go('ethConfirm'), { disabled: true, 'data-testid': 'eth-wrote-down' });
  const reveal = wordReveal(() => (cta.disabled = false));
  reveal.fill(app.ethSetup.words);
  const leave = () => {
    app.ethSetup.words.fill('');
    const from = app.ethSetup.from;
    app.ethSetup = null;
    app.back('ethStart', { from });
  };
  const el = screen(
    { title: 'Your Ethereum words', back: leave, actions: [cta] },
    h('p', { class: 'step', text: 'Step 1 of 3' }),
    h('p', { class: 'lead', text: 'These 12 words are your Ethereum wallet. They are not your Firo words: write these down too.' }),
    notice('warn', h('strong', { text: 'Write them on paper, in order. ' }), 'Anyone who sees them can take your Ethereum coins. No screenshots: photos sync to the cloud.'),
    reveal.el,
    h('p', { class: 'small', text: 'Campfire does not keep these words, so it cannot show them again.' }),
  );
  return { el };
}
