// Native integration check: real built UI + isolated real host/catalog storage.
// Readiness is signalled by IPC/DOM changes; timeouts are failure bounds only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { waitFor, click, openManager } = require('./browser.cjs');

exports.check = async ({ window, controller, live, profile }) => {
  const initialViews = window.contentView.children.length;
  const command = (value) =>
    window.webContents.executeJavaScript(`window.moorAcceptance.command(${JSON.stringify(value)})`);
  const ready = async () => {
    const snapshot = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      let unsubscribe;
      const timer = setTimeout(() => { unsubscribe?.(); reject(new Error('验收准备超时')); }, 25000);
      const check = (state) => {
        if (['ready', 'failed', 'stopped'].includes(state.run?.status)) {
          clearTimeout(timer); unsubscribe?.(); resolve(state);
        }
      };
      unsubscribe = window.moorAcceptance.subscribe(check);
      window.moorAcceptance.snapshot().then(check);
    })`);
    assert.equal(snapshot.run.status, 'ready', snapshot.run.error);
    return snapshot.run;
  };
  const capture = async (name) => {
    // Capture after readiness makes the native child view visible. A hidden
    // WebContentsView has no display surface on macOS.
    const contents = live.get(controller.snapshot().run.id).view.webContents;
    await contents.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    );
    fs.writeFileSync(
      path.join(profile, name + '-preview.png'),
      (await contents.capturePage()).toPNG(),
    );
    fs.writeFileSync(
      path.join(profile, name + '-workbench.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
  };
  assert.equal(controller.snapshot().run, undefined, 'opening workbench does not start work');
  await command({ type: 'prepare', sceneId: 'narrow-dialog' });
  let run = await ready();
  let contents = live.get(run.id).view.webContents;
  assert.equal(run.scope.sessionId, 'acceptance-modal');
  const geometry = await contents.executeJavaScript(`(() => {
    const dialog = document.querySelector('#workspace-dialog');
    const rect = dialog.getBoundingClientRect();
    return { width: innerWidth, open: dialog.open, left: rect.left, right: rect.right,
      documentWidth: document.documentElement.scrollWidth, ipc: typeof window.moorAcceptance,
      node: typeof window.require };
  })()`);
  assert.equal(geometry.width, 390);
  assert.equal(geometry.open, true);
  assert(geometry.left >= 0 && geometry.right <= 391, 'narrow dialog stays inside the viewport');
  assert(geometry.documentWidth <= 391, 'narrow preview has no page-wide horizontal overflow');
  assert.equal(geometry.ipc, 'undefined', 'preview cannot access workbench IPC');
  assert.equal(geometry.node, 'undefined', 'preview has no Node access');
  await capture('narrow-dialog');
  await click(contents, '#close-workspace-dialog');
  await waitFor(contents, `!document.querySelector('#workspace-dialog').open`);
  const previous = run.id;
  await command({ type: 'reset', runId: previous });
  run = await ready();
  assert.notEqual(run.id, previous);
  assert.equal(contents.isDestroyed(), true, 'reset disposes the old browser');
  assert.equal(live.size, 1);
  assert.equal(
    window.contentView.children.length,
    initialViews + 1,
    'reset removes the old native view',
  );
  await assert.rejects(command({ type: 'accept', runId: previous }), /现场已改变/);
  contents = live.get(run.id).view.webContents;
  assert.equal(
    await contents.executeJavaScript(`document.querySelector('#workspace-dialog').open`),
    true,
  );
  console.log('narrow dialog, reset and stale-run rejection: passed');

  await command({ type: 'prepare', sceneId: 'settings-save' });
  run = await ready();
  contents = live.get(run.id).view.webContents;
  assert.equal(run.scope.sessionId, 'acceptance-settings');
  assert.equal(
    await contents.executeJavaScript(`document.querySelector('#rename-workspace input').value`),
    '验收后的工作区',
  );
  await capture('settings-save');
  await click(contents, '#rename-workspace button');
  await waitFor(
    contents,
    `document.querySelector('.workspace-picker').textContent.includes('验收后的工作区')`,
  );
  const saved = await contents.executeJavaScript(
    `fetch('/api/workspaces').then(r => r.json()).then(rows => rows[0].name)`,
  );
  assert.equal(saved, '验收后的工作区', 'UI save reaches the real catalog');
  const reloaded = once(contents, 'did-finish-load');
  contents.reload();
  await reloaded;
  await waitFor(
    contents,
    `document.querySelector('.workspace-picker')?.textContent.includes('验收后的工作区')`,
  );
  await openManager(contents, false);
  assert.equal(
    await contents.executeJavaScript(`document.querySelector('#rename-workspace input').value`),
    '验收后的工作区',
  );
  await command({ type: 'feedback', runId: run.id, text: '合成反馈：保存后希望有更明确的提示。' });
  assert.equal(controller.snapshot().run.decision, 'changes_requested');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(profile, run.id + '.json'))).feedback,
    '合成反馈：保存后希望有更明确的提示。',
  );
  await command({ type: 'accept', runId: run.id });
  assert.equal(controller.snapshot().run.decision, 'accepted');
  await command({ type: 'reset', runId: run.id });
  run = await ready();
  contents = live.get(run.id).view.webContents;
  assert.equal(
    await contents.executeJavaScript(
      `fetch('/api/workspaces').then(r => r.json()).then(rows => rows[0].name === '验收后的工作区')`,
    ),
    false,
  );
  assert.equal(run.decision, undefined, 'acceptance never carries to a new run');
  console.log('settings save, reload persistence, scoped feedback and fixture reset: passed');

  await command({ type: 'prepare', sceneId: 'session-drawer' });
  run = await ready();
  contents = live.get(run.id).view.webContents;
  assert.equal(run.scope.sessionId, 'acceptance-session');
  assert.equal(
    await contents.executeJavaScript(
      `document.querySelector('#navigation').hasAttribute('data-open')`,
    ),
    true,
  );
  await capture('session-drawer');
  await click(contents, '#sessions .session-title', '设置保存验收');
  await waitFor(
    contents,
    `!document.querySelector('#navigation').hasAttribute('data-open') && document.querySelector('#history')?.textContent.includes('修改工作区名称')`,
  );
  await click(contents, '#nav-toggle');
  await waitFor(contents, `document.querySelector('#navigation').hasAttribute('data-open')`);
  assert.equal(
    await contents.executeJavaScript(
      `document.querySelector('#sessions [aria-current="page"] .session-title').textContent`,
    ),
    '设置保存验收',
  );
  await command({ type: 'stop', runId: run.id });
  assert.equal(controller.snapshot().run.status, 'stopped');
  assert.equal(live.size, 0);
  assert.equal(
    window.contentView.children.length,
    initialViews,
    'stop restores the initial native views',
  );
  assert.equal(contents.isDestroyed(), true);
  console.log('session navigation and owned-resource cleanup: passed');
  console.log('Acceptance screenshots: ' + profile);
};
