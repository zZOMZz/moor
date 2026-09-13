// Real trusted Electron client, encrypted Relay/Host, real temporary Git and an injected native Agent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runSecureNative = require('../tests/support/secure-native-client.cjs');
runSecureNative({ name: 'workspaces', workspaces: true }, async (native) => {
  const {
    fixture,
    profile,
    requests,
    errors,
    window,
    js,
    waitFor,
    text,
    click,
    fill,
    connectProject,
    openSession,
    CLIENT_URL,
  } = native;
  const enabled = (label) =>
    waitFor(
      `[...document.querySelectorAll('button')].some(node=>node.textContent.trim()===${JSON.stringify(label)}&&!node.disabled)`,
    );
  const press = async (label) => {
    await enabled(label);
    await click(label);
  };
  const aria = async (label) => {
    await waitFor(
      `[...document.querySelectorAll('button')].some(node=>node.getAttribute('aria-label')===${JSON.stringify(label)}&&!node.disabled)`,
    );
    await js(
      `[...document.querySelectorAll('button')].find(node=>node.getAttribute('aria-label')===${JSON.stringify(label)}).click()`,
    );
  };
  const input = async (label, value) => {
    await waitFor(
      `[...document.querySelectorAll('label')].some(node=>node.textContent.trim().startsWith(${JSON.stringify(label)})&&node.querySelector('input,textarea')&&!node.querySelector('input,textarea').disabled)`,
    );
    await js(
      `(()=>{const parent=[...document.querySelectorAll('label')].find(node=>node.textContent.trim().startsWith(${JSON.stringify(label)}));if(!parent)throw Error('Missing input label');const node=parent.querySelector('input,textarea');Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
  };
  const checkbox = async (label) => {
    await waitFor(
      `[...document.querySelectorAll('label')].some(node=>node.textContent.trim()===${JSON.stringify(label)}&&node.querySelector('input[type="checkbox"]')&&!node.querySelector('input[type="checkbox"]').disabled)`,
    );
    await js(
      `(()=>{const parent=[...document.querySelectorAll('label')].find(node=>node.textContent.trim()===${JSON.stringify(label)});if(!parent)throw Error('Missing checkbox label');parent.querySelector('input[type="checkbox"]').click()})()`,
    );
  };
  const capture = async (name, width) => {
    window.setContentSize(width, 844);
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert(
      await js(
        'document.documentElement.scrollWidth<=innerWidth&&document.body.scrollWidth<=innerWidth',
      ),
    );
    fs.writeFileSync(
      path.join(profile, name + '.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
  };
  const select = async (label, value) => {
    await waitFor(
      `[...document.querySelectorAll('label')].some(node=>node.textContent.trim().startsWith(${JSON.stringify(label)})&&node.querySelector('select')&&!node.querySelector('select').disabled)`,
    );
    await js(
      `(()=>{const node=[...document.querySelectorAll('label')].find(node=>node.textContent.trim().startsWith(${JSON.stringify(label)})).querySelector('select');const option=${JSON.stringify(value)}===null?[...node.options].find(o=>o.value&&!o.disabled):[...node.options].find(o=>o.value===${JSON.stringify(value)});if(!option||option.disabled)throw Error('Synthetic missing enabled option');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(node,option.value);node.dispatchEvent(new Event('change',{bubbles:true}))})()`,
    );
  };
  const commands = (method) =>
    requests.filter((value) => value.action === 'execute' && value.command.method === method);
  const record = (prefix, sessionId) =>
    js(
      `new Promise((resolve,reject)=>{const request=indexedDB.open('moor-secure-workspace-v1',1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('state','readonly'),read=tx.objectStore('state').getAll();read.onsuccess=()=>resolve(read.result.flatMap(value=>value.records??[]).find(row=>row.key.startsWith(${JSON.stringify(prefix)})&&row.target.sessionId===${JSON.stringify(sessionId)}));tx.oncomplete=()=>db.close();tx.onerror=()=>reject(tx.error)}})`,
    );
  const selectedId = async () => {
    const list = commands('session');
    assert(list.length);
    return list.at(-1).command.params.sessionId;
  };
  const prompt = async (body, sequence) => {
    await enabled('刷新会话');
    await fill('#secure-prompt', body);
    await press('发送');
    await fixture.waitCompleted(sequence);
    await press('刷新会话');
    await waitFor(
      "document.querySelector('#secure-prompt')&&!document.querySelector('#secure-prompt').disabled",
    );
    await text('SYNTHETIC_PRIVATE_COMPLETED_' + sequence);
  };
  const reload = async () => {
    await window.loadURL(CLIENT_URL);
    await text('设备已授权');
    await connectProject();
    await press('刷新');
    await waitFor(
      `[...document.querySelectorAll('.secure-sessions button')].some(button=>button.querySelector('span')?.textContent.trim()==='新会话'&&!button.disabled)`,
    );
    await js(
      `[...document.querySelectorAll('.secure-sessions button')].find(button=>button.querySelector('span')?.textContent.trim()==='新会话').click()`,
    );
    await waitFor("document.querySelector('#secure-prompt')");
  };
  const forkPlan = async (directory, branch) => {
    await press('Fork 会话');
    await enabled('重新读取 Fork 选项');
    await select('历史截止点', 'current');
    await select('执行目录', directory);
    if (directory === 'worktree') {
      await select('本地基线分支', null);
      await input('新分支名称', branch);
    }
    await press('审阅 Fork 方案');
    await text('确认原生会话副本');
  };
  const remove = async () => {
    await checkbox('我确认清理此会话的独立工作目录');
    await press('清理工作目录');
    await text('工作目录已清理。');
  };

  await window.loadURL(CLIENT_URL);
  await connectProject();
  await press('新建会话');
  await text('主机已确认原操作');
  await openSession();
  const sourceId = await selectedId();
  await fill('#secure-prompt', 'SYNTHETIC_PRIVATE_SOURCE_DRAFT');
  await press('Git 工作目录');
  await text('为新会话创建独立工作目录');
  await select('本地基线分支', null);
  await input('新分支名称', 'feature/SYNTHETIC_PRIVATE_SOURCE');
  assert.equal(commands('git-action').length, 0);
  await js("document.querySelector('.git-workspace-panel').scrollIntoView({block:'start'})");
  await capture('git-prepare-desktop', 1200);
  await capture('git-prepare-mobile', 390);
  fixture.dropNextGitReply();
  await press('创建独立工作目录');
  await enabled('核查原 Git 操作');
  assert.equal(fixture.droppedReplies, 1);
  const gitOriginal = await record('git-workspace-v1/', sourceId);
  assert(gitOriginal.value.pending);
  const prepareRequest = gitOriginal.value.pending.request;
  const prepareCount = commands('git-action').length;
  await reload();
  assert.equal(commands('git-action').length, prepareCount);
  assert.deepEqual(await record('git-workspace-v1/', sourceId), gitOriginal);
  await press('Git 工作目录');
  await press('核查原 Git 操作');
  await text('独立工作目录');
  await text('来自执行电脑的当前状态。');
  await enabled('重新读取 Git 状态');
  assert.equal(commands('git-action').length, prepareCount);
  assert.deepEqual(commands('git-operations').at(-1).command.params.request, prepareRequest);
  assert.equal((await record('git-workspace-v1/', sourceId)).value.receipt.phase, 'accepted');
  assert.equal(fixture.prompts, 0);
  await aria('关闭 Git 与工作目录');
  assert.equal(
    await js("document.querySelector('#secure-prompt').value"),
    'SYNTHETIC_PRIVATE_SOURCE_DRAFT',
  );
  await prompt('SYNTHETIC_PRIVATE_SOURCE_PROMPT', 1);
  const sourceDirectory = fixture.workspaces.opens.at(-1).cwd;
  assert.notEqual(sourceDirectory, fixture.workspaces.project);
  assert(fs.existsSync(sourceDirectory));
  console.log('Git creation and original read-only recovery passed.');

  await fill('#secure-prompt', 'SYNTHETIC_PRIVATE_RETAINED_SOURCE_DRAFT');
  await press('保存草稿');
  await press('从此回合 Fork');
  await select('执行目录', 'same-directory');
  await press('审阅 Fork 方案');
  await enabled('确认创建原生会话副本');
  await js(
    "document.querySelector('[aria-label=\"最终 Fork 审阅\"]').scrollIntoView({block:'start'})",
  );
  await capture('fork-review-desktop', 1200);
  await capture('fork-review-mobile', 390);
  fixture.dropNextForkReply();
  await press('确认创建原生会话副本');
  await enabled('核查原 Fork 结果');
  const originalFork = await record('session-fork-v1/', sourceId);
  assert(originalFork.value.operation);
  assert.equal(fixture.workspaces.forks.length, 1);
  const forkRequest = originalFork.value.operation.request;
  assert.equal(forkRequest.cutoff.kind, 'turn');
  assert.equal(
    fixture.workspaces.forks[0].anchor.messageId,
    'synthetic-message-' + forkRequest.cutoff.turnId,
  );
  const forkCount = commands('fork-action').length,
    openCount = fixture.workspaces.opens.length;
  await reload();
  assert.equal(commands('fork-action').length, forkCount);
  await press('Fork 会话');
  await press('核查原 Fork 结果');
  await text('主机已确认新会话及原生上下文。');
  assert.equal(commands('fork-action').length, forkCount);
  assert.equal(fixture.workspaces.forks.length, 1);
  assert.equal(
    fixture.workspaces.opens.length,
    openCount,
    'inspection must never load a native child',
  );
  await press('打开已确认的副本');
  await text('Fork 自');
  await waitFor(
    "document.querySelector('[aria-label=\"会话内容\"]').textContent.includes('会话已创建')",
  );
  assert.equal(await selectedId(), forkRequest.childSessionId);
  assert.equal(await js("document.querySelector('#secure-prompt').value"), '');
  assert.equal(fixture.prompts, 1);
  await press('Git 工作目录');
  await text('此目录由 2 份会话共用');
  await checkbox('我确认脱离此会话，保留其他会话目录');
  await press('脱离此会话，保留目录');
  await text('此会话已脱离共享目录');
  assert(fs.existsSync(sourceDirectory));
  await aria('关闭 Git 与工作目录');
  assert(await js("document.querySelector('button[type=submit].secure-primary').disabled"));
  await press('打开源会话');
  await enabled('刷新会话');
  assert.equal(
    await js("document.querySelector('#secure-prompt').value"),
    'SYNTHETIC_PRIVATE_RETAINED_SOURCE_DRAFT',
  );
  console.log(
    'Completed-turn Fork, original recovery, provenance, draft isolation and shared detach passed.',
  );

  await forkPlan('worktree', 'feature/SYNTHETIC_PRIVATE_REJECTED');
  fixture.workspaces.failNextFork('reject');
  await press('确认创建原生会话副本');
  await enabled('查看本次分叉的工作目录');
  const rejected = await record('session-fork-v1/', sourceId);
  assert.equal(rejected.value.receipt.phase, 'rejected');
  const rejectedId = rejected.value.receipt.childSessionId,
    rejectedDirectory = fixture.workspaces.forks.at(-1).targetCwd;
  assert(fs.existsSync(rejectedDirectory));
  const dirty = path.join(rejectedDirectory, 'SYNTHETIC_PRIVATE_UNCOMMITTED.txt');
  fs.writeFileSync(dirty, 'SYNTHETIC_PRIVATE_KEEP');
  await press('查看本次分叉的工作目录');
  await text('存在未提交改动');
  await text('当前不能清理。');
  assert.equal(
    await selectedId(),
    sourceId,
    'a resource without a child session must retain the selected source',
  );
  assert(fs.existsSync(dirty));
  await js("document.querySelector('.git-workspace-panel').scrollIntoView({block:'start'})");
  await capture('fork-resource-dirty-desktop', 1200);
  await capture('fork-resource-dirty-mobile', 390);
  fs.unlinkSync(dirty);
  await press('重新读取 Git 状态');
  await text('未发现未提交改动');
  await checkbox('我确认清理此会话的独立工作目录');
  fixture.dropNextGitReply();
  await press('清理工作目录');
  await enabled('核查原 Git 操作');
  const pendingCleanup = await record('git-workspace-v1/', rejectedId);
  assert(pendingCleanup.value.pending);
  assert(
    !(await record('session-fork-v1/', sourceId)).value.cleanup,
    'unknown Git receipt cannot consume Fork resource proof',
  );
  const removedCalls = commands('git-action').length;
  await reload();
  await press('Fork 会话');
  await press('查看本次分叉的工作目录');
  await enabled('核查原 Git 操作');
  assert(
    !(await record('session-fork-v1/', sourceId)).value.cleanup,
    'reading removed state must retain proof while original cleanup is pending',
  );
  await press('核查原 Git 操作');
  await text('工作目录已清理。');
  assert.equal(
    commands('git-action').length,
    removedCalls,
    'inspection never deletes the directory again',
  );
  assert(!fs.existsSync(rejectedDirectory));
  assert(fixture.workspaces.git('branch', '--list', 'feature/SYNTHETIC_PRIVATE_REJECTED'));
  await waitFor("!document.querySelector('.session-fork-panel')");
  const cleaned = await record('session-fork-v1/', sourceId);
  assert.equal(cleaned.value.cleanup.executionId, rejected.value.receipt.execution.executionId);
  assert(
    commands('git-action').some(
      (r) => r.command.params.sessionId === rejectedId && r.command.params.action === 'remove',
    ),
  );
  await aria('关闭 Git 与工作目录');
  console.log(
    'Rejected native Fork retained its actual worktree; dirty protection and explicit cleanup passed.',
  );

  await forkPlan('worktree', 'feature/SYNTHETIC_PRIVATE_RECOVERED');
  fixture.workspaces.failNextFork('after-native');
  await press('确认创建原生会话副本');
  await enabled('核查原 Fork 结果');
  const unknown = await record('session-fork-v1/', sourceId);
  assert.equal(unknown.value.receipt.phase, 'unknown');
  const nativeForks = fixture.workspaces.forks.length,
    nativeOpens = fixture.workspaces.opens.length;
  await press('核查原 Fork 结果');
  await enabled('重试确认 Fork');
  assert.equal(fixture.workspaces.forks.length, nativeForks);
  assert.equal(fixture.workspaces.opens.length, nativeOpens);
  await press('重试确认 Fork');
  await text('主机已确认新会话及原生上下文。');
  assert.equal(
    fixture.workspaces.forks.length,
    nativeForks,
    'retry with a known native ID loads that exact child, never forks again',
  );
  assert.equal(fixture.workspaces.opens.length, nativeOpens + 1);
  const repeated = commands('fork-action').slice(-2);
  assert.deepEqual(repeated[0].command.params, repeated[1].command.params);
  await press('打开已确认的副本');
  await text('Fork 自');
  const recoveredId = unknown.value.operation.request.childSessionId;
  assert.equal(await selectedId(), recoveredId);
  await prompt('SYNTHETIC_PRIVATE_CHILD_PROMPT', 2);
  assert.equal(fixture.workspaces.opens.at(-1).cwd, fixture.workspaces.forks.at(-1).targetCwd);
  await press('Git 工作目录');
  await remove();
  await aria('关闭 Git 与工作目录');
  await press('打开源会话');
  await press('Git 工作目录');
  await remove();
  await aria('关闭 Git 与工作目录');
  assert(!fs.existsSync(sourceDirectory));
  assert(fixture.workspaces.git('branch', '--list', 'feature/SYNTHETIC_PRIVATE_SOURCE'));
  assert.equal(fixture.prompts, 2);
  fixture.assertOpaque();
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(profile, 'workspace-verification.json'),
    JSON.stringify(
      {
        prompts: fixture.prompts,
        nativeForks: fixture.workspaces.forks.length,
        droppedReplies: fixture.droppedReplies,
        gitActions: commands('git-action').length,
        gitInspections: commands('git-operations').length,
        forkActions: commands('fork-action').length,
        forkInspections: commands('fork-operations').length,
      },
      null,
      2,
    ),
  );
  console.log(
    'Native Git/Fork workflow passed: exact recovery, native load, dirty cleanup, retained branches, opaque Relay and desktop/mobile layout.',
  );
});
