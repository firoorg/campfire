// How guessable a password is, decided on this device, with nothing downloaded (audit A-3).
//
// The password is all that stands between a copy of this browser's data and the wallet: whoever has
// the copy (an infostealer, a backup, a second-hand disk) can try passwords offline for as long as
// they like. PBKDF2-SHA256 at 600,000 rounds makes each try cost something (about 15,000 a second
// on one gaming graphics card), but a list of leaked passwords still falls in minutes. So a password
// must be long enough and must not be one of the first things such a search tries:
//   - one of the most common passwords, also with numbers or symbols around it or look-alike
//     digits inside it (P@ssw0rd2024!);
//   - runs: abcd, 1234, keyboard rows and columns (qwerty, 1qaz2wsx), either way round;
//   - the same few characters, or one part repeated;
//   - digits alone (a date, a phone number) unless very long.
// That is not a full estimate (zxcvbn ships 400 KB of dictionaries); it turns away the passwords a
// cracker tries first. A passphrase of a few ordinary words passes: common words inside a long one
// are fine.

export const MIN_PASSWORD = 10;
/** From this length a password counts as a passphrase: a common word inside it is fine. */
export const PASSPHRASE_LENGTH = 20;
/** Digits alone, fewer than this many: a date or a phone number. */
const DIGITS_ONLY_MIN = 16;

const WORDS_HINT = 'Try a few unrelated words.';
export const WEAKNESS_TEXT = Object.freeze({
  short: (min) => `Use at least ${min} characters.`,
  common: `This is one of the most common passwords, even with numbers or symbols added. ${WORDS_HINT}`,
  run: `Runs like abcd, 1234 or qwerty are among the first guesses. ${WORDS_HINT}`,
  repeat: `It repeats the same few characters, which is quick to guess. ${WORDS_HINT}`,
  digits: 'Numbers alone (a date, a phone number) are quick to guess. Add a few words.',
});

// The most used passwords and their bases, letters only (from the published leak lists: SplashData,
// NordPass, RockYou's top), plus the words this app invites (firo, campfire, wallet...).
const COMMON = new Set(
  `password passwd passw pass passport qwerty qwertz azerty asdf asdfgh zxcvbn abc abcd abcde abcdef iloveyou loveyou ilove love lovely lover
  admin administrator root login guest user test testing default changeme letmein welcome hello secret private access master trustno
  monkey dragon shadow sunshine princess flower butterfly rainbow angel baby babygirl freedom whatever nothing blink cheese cookie
  chocolate banana orange purple pepper ginger tigger snoopy maggie buster killer hunter ranger summer winter spring autumn
  football soccer baseball basketball hockey liverpool arsenal chelsea barcelona juventus manchester yankees cowboys lakers
  pokemon starwars batman superman spiderman naruto minecraft fortnite matrix harley mustang ferrari porsche corvette
  computer internet samsung apple google facebook instagram iphone
  michael jennifer jessica daniel thomas robert matthew ashley nicole andrew joshua charlie jordan hannah william anthony amanda justin
  michelle george maria anna alexander
  january february march april june july august september october november december monday friday
  bitcoin crypto ethereum wallet satoshi blockchain moon lambo hodl firo zcoin spark campfire privacy money cash coin coins beam
  passwort motdepasse contrasena senha parola haslo parol jetaime teamo tequiero amore schatz hallo bonjour ciao`.split(/\s+/).filter(Boolean),
);

// Keyboard rows, columns and zigzags (QWERTY, QWERTZ, AZERTY), the alphabet and the digits.
const RUNS = [
  'abcdefghijklmnopqrstuvwxyz',
  '01234567890',
  '`1234567890-=',
  'qwertyuiop[]\\',
  "asdfghjkl;'",
  'zxcvbnm,./',
  'qwertzuiop',
  'yxcvbnm',
  'azertyuiop',
  'qsdfghjklm',
  'wxcvbn',
  '1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik,9ol.0p;/',
  'qazwsxedcrfvtgbyhnujmikolp',
  'zaq12wsxcde34rfvbgt56yhnmju78ik,.lo90p;/',
  '1q2w3e4r5t6y7u8i9o0p',
  'q1w2e3r4t5y6u7i8o9p0',
  'a1b2c3d4e5f6g7h8i9j0',
];
const SEQS = RUNS.flatMap((r) => [r, [...r].reverse().join('')]);

