// screens/eth_review.js for a screen test: each review sheet opened is recorded (the screen it opened
// over) and stays open until the test closes it (sheets[i].close()).
export const reviewSheets = [];

export function openEthReview(app, _w, prepared) {
  let onClose = null;
  const s = {
    over: app.currentName,
    prepared,
    closed: false,
    close(v) {
      if (s.closed) return;
      s.closed = true;
      if (onClose) onClose(v);
    },
    then(fn) {
      onClose = fn;
    },
  };
  reviewSheets.push(s);
  return s;
}
