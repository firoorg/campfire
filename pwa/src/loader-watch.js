// The tripwire's first watch (lib/loader.js watchLoader is the rest), loaded by index.html before
// anything else and before every module of the app.
//
// A loader (sw-<hash>.js) never changes its bytes under its name: the name is their hash. Other
// bytes there mean the web address serves code Campfire did not sign, and the browser installs
// them without asking anyone. Such a worker can take over a page that is still starting; every
// module the page has not loaded yet then comes from it, so the app's own watch, which starts
// after its last module, would never run. This script runs first and records, from the start:
// the loader that served this page, every change of the loader controlling it, and every new
// loader installing (window.__campfireLoaderWatch; watchLoader replays it and follows it).
//
// One case needs no knowledge of this release: the loader at the very address that served this
// page installs again or takes over. If that happens before the app has started its own watch,
// this script stops the page at once and says why, in plain DOM (nothing else of the page may
// load: it would come from that code). Once the app watches, the app decides and shows its own
// screen. Best effort: a takeover that lands before this file was fetched serves this file too.
(function () {
  'use strict';
  var sw = navigator.serviceWorker;
  if (!sw || window.__campfireLoaderWatch) return;
  var initial = sw.controller ? sw.controller.scriptURL : null;
  var events = [];
  var subscribers = [];
  var stopped = false;

  var WARNING = "This app's web address is serving code Campfire did not sign. Don't enter your password here.";

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function stopPage() {
    if (stopped) return;
    stopped = true;
    try {
      window.stop(); // no further file of this page: it would come from the new code
    } catch (e) {
      /* already loaded */
    }
    var body = document.body || document.documentElement.appendChild(document.createElement('body'));
    var main = el('main', 'screen tripwire');
    main.setAttribute('data-testid', 'tripwire-early');
    var content = el('div', 'content');
    content.appendChild(el('h2', 'title', 'Stop: unsigned code'));
    var n = el('div', 'notice error');
    n.setAttribute('role', 'alert');
    var g = el('div', 'grow');
    g.appendChild(el('strong', null, WARNING));
    g.appendChild(document.createTextNode(' Campfire stopped before opening.'));
    n.appendChild(g);
    content.appendChild(n);
    content.appendChild(el('p', 'lead', 'Your coins are on the Firo blockchain, not in this app. Open them in the Campfire app or another Firo wallet with your recovery words, or with your encrypted backup file and its password.'));
    content.appendChild(el('p', 'small', 'Close this app now. Do not reopen it from the same address or enter any password or words in it.'));
    main.appendChild(content);
    while (body.firstChild) body.removeChild(body.firstChild);
    body.appendChild(main);
  }

  function emit(type, url) {
    var ev = { type: type, url: url || null, at: Date.now() };
    events.push(ev);
    // Not yet watched by the app: an unmistakable takeover stops the page here.
    if (!subscribers.length && initial && ev.url === initial) stopPage();
    for (var i = 0; i < subscribers.length; i++) {
      try {
        subscribers[i](ev);
      } catch (e) {
        /* one watcher's error is not this one's */
      }
    }
  }

  sw.addEventListener('controllerchange', function () {
    emit('controllerchange', sw.controller ? sw.controller.scriptURL : null);
  });
  sw.getRegistration().then(
    function (reg) {
      if (!reg) return;
      if (reg.installing) emit('installing', reg.installing.scriptURL);
      if (reg.waiting) emit('waiting', reg.waiting.scriptURL);
      reg.addEventListener('updatefound', function () {
        if (reg.installing) emit('updatefound', reg.installing.scriptURL);
      });
    },
    function () {},
  );

  Object.defineProperty(window, '__campfireLoaderWatch', {
    value: Object.freeze({
      // The loader that served this page (null: the page came from the network).
      initial: initial,
      // Whether this script already stopped the page.
      stopped: function () {
        return stopped;
      },
      // fn(event) for every event so far, then for each new one: {type, url, at}.
      subscribe: function (fn) {
        for (var i = 0; i < events.length; i++) fn(events[i]);
        subscribers.push(fn);
      },
    }),
  });
})();
