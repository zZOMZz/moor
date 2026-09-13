// Stock Electron with synthetic accounts, projects, attachments and Agent output only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runSecureNative = require('../tests/support/secure-native-client.cjs');

runSecureNative({ name: 'content', richContent: true }, async (native) => {
  const {
    fixture,
    profile,
    requests,
    errors,
    savedFiles,
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
  const aria = async (label) => {
    await waitFor(
      `[...document.querySelectorAll('button')].some(node=>node.getAttribute('aria-label')===${JSON.stringify(label)}&&!node.disabled)`,
    );
    await js(
      `[...document.querySelectorAll('button')].find(node=>node.getAttribute('aria-label')===${JSON.stringify(label)}).click()`,
    );
  };
  const enabled = (label) =>
    waitFor(
      `[...document.querySelectorAll('button')].some(node=>node.textContent.trim()===${JSON.stringify(label)}&&!node.disabled)`,
    );
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
  const uploads = () =>
    requests.filter(
      (value) =>
        value.action === 'execute' &&
        value.command.method === 'attachment-action' &&
        value.command.params.action === 'upload',
    );
  await window.loadURL(CLIENT_URL);
  await connectProject();
  await click('新建会话');
  await text('主机已确认原操作');
  await openSession();
  await click('项目文件');
  await aria('查看文件：SYNTHETIC_PRIVATE_FILE.txt');
  await text('SYNTHETIC_PRIVATE_BEFORE');
  await aria('关闭文件与变更');

  await fill('#secure-prompt', 'SYNTHETIC_PRIVATE_PRIMER');
  await click('发送');
  await fixture.waitCompleted(1);
  await enabled('刷新会话');
  await click('刷新会话');
  await text('SYNTHETIC_PRIVATE_COMPLETED_1');
  await enabled('检查附件输入能力');
  await click('检查附件输入能力');
  await text('已读取此会话固定 Agent 的能力');
  assert.equal(fixture.prompts, 1, 'capability inspection never sends a prompt');
  await waitFor('document.querySelector(\'input[type="file"]\')');
  await js(`(()=>{
    const transfer=new DataTransfer();
    transfer.items.add(new File(['SYNTHETIC_PRIVATE_UPLOAD_BYTES'], 'SYNTHETIC_PRIVATE_UPLOAD.txt', {type:'text/plain'}));
    const input=document.querySelector('input[type="file"]'); input.files=transfer.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await text('SYNTHETIC_PRIVATE_UPLOAD.txt');
  await text('仅保存在本机');
  assert.equal(uploads().length, 0, 'selecting a file never uploads it');
  await fill('#secure-prompt', 'SYNTHETIC_PRIVATE_PROMPT_WITH_ATTACHMENT');
  fixture.dropNextAttachmentReply();
  await enabled('发送');
  await click('发送');
  await text('上传结果待确认');
  await enabled('刷新本机记录');
  assert.equal(fixture.prompts, 1, 'unknown upload cannot send the next Agent turn');
  assert.equal(fixture.droppedReplies, 1);
  assert.equal(uploads().length, 1);
  const original = await operationRecord('attachment-upload');
  assert.equal(original.state, 'pending');
  const originalRequest = uploads()[0];

  await window.loadURL(CLIENT_URL);
  await text('设备已授权');
  assert.equal(uploads().length, 1, 'reloading never replays upload');
  assert.deepEqual(await operationRecord('attachment-upload'), original);
  await connectProject();
  await openSession();
  await click('使用原操作重试确认');
  await text('主机已确认附件操作');
  await enabled('刷新本机记录');
  assert.equal(uploads().length, 2);
  assert.deepEqual(uploads()[1].command, originalRequest.command);
  assert.deepEqual(uploads()[1].target, originalRequest.target);
  assert.equal((await operationRecord('attachment-upload')).state, 'accepted');
  assert.equal(fixture.prompts, 1, 'confirming an upload does not send a turn');
  await enabled('发送');
  await click('发送');
  await fixture.waitCompleted(2);
  assert.equal(uploads().length, 2, 'explicit send reuses the confirmed upload');
  assert.equal(fixture.inputs[1].attachmentData.length, 1);
  assert.equal(
    Buffer.from(fixture.inputs[1].attachmentData[0].data, 'base64').toString(),
    'SYNTHETIC_PRIVATE_UPLOAD_BYTES',
  );
  await enabled('刷新会话');
  await click('刷新会话');
  await text('SYNTHETIC_PRIVATE_COMPLETED_2');
  await aria('读取附件：SYNTHETIC_PRIVATE_GENERATED_2.txt');
  await text('SYNTHETIC_PRIVATE_OUTPUT_2');
  await capture('attachment-desktop', 1200);
  await capture('attachment-mobile', 390);
  await click('保存附件');
  await text('附件已保存。');
  assert.equal(savedFiles.length, 1);
  assert.equal(fs.readFileSync(savedFiles[0], 'utf8'), 'SYNTHETIC_PRIVATE_OUTPUT_2');
  await aria('关闭加密附件预览');

  await click('项目文件');
  await aria('查看文件：SYNTHETIC_PRIVATE_FILE.txt');
  await text('SYNTHETIC_PRIVATE_AFTER_2');
  await capture('file-mobile', 390);
  await aria('关闭文件与变更');
  await click('会话变更');
  await waitFor("document.querySelector('.project-turn-list li button')");
  await js(
    "[...document.querySelectorAll('.project-turn-list li button')].find(button=>button.querySelector('span').textContent==='第 1 回合').click()",
  );
  await waitFor(
    "document.querySelector('.project-change-list button')&&!document.querySelector('.project-change-list button').disabled",
  );
  await js("document.querySelector('.project-change-list button').click()");
  await text('SYNTHETIC_PRIVATE_BEFORE');
  await text('SYNTHETIC_PRIVATE_AFTER_1');
  assert(
    !(await js(
      'document.querySelector(\'.project-diff-preview\').textContent.includes("SYNTHETIC_PRIVATE_AFTER_2")',
    )),
    'historical diff remains at the original baseline',
  );
  await capture('diff-mobile', 390);
  await capture('diff-desktop', 1200);
  await aria('关闭文件与变更');

  await click('断开连接');
  await text('设备已授权');
  await enabled('连接');
  const beforeOfflineReads = requests.filter((value) => value.action === 'execute').length;
  await click('项目文件');
  await aria('查看文件：SYNTHETIC_PRIVATE_FILE.txt');
  await text('已缓存文件版本');
  await text('SYNTHETIC_PRIVATE_AFTER_2');
  await aria('关闭文件与变更');
  await aria('读取附件：SYNTHETIC_PRIVATE_GENERATED_2.txt');
  await text('已核对的离线缓存');
  await text('SYNTHETIC_PRIVATE_OUTPUT_2');
  assert.equal(requests.filter((value) => value.action === 'execute').length, beforeOfflineReads);
  assert.equal(fixture.prompts, 2);
  assert.equal(errors.length, 0, errors.join('\n'));
  fixture.assertOpaque();
  console.log(
    'Trusted native content: actual encrypted Host files/diff/attachments, dropped upload reply, reload/manual original retry, explicit send, native byte save and isolated offline cache passed.',
  );
  console.log('Synthetic screenshots: ' + profile);
});
