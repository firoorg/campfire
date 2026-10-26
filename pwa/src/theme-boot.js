// Settings -> Theme, set before the first paint so the start screen is already light or dark as
// chosen (index.html loads this before the stylesheets). The rest is lib/theme.js, which uses the
// same key: test/unit/theme.test.mjs checks they agree.
(function () {
  try {
    var t = localStorage.getItem('campfire-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    /* storage blocked: the device's own light or dark */
  }
})();
