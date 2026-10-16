/* Confirm words (create, step 2 of 3)
 * Spec: ONE job: prove the words were written down (3 of them, picked at random).
 *       Primary CTA: "Confirm words".
 *       Taps from app open: 2 (+3 word taps).
 * Exit-intent reasons and answers:
 *   - "Typing 24 words is tedious" -> only 3 words, tap to pick, no typing.
 *   - "I got one wrong" -> says which one, offers to show the words again; never blames.
 */
import { h, put } from '../lib/dom.js';
import { screen, primary, notice, textButton } from '../lib/ui.js';

function randInt(n) {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % n;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Three of `words`, at random positions, each to pick among four: {groups,
 * check()} where check() is the first position (0-based) picked wrong, or -1.
 * onChange(ready) says whether all three are picked. Also used for the
 * Ethereum wallet's words (screens/eth_confirm.js).
 */
export function wordQuiz(words, onChange) {
  const positions = shuffle([...Array(words.length).keys()]).slice(0, 3).sort((a, b) => a - b);
  const chosen = new Map();
  const groups = positions.map((pos) => {
    const others = shuffle([...new Set(words.filter((w) => w !== words[pos]))]).slice(0, 3);
    const options = shuffle([words[pos], ...others]);
    const buttons = options.map((w) =>
      h('button', {
        class: 'choice',
        'data-word': w,
        onclick: (e) => {
          chosen.set(pos, w);
          for (const b of e.currentTarget.parentElement.children) b.classList.toggle('on', b === e.currentTarget);
          onChange(chosen.size === positions.length);
        },
      }, w),
    );
    return h('div', { class: 'card flat', 'data-position': String(pos + 1) }, h('h3', { text: `Word #${pos + 1}` }), h('div', { class: 'choices' }, ...buttons));
  });
  const check = () => {
    const wrong = positions.find((p) => chosen.get(p) !== words[p]);
    return wrong === undefined ? -1 : wrong;
  };
  return { groups, check };
}

export default function confirmWords(app) {
  const words = app.setup && app.setup.words;
  if (!words) {
    queueMicrotask(() => app.go('welcome'));
    return { el: h('div') };
  }
  const err = h('div');
  const cta = primary('Confirm words', check, { disabled: true, 'data-testid': 'confirm-words' });
  const quiz = wordQuiz(words, (ready) => {
    put(err);
    cta.disabled = !ready;
  });

  function check() {
    const wrong = quiz.check();
    if (wrong >= 0) {
      put(err, notice('error', `That's not word #${wrong + 1}. Check your paper and pick again.`));
      return;
    }
    app.go('setPassword');
  }

  const el = screen(
    { title: 'Check your words', back: () => app.go('backup'), actions: [cta, textButton('Show the words again', () => app.go('backup'))] },
    h('p', { class: 'step', text: 'Step 2 of 3' }),
    h('p', { class: 'lead', text: 'Pick these three words from your paper.' }),
    ...quiz.groups,
    err,
  );
  return { el };
}
