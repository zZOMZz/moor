// Actual trusted Electron/Relay/Host flow; every account, project, Skill and MCP is synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runSecureNative = require('../tests/support/secure-native-client.cjs');

runSecureNative({ name: 'extensions', extensions: true }, async (native) => {
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
    permissionRecord: operationRecord,
    CLIENT_URL,
  } = native;
  const deadline = async (promise) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('Synthetic Host signal did not arrive')), 15000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const enabled = (label) =>
    waitFor(
      `[...document.querySelectorAll('button')].some(node=>node.textContent.trim()===${JSON.stringify(label)}&&!node.disabled)`,
    );
  const aria = async (label) => {
    await waitFor(
      `[...document.querySelectorAll('button')].some(node=>node.getAttribute('aria-label')===${JSON.stringify(label)}&&!node.disabled)`,
    );
    await js(
      `[...document.querySelectorAll('button')].find(node=>node.getAttribute('aria-label')===${JSON.stringify(label)}).click()`,
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
  const turns = () =>
    requests.filter(
      (value) =>
        value.action === 'execute' &&
        value.command.method === 'mutate' &&
        value.command.params.kind === 'turn',
    );
  const selectMcp = async (name) => {
    await enabled('额外 MCP');
    const beforeRead = requests.length;
    await click('额外 MCP');
    await text('本回合额外 MCP');
    await enabled('读取项目允许的 MCP');
    assert.equal(requests.length, beforeRead, 'opening MCP does not read or execute');
    await click('读取项目允许的 MCP');
    await waitFor(
      `[...document.querySelectorAll('input[type="checkbox"]')].some(node=>node.getAttribute('aria-label')===${JSON.stringify('选择 MCP：' + name)}&&!node.disabled)`,
    );
    await js(
      `[...document.querySelectorAll('input[type="checkbox"]')].find(node=>node.getAttribute('aria-label')===${JSON.stringify('选择 MCP：' + name)}).click()`,
    );
    await click('确认保存 MCP 选择到草稿');
    await text('已保存本回合 MCP 选择');
    await capture('mcp-desktop', 1200);
    await capture('mcp-mobile', 390);
    await aria('关闭额外 MCP');
  };

  await window.loadURL(CLIENT_URL);
  await connectProject();
  await click('新建会话');
  await text('主机已确认原操作');
  await openSession();
  await fill('#secure-prompt', 'SYNTHETIC_PRIVATE_EXISTING_DRAFT');
  await click('Skills');
  await text('SYNTHETIC_PRIVATE_SKILL');
  await waitFor(
    "document.querySelector('.skills-list button')&&!document.querySelector('.skills-list button').disabled",
  );
  await js("document.querySelector('.skills-list button').click()");
  await text('SYNTHETIC_PRIVATE_SKILL_BODY');
  await capture('skills-desktop', 1200);
  await capture('skills-mobile', 390);
  await click('将说明加入本次指令');
  await text('已将完整说明加入本机草稿');
  await aria('关闭 Skills');
  const draft = await js("document.querySelector('#secure-prompt').value");
  assert(draft.startsWith('SYNTHETIC_PRIVATE_EXISTING_DRAFT\n\n'));
  assert(draft.includes('[Skill 说明快照]') && draft.includes('SYNTHETIC_PRIVATE_SKILL_BODY'));
  assert.equal(fixture.prompts, 0);
  assert.equal(fixture.mcpDescriptors.length, 0);

  await selectMcp('SYNTHETIC_PRIVATE_MCP_A');
  assert.equal(fixture.prompts, 0, 'MCP directory and selection never execute');
  assert.equal(fixture.mcpDescriptors.length, 0);
  await enabled('发送');
  await click('发送');
  await text('主机已确认原操作');
  await deadline(fixture.waitMcpOpened(1));
  fixture.assertMcpCurrent(1); // The RPC is over; the authorized Agent turn must still be valid.
  fixture.continueMcp(1);
  await deadline(fixture.waitCompleted(1));
  assert.equal(fixture.mcpDescriptors[0].length, 1);
  assert.equal(fixture.mcpDescriptors[0][0].headers[0].value, 'SYNTHETIC_PRIVATE_MCP_SECRET_A');
  assert.equal(fixture.inputs[0].prompt, draft);
  await enabled('刷新会话');
  await click('刷新会话');
  await waitFor("document.querySelector('#secure-prompt')!==null");
  await enabled('刷新会话');
  assert(!(await js('document.querySelector(\'[aria-label="已保存的 MCP 草稿"]\')!==null')));
  await fill('#secure-prompt', 'SYNTHETIC_PRIVATE_NEXT_WITHOUT_MCP');
  await enabled('发送');
  await click('发送');
  await deadline(fixture.waitCompleted(2));
  assert.deepEqual(fixture.mcpDescriptors[1], [], 'next turn cannot inherit MCP');
  assert.deepEqual(fixture.inputs[1].mcpServerIds, []);
  await enabled('刷新会话');
  await click('刷新会话');
  await waitFor("document.querySelector('#secure-prompt')!==null");
  await enabled('刷新会话');

  await selectMcp('SYNTHETIC_PRIVATE_MCP_B');
  await fill('#secure-prompt', 'SYNTHETIC_PRIVATE_UNKNOWN_MCP_TURN');
  fixture.dropNextTurnReply();
  await enabled('发送');
  await click('发送');
  await text('原操作结果待确认');
  await enabled('刷新本机记录');
  assert.equal(fixture.droppedReplies, 1);
  const originalRequest = turns().at(-1),
    originalId = originalRequest.command.params.operationId;
  const original = await operationRecord('turn', originalId);
  assert.equal(original.state, 'pending');
  assert.equal(original.mcpReview.servers[0].name, 'SYNTHETIC_PRIVATE_MCP_B');
  const count = turns().length;
  await window.loadURL(CLIENT_URL);
  await text('设备已授权');
  assert.equal(turns().length, count, 'reload never replays a selected MCP turn');
  assert.deepEqual(await operationRecord('turn', originalId), original);
  await connectProject();
  await openSession();
  const opened = fixture.mcpDescriptors.length;
  await enabled('核查原操作');
  await click('核查原操作');
  await text('主机已确认原操作状态。');
  await enabled('刷新本机记录');
  assert.equal((await operationRecord('turn', originalId)).state, 'accepted');
  assert.equal(turns().length, count, 'inspection never dispatches the turn');
  assert.equal(
    fixture.mcpDescriptors.length,
    opened,
    'accepted original cannot launch another MCP Agent',
  );
  assert(!(await js('document.querySelector(\'[aria-label="已保存的 MCP 草稿"]\')!==null')));
  assert.equal(errors.length, 0, errors.join('\n'));
  fixture.assertOpaque();
  console.log(
    'Trusted native extensions: Skills draft, explicit MCP review, post-receipt authority, no next-turn inheritance, exact lost-receipt reload and manual recovery passed.',
  );
  console.log('Synthetic screenshots: ' + profile);
});
