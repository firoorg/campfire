/* Check the Ethereum words (create, step 2 of 3)
 * Spec: ONE job: prove the Ethereum words were written down (3 of them, picked at random).
 *       Primary CTA: "Confirm words".
 *       Taps from app open: 3 (+3 word taps).
 * Exit-intent reasons and answers:
 *   - "Typing words is tedious" -> three words, tap to pick, no typing (the same quiz as the Firo words).
 *   - "I got one wrong" -> says which one, offers to show the words again; never blames.
 */
import { h, put } from '../lib/dom.js';
import { screen, primary, notice, textButton } from '../lib/ui.js';
import { wordQuiz } from './confirm_words.js';
import { t } from '../lib/i18n.js';

export default function ethConfirm(app) {
  const words = app.ethSetup && app.ethSetup.mode === 'create' && app.ethSetup.words;
  if (!words) {
    queueMicrotask(() => app.go('ethStart'));
    return { el: h('div') };
  }
  const err = h('div');
  const cta = primary(t('Confirm words'), check, { disabled: true, 'data-testid': 'eth-confirm-words' });
  const quiz = wordQuiz(words, (ready) => {
    put(err);
    cta.disabled = !ready;
  });

  function check() {
    const wrong = quiz.check();
    if (wrong >= 0) {
      put(err, notice('error', t('That\'s not word #{n}. Check your paper and pick again.', { n: wrong + 1 })));
      return;
    }
    app.go('ethPrivacy', { setup: true });
  }

  const el = screen(
    { title: t('Check your Ethereum words'), back: () => app.go('ethWords'), actions: [cta, textButton(t('Show the words again'), () => app.go('ethWords'))] },
    h('p', { class: 'step', text: t('Step 2 of 3') }),
    h('p', { class: 'lead', text: t('Pick these three words from your paper.') }),
    ...quiz.groups,
    err,
  );
  return { el };
}
