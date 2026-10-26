// @ts-check
// The popup's and the side panel's text in the browser's language (_locales/en, _locales/zh_TW; English otherwise).
// msg(key, ...values) fills {0}, {1}… itself, so a value can never be read as a Chrome substitution ($1, $name$).
// Elements with data-i18n get their text here; values from the bridge or pages are set with textContent elsewhere.

/** @param {string} key @param {...unknown} values */
function msg(key, ...values) {
  const m = chrome.i18n.getMessage(key);
  if (!m) return key;
  return m.replace(/\{(\d)\}/g, (_, i) => String(values[Number(i)] ?? ''));
}

if (typeof document.querySelectorAll === 'function') {
  document.documentElement.lang = msg('lang');
  document.querySelectorAll('[data-i18n]').forEach((e) => { e.textContent = msg(/** @type {HTMLElement} */ (e).dataset.i18n ?? ''); });
}
