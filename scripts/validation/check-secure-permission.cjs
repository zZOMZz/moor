// Stock Electron, synthetic account and Agent only. MOOR_TEST_DESKTOP_APP may select a package.
const assert = require('node:assert/strict');
const runSecureNative = require('../../tests/fixtures/secure-native-client.cjs');
runSecureNative(
  { name: 'permission' },
  async ({
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
    select,
    permissionRecord,
    connectProject,
    openSession,
    capture,
    permissionRequests,
    CLIENT_URL,
  }) => {
    await window.loadURL(CLIENT_URL);
    await connectProject();
    await click('新建会话');
    await text('主机已确认原操作');
    await openSession();
    await fill('#secure-prompt', 'SYNTHETIC_PRIVATE_PROMPT_1');
    await click('发送');
    await fixture.waitPermission(1);
    await waitFor(
      `[...document.querySelectorAll('button')].some(button=>button.textContent==='刷新会话'&&!button.disabled)`,
    );
    await click('刷新会话');
    await text('SYNTHETIC_PRIVATE_APPROVAL_1');
    await text('需要你的审批决定');
    assert.equal(permissionRequests().length, 0, 'rendering does not approve');
    await capture('permission-desktop', 1200);
    await capture('permission-mobile', 390);
    fixture.dropNextPermissionReply();
    await click('允许此次合成操作');
    await fixture.waitCompleted(1);
    await text('结果待确认');
    await waitFor(
      `[...document.querySelectorAll('button')].some(button=>button.textContent==='刷新本机记录'&&!button.disabled)`,
    );
    assert.equal(fixture.droppedReplies, 1);
    assert.deepEqual(fixture.outcomes, [{ outcome: { outcome: 'selected', optionId: 'allow' } }]);
    const original = await permissionRecord();
    assert.equal(original.state, 'pending');
    const sent = permissionRequests()[0];
    await window.loadURL(CLIENT_URL);
    await text('设备已授权');
    assert.equal(permissionRequests().length, 1, 'reload does not retry');
    assert.deepEqual(
      await permissionRecord(),
      original,
      'reload preserves original durable record',
    );
    await connectProject();
    await openSession();
    await click('重试原操作');
    await text('主机已确认原操作');
    await waitFor(
      `[...document.querySelectorAll('button')].some(button=>button.textContent==='刷新本机记录'&&!button.disabled)`,
    );
    assert.equal((await permissionRecord()).state, 'accepted');
    assert.equal(permissionRequests().length, 2);
    const retried = permissionRequests()[1];
    assert.deepEqual(retried.command, sent.command);
    assert.deepEqual(retried.target, sent.target);
    assert.equal(
      fixture.outcomes.length,
      1,
      'original retry cannot deliver another Agent decision',
    );
    await click('刷新会话');
    await text('SYNTHETIC_PRIVATE_COMPLETED_1');
    await fill('#secure-prompt', 'SYNTHETIC_PRIVATE_PROMPT_2');
    await click('发送');
    await fixture.waitPermission(2);
    await waitFor(
      `[...document.querySelectorAll('button')].some(button=>button.textContent==='刷新会话'&&!button.disabled)`,
    );
    await click('刷新会话');
    await text('SYNTHETIC_PRIVATE_APPROVAL_2');
    await click('取消审批请求');
    await fixture.waitCompleted(2);
    await text('主机已确认原操作');
    assert.deepEqual(fixture.outcomes[1], { outcome: { outcome: 'cancelled' } });
    assert.equal(fixture.prompts, 2);
    assert.equal(errors.length, 0, errors.join('\n'));
    fixture.assertOpaque();
    console.log(
      'Trusted native approval: actual Relay/Host encryption, durable IndexedDB, dropped reply, reload/manual original retry, explicit cancel and 390px layout passed.',
    );
    console.log('Synthetic screenshots: ' + profile);
  },
);
