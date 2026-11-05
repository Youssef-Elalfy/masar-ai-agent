// Applies the saved language and theme before first paint (no dark→light flash). Same storage key and rules as
// client/src/state/settings.ts; a separate file because the CSP forbids inline scripts.
(function () {
  var html = document.documentElement;
  var lang = navigator.language.toLowerCase().indexOf('en') === 0 ? 'en' : 'ar';
  var theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  try {
    var saved = JSON.parse(localStorage.getItem('rahhal.settings.v1') || 'null');
    if (saved && (saved.lang === 'en' || saved.lang === 'ar')) lang = saved.lang;
    if (saved && (saved.theme === 'light' || saved.theme === 'dark')) theme = saved.theme;
  } catch (e) {
    // storage blocked: system defaults
  }
  html.lang = lang;
  html.dir = lang === 'ar' ? 'rtl' : 'ltr';
  html.setAttribute('data-theme', theme);
})();
