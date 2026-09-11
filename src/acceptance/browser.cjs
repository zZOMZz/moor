// Only locally authored scene recipes call these helpers. No renderer IPC can
// supply JavaScript, selectors, URLs or browser protocol commands.
async function waitFor(contents, expression) {
  return contents.executeJavaScript(`new Promise((resolve, reject) => {
    let observer;
    const finish = (error) => {
      clearTimeout(timer);
      observer?.disconnect();
      error ? reject(error) : resolve(true);
    };
    const check = () => {
      try { if (${expression}) { finish(); return true; } }
      catch (error) { finish(error); return true; }
      return false;
    };
    const timer = setTimeout(() => finish(new Error('页面未到达指定的验收位置，请检查构建后重新准备。')), 15000);
    if (!check()) {
      observer = new MutationObserver(check);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    }
  })`);
}
async function click(contents, selector, text) {
  const target = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el => ${text === undefined ? 'true' : `el.textContent.trim() === ${JSON.stringify(text)}`})`;
  await waitFor(contents, `!!(${target})`);
  await contents.executeJavaScript(`(() => {
    const el = ${target};
    if (!el || el.disabled) throw new Error('验收步骤中的控件不可用。');
    el.scrollIntoView({ block: 'nearest' });
    el.click();
  })()`);
}
async function openManager(contents, mobile) {
  if (mobile) {
    await click(contents, '#nav-toggle');
    await waitFor(contents, `document.querySelector('#navigation')?.hasAttribute('data-open')`);
  }
  await click(contents, '[aria-label="设置与账号"]');
  await click(contents, '[role="menuitem"]', '管理工作区');
  await waitFor(
    contents,
    `document.querySelector('#workspace-dialog')?.open && !!document.querySelector('#rename-workspace input')`,
  );
}
async function prepareScene(contents, scene) {
  await waitFor(
    contents,
    `!!document.querySelector('#sessions .session') && !!document.querySelector('#new:not(:disabled)')`,
  );
  // Selecting a session is a read-only preparation. No prompt is sent.
  await click(contents, '#sessions .session-title', scene.title + '验收');
  const expected = {
    'narrow-dialog': '检查窄屏下的设置弹窗',
    'settings-save': '修改工作区名称',
    'session-drawer': '检查会话抽屉',
  }[scene.id];
  await waitFor(
    contents,
    `document.querySelector('#history')?.textContent.includes(${JSON.stringify(expected)}) && !document.querySelector('#composer')?.hidden`,
  );
  if (scene.id === 'session-drawer') {
    await click(contents, '#nav-toggle');
    await waitFor(contents, `document.querySelector('#navigation')?.hasAttribute('data-open')`);
  } else {
    await openManager(contents, scene.width < 761);
    if (scene.id === 'settings-save') {
      await contents.executeJavaScript(`(() => {
        const field = document.querySelector('#rename-workspace input');
        field.value = '验收后的工作区';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.focus();
        field.select();
      })()`);
    }
  }
  // Automation ends here. Keep this same document/browser alive for the user.
}
exports.waitFor = waitFor;
exports.click = click;
exports.openManager = openManager;
exports.prepareScene = prepareScene;
