// Keep this entry independent of the large application/WASM bundle so failures
// can be displayed even when that bundle never downloads or evaluates.
const root = document.getElementById('app');
let ready = false;
function failed(message) {
  if (ready) return;
  root.replaceChildren();
  const title = document.createElement('h1');
  title.textContent = 'Moor 暂时无法打开';
  const description = document.createElement('p');
  description.textContent = message;
  const retry = document.createElement('button');
  retry.textContent = '重新加载';
  retry.onclick = () => location.reload();
  root.append(title, description, retry);
}
const timer = setTimeout(
  () =>
    failed('加载超时。请检查网络后重试；Mac 上也可通过 Moor 菜单打开“本机工作区”或“连接设置”。'),
  15000,
);
window.addEventListener(
  'moor:ready',
  () => {
    ready = true;
    clearTimeout(timer);
  },
  { once: true },
);
import('/app.js').catch(() => {
  clearTimeout(timer);
  failed('界面组件加载失败。请重新加载；若持续失败，请检查网络或更新 Moor。');
});
