// The password / Face ID sheet, as a screen test drives it: each one asked for is recorded (its
// words, the screen it opened over) and answers when the test says (sheets.answer). The app
// stand-in (stand_ins/app.mjs) dismisses the open ones when it moves to another screen, as the real
// app.go does: they answer false.
export const sheets = [];

export function confirmIdentity(app, opts = {}) {
  return new Promise((resolve) => {
    sheets.push({ opts, over: app.currentName, open: true, resolve });
  });
}

/** Says yes (or no) to sheet i, if it is still open. */
export function answer(i, yes = true) {
  const s = sheets[i];
  if (!s || !s.open) return false;
  s.open = false;
  s.resolve(yes);
  return true;
}

export function dismissAll() {
  for (const s of sheets) if (s.open) answer(sheets.indexOf(s), false);
}

export const openSheets = () => sheets.filter((s) => s.open);
export const NOT_SAVED_TEXT = '';
export const FACE_ID_HINT = '';
export const notSavedNote = () => null;
