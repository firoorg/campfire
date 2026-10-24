// Settings -> Appearance -> Language, before the first paint: <html lang> is the language the app will
// show (Chinese, Japanese and Korean characters are drawn by it, from the start screen on), and the
// splash in index.html says "Starting…" in it. Its two texts per language live in this signed file
// (equal to the catalogs: test/unit/i18n.test.mjs), never in storage: only the language choice is read
// from there. The rest is lib/i18n.js, which uses the same key and the same reading of the device's
// languages: test/unit/i18n.test.mjs checks they agree.
(function () {
  var LANGS = ['en', 'es', 'pt-BR', 'fr', 'de', 'tr', 'ru', 'zh-Hans', 'ja', 'ko', 'vi'];
  var BASES = { en: 'en', es: 'es', pt: 'pt-BR', fr: 'fr', de: 'de', tr: 'tr', ru: 'ru', zh: 'zh-Hans', ja: 'ja', ko: 'ko', vi: 'vi' };
  function device() {
    var list = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || '']) || [];
    for (var i = 0; i < list.length; i++) {
      var base = String(list[i] || '').toLowerCase().split(/[-_]/)[0];
      if (Object.prototype.hasOwnProperty.call(BASES, base)) return BASES[base];
    }
    return 'en';
  }
  var lang = null;
  try {
    var c = localStorage.getItem('campfire-lang');
    if (LANGS.indexOf(c) >= 0) lang = c;
  } catch (e) {
    /* storage blocked: like this device */
  }
  if (!lang) lang = device();
  document.documentElement.setAttribute('lang', lang);
  if (lang === 'en') return;
  var TEXTS = {
    "es": {
      "Starting Firo PWA…": "Iniciando Firo PWA…",
      "Starting": "Iniciando"
    },
    "pt-BR": {
      "Starting Firo PWA…": "Iniciando o Firo PWA…",
      "Starting": "Iniciando"
    },
    "fr": {
      "Starting Firo PWA…": "Démarrage de Firo PWA…",
      "Starting": "Démarrage"
    },
    "de": {
      "Starting Firo PWA…": "Firo PWA startet…",
      "Starting": "Startet"
    },
    "tr": {
      "Starting Firo PWA…": "Firo PWA başlatılıyor…",
      "Starting": "Başlatılıyor"
    },
    "ru": {
      "Starting Firo PWA…": "Запуск Firo PWA…",
      "Starting": "Запуск"
    },
    "zh-Hans": {
      "Starting Firo PWA…": "正在启动 Firo PWA…",
      "Starting": "正在启动"
    },
    "ja": {
      "Starting Firo PWA…": "Firo PWAを起動しています…",
      "Starting": "起動中"
    },
    "ko": {
      "Starting Firo PWA…": "Firo PWA 시작 중…",
      "Starting": "시작 중"
    },
    "vi": {
      "Starting Firo PWA…": "Đang khởi động Firo PWA…",
      "Starting": "Đang khởi động"
    }
  };
  var words = TEXTS[lang];
  if (!words) return;
  function tr(text) {
    return Object.prototype.hasOwnProperty.call(words, text) ? words[text] : text;
  }
  // Text only (textContent, an attribute): nothing kept here can become markup.
  document.addEventListener('DOMContentLoaded', function () {
    var p = document.querySelector('#app .splash .hero p');
    if (p) p.textContent = tr('Starting Firo PWA…');
    var bar = document.querySelector('#app .splash [role="progressbar"]');
    if (bar) bar.setAttribute('aria-label', tr('Starting'));
  });
})();
