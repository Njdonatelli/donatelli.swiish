// System / Light / Dark. The choice lives in localStorage (per browser, not per account) and on <html>
// as data-theme, which admin.css reads.
const KEY = 'dt-theme';

export function readTheme() {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch (e) {
    return 'system';
  }
}

export function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice);
  else root.removeAttribute('data-theme');
}

export function saveTheme(choice) {
  applyTheme(choice);
  try {
    if (choice === 'light' || choice === 'dark') window.localStorage.setItem(KEY, choice);
    else window.localStorage.removeItem(KEY);
  } catch (e) {
    // Storage can be off (private window); the theme still applies for this page load.
  }
}