// Look-alike digits and symbols back to letters (P@ssw0rd -> password).
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'l', '+': 't' };

/** The longest predictable run starting at s[i]: one character again and again, or part of RUNS. */
function runAt(s, i) {
  let best = 1;
  let j = i + 1;
  while (j < s.length && s[j] === s[i]) j++;
  best = j - i;
  for (const q of SEQS) {
    for (let k = q.indexOf(s[i]); k !== -1; k = q.indexOf(s[i], k + 1)) {
      let n = 1;
      while (i + n < s.length && q[k + n] === s[i + n]) n++;
      if (n > best) best = n;
    }
  }
  return best;
}

/** How many characters of s sit in runs of 3 or more. */
function inRuns(s) {
  let covered = 0;
  for (let i = 0; i < s.length; ) {
    const n = runAt(s, i);
    if (n >= 3) {
      covered += n;
      i += n;
    } else i++;
  }
  return covered;
}

const repeated = (s) => /^(.+?)\1+$/su.exec(s);
const COMMON_LONG = [...COMMON].filter((w) => w.length >= 4);
const isCommon = (w) => w.length >= 3 && (COMMON.has(w) || Boolean(repeated(w) && COMMON.has(repeated(w)[1])));

/**
 * Whether a password is built on a common word: what is left without the numbers and symbols
 * around it, look-alikes undone (P@ssw0rd2024! -> password), or all its letters (P-a-s-s-1 ->
 * pass...), is a common word or one repeated; or that word is one piece with up to 3 letters
 * more (mypassword, iloveyoumom). Letters scattered between random digits and symbols are not
 * read as a word.
 */
function builtOnCommon(lower) {
  const middle = [...lower.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')].map((c) => LEET[c] || c).join('');
  const word = middle.replace(/[^\p{L}]/gu, '');
  if (isCommon(word) || isCommon(lower.replace(/[^\p{L}]/gu, ''))) return true;
  return /^\p{L}+$/u.test(middle) && COMMON_LONG.some((c) => middle.length - c.length <= 3 && middle.includes(c));
}

/**
 * null when `pw` is good enough, else { code, text } with what to change in plain words:
 * code 'short' | 'common' | 'run' | 'repeat' | 'digits'. min: the shortest allowed (a file kept in
 * the cloud asks for more).
 */
export function passwordWeakness(pw, { min = MIN_PASSWORD } = {}) {
  const s = String(pw || '').normalize('NFC');
  const chars = [...s];
  const n = chars.length;
  if (n < min) return { code: 'short', text: WEAKNESS_TEXT.short(min) };
  const lower = s.toLowerCase();
  const stripped = lower.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
  if (new Set(chars.map((c) => c.toLowerCase())).size < 4 || repeated(lower) || (stripped.length >= 6 && repeated(stripped))) return { code: 'repeat', text: WEAKNESS_TEXT.repeat };
  if (/^[\d\s./-]+$/.test(s) && s.replace(/\D/g, '').length < DIGITS_ONLY_MIN) {
    // A run of digits (1234567890) says so; any other digits are a date or a number.
    return n - inRuns(lower) < 4 ? { code: 'run', text: WEAKNESS_TEXT.run } : { code: 'digits', text: WEAKNESS_TEXT.digits };
  }
  if (n - inRuns(lower) < 4) return { code: 'run', text: WEAKNESS_TEXT.run };
  if (n < PASSPHRASE_LENGTH && builtOnCommon(lower)) return { code: 'common', text: WEAKNESS_TEXT.common };
  return null;
}
