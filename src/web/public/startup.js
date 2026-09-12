// Keep this entry independent of the large application/WASM bundle so failures
// can be displayed even when that bundle never downloads or evaluates.
const root = document.getElementById('app');
try {
  const appearance = localStorage.getItem('moor-appearance');
  if (['light', 'dark', 'system'].includes(appearance))
    document.documentElement.dataset.theme = appearance;
} catch {
  // The system theme also works when browser storage is unavailable.
}
const systemAppearance = window.matchMedia?.('(prefers-color-scheme: dark)');
function updateThemeColor() {
  const appearance = document.documentElement.dataset.theme;
  const dark = appearance === 'dark' || (appearance !== 'light' && systemAppearance?.matches);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#191919' : '#ffffff');
}
updateThemeColor();
systemAppearance?.addEventListener('change', updateThemeColor);
new window.MutationObserver(updateThemeColor).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme'],
});
let ready = false;
function failed(message) {
  if (ready) return;
  root.replaceChildren();
  const panel = document.createElement('main');
  panel.className = 'startup-failure';
  const title = document.createElement('h1');
  title.textContent = 'Moor 暂时无法打开';
  const description = document.createElement('p');
  description.textContent = message;
  const retry = document.createElement('button');
  retry.textContent = '重新加载';
  retry.onclick = () => location.reload();
  panel.append(title, description, retry);
  root.append(panel);
}
const timer = setTimeout(() => {
  if (ready) return;
  const status = document.getElementById('startup-status');
  if (!status) return;
  status.textContent = '连接时间较长，仍在加载。你也可以重新加载页面。';
  const retry = document.createElement('button');
  retry.textContent = '重新加载';
  retry.onclick = () => location.reload();
  status.parentElement.append(retry);
}, 15000);
window.addEventListener(
  'moor:ready',
  () => {
    ready = true;
    clearTimeout(timer);
  },
  { once: true },
);
import('__ENTRY__')
  .then((entry) => entry.start())
  .catch(() => {
    clearTimeout(timer);
    failed('界面组件加载失败。请重新加载；若持续失败，请检查网络或更新 Moor。');
  });
