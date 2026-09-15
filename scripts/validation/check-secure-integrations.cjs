// Actual trusted Electron/Relay/Host flow with synthetic GitHub and a loopback project page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runSecureNative = require('../../tests/fixtures/secure-native-client.cjs');

runSecureNative({ name: 'integrations', integrations: true }, async (native) => {
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
  const githubWrites = () =>
    requests.filter(
      (value) => value.action === 'execute' && value.command.method === 'github-write-action',
    );
  const turns = () =>
    requests.filter(
      (value) =>
        value.action === 'execute' &&
        value.command.method === 'mutate' &&
        value.command.params.kind === 'turn',
    );
  const uploads = () =>
    requests.filter(
      (value) =>
        value.action === 'execute' &&
        value.command.method === 'attachment-action' &&
        value.command.params.action === 'upload',
    );
  const githubRecord = () =>
    js(
      `new Promise((resolve,reject)=>{const request=indexedDB.open('moor-secure-workspace-v1',1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('state','readonly'),read=tx.objectStore('state').getAll();read.onsuccess=()=>resolve(read.result.flatMap(value=>value.records??[]).find(record=>record.key.startsWith('github-write-v1/')));tx.oncomplete=()=>db.close();tx.onerror=()=>reject(tx.error)}})`,
    );
  const issue = async () => {
    await press('GitHub');
    await press('重新读取 GitHub 授权');
    await press('读取 Issues');
    await waitFor(
      "document.querySelector('.github-items button')&&!document.querySelector('.github-items button').disabled",
    );
    await js("document.querySelector('.github-items button').click()");
    await text('SYNTHETIC_PRIVATE_ISSUE_BODY');
  };
  const locate = async (x, y) => {
    await waitFor(
      'document.querySelector(\'[aria-label="在预览画面定位元素"]\')&&!document.querySelector(\'[aria-label="在预览画面定位元素"]\').disabled',
    );
    await js(
      `(()=>{const node=document.querySelector('[aria-label="在预览画面定位元素"]'),rect=node.getBoundingClientRect();node.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:rect.left+${x}*rect.width/1280,clientY:rect.top+${y}*rect.height/800}));})()`,
    );
    await text('已定位元素');
    await enabled('点击所选网页元素');
  };
  const deadline = async (promise) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error('Synthetic Host completion did not arrive')),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  await window.loadURL(CLIENT_URL);
  await connectProject();
  await press('新建会话');
  await text('主机已确认原操作');
  await openSession();
  await fill('#secure-prompt', 'SYNTHETIC_PRIVATE_EXISTING_DRAFT');
  await issue();
  await press('读取评论');
  await enabled('读取评论');
  await js("document.querySelector('.github-body').scrollIntoView({block:'center'})");
  await capture('github-desktop', 1200);
  await capture('github-mobile', 390);
  await press('将正文加入草稿');
  await text('已将完整说明加入本机草稿');
  await aria('关闭 GitHub 面板');
  const draft = await js("document.querySelector('#secure-prompt').value");
  assert(draft.startsWith('SYNTHETIC_PRIVATE_EXISTING_DRAFT\n\n'));
  assert(draft.includes('SYNTHETIC_PRIVATE_ISSUE_BODY'));
  assert.equal(fixture.prompts, 0);
  await issue();
  await press('审查、评论与发布');
  await press('重新读取发布能力与目录');
  await press('编写会话评论');
  await input('待发布正文', 'SYNTHETIC_PRIVATE_GITHUB_COMMENT');
  await press('审查本次操作');
  await text('确认发布会话评论');
  await js("document.querySelector('.github-write-confirm').scrollIntoView({block:'start'})");
  await capture('github-review-desktop', 1200);
  await capture('github-review-mobile', 390);
  fixture.dropNextGithubWriteReply();
  await press('确认发布会话评论');
  await text('核查原操作结果');
  await enabled('核查原操作结果');
  assert.equal(fixture.droppedReplies, 1);
  assert.equal(fixture.integrations.comments.length, 1);
  const original = await githubRecord();
  assert(original.value.pending);
  const originalId = original.value.pending.request.operationId;
  assert.equal(original.value.pending.request.body, 'SYNTHETIC_PRIVATE_GITHUB_COMMENT');
  const count = githubWrites().length;
  await window.loadURL(CLIENT_URL);
  await text('设备已授权');
  assert.equal(githubWrites().length, count, 'reload never republishes a comment');
  assert.deepEqual(await githubRecord(), original);
  await connectProject();
  await openSession();
  await press('GitHub');
  await press('审查、评论与发布');
  await press('核查原操作结果');
  await text('主机已确认操作成功');
  assert.equal(githubWrites().length, count);
  assert.equal(fixture.integrations.comments.length, 1);
  const recovered = await githubRecord();
  assert(!recovered.value.pending);
  assert.equal(recovered.value.receipt.operationId, originalId);
  assert.equal(fixture.prompts, 0);
  await aria('关闭写入面板');
  console.log('GitHub native flow passed, including exact manual recovery after reload.');

  await press('网页预览');
  await press('读取登记的预览服务');
  await press('连接预览');
  await text('SYNTHETIC_PRIVATE_PREVIEW_PAGE');
  await js("document.querySelector('.preview-frame').scrollIntoView({block:'center'})");
  await capture('preview-frame-desktop', 1200);
  await capture('preview-frame-mobile', 390);
  await locate(120, 126);
  await press('点击所选网页元素');
  await text('SYNTHETIC_PRIVATE_PREVIEW_CLICKED');
  await locate(120, 126);
  await input('标注说明', 'SYNTHETIC_PRIVATE_PREVIEW_ANNOTATION');
  await checkbox('在本地标注中保存当前 PNG 截图');
  await press('保存冻结标注');
  await waitFor(
    "document.querySelector('.preview-annotation-card')?.textContent.includes('SYNTHETIC_PRIVATE_PREVIEW_ANNOTATION')",
  );
  await press('加入原会话草稿');
  await press('将截图作为附件');
  await text('已将审阅的截图加入本机附件草稿');
  assert.equal(fixture.prompts, 0);
  assert.equal(uploads().length, 0, 'saving annotation or screenshot draft never uploads');
  await js("document.querySelector('.preview-annotation-card').scrollIntoView({block:'center'})");
  await capture('preview-desktop', 1200);
  await capture('preview-mobile', 390);
  await locate(120, 190);
  await input('输入到网页', 'SYNTHETIC_PRIVATE_INPUT');
  await press('将文字输入网页');
  await text('SYNTHETIC_PRIVATE_PREVIEW_TYPED_SYNTHETIC_PRIVATE_INPUT');
  await input('当前服务内路径', '/next');
  await press('前往路径');
  await text('SYNTHETIC_PRIVATE_PREVIEW_NEXT');
  await press('关闭连接');
  await text('主机已确认连接关闭');
  console.log('Native preview renderer locate, click, input, navigation and close passed.');
  await aria('关闭网页预览面板');
  await text('SYNTHETIC_PRIVATE_PREVIEW_ANNOTATION');
  await press('检查附件输入能力');
  await text('已读取此会话固定 Agent 的能力，未发送指令。');
  assert.equal(fixture.prompts, 0, 'input capability inspection never sends a prompt');
  const turnCount = turns().length;
  await press('发送');
  await text('主机已确认原操作');
  await deadline(fixture.waitCompleted(1));
  assert.equal(turns().length, turnCount + 1);
  assert(fixture.inputs[0].prompt.includes('SYNTHETIC_PRIVATE_ISSUE_BODY'));
  assert(fixture.inputs[0].prompt.includes('SYNTHETIC_PRIVATE_PREVIEW_ANNOTATION'));
  assert.equal(fixture.inputs[0].attachments.length, 1);
  assert.equal(uploads().length, 1, 'the explicit send uploads only the reviewed PNG');
  const turnId = turns().at(-1).command.params.operationId;
  const turn = await operationRecord('turn', turnId);
  assert.equal(turn.state, 'accepted');
  assert.equal(fixture.inputs[0].attachmentData.length, 1);
  assert.equal(
    fixture.inputs[0].attachmentData[0].data,
    turn.previewReview.annotations[0].snapshot.image.data,
    'the Agent receives the exact frozen PNG selected as an attachment',
  );
  assert.equal(
    turn.previewReview.annotations[0].snapshot.note,
    'SYNTHETIC_PRIVATE_PREVIEW_ANNOTATION',
  );
  await press('刷新会话');
  await waitFor("document.querySelector('#secure-prompt')!==null");
  await enabled('刷新会话');
  assert.equal(
    await js('document.querySelector(\'[aria-label="本次指令的网页标注"]\')!==null'),
    false,
  );
  assert.equal(errors.length, 0, errors.join('\n'));
  fixture.assertOpaque();
  console.log(
    'Trusted native integrations: GitHub context draft, reviewed comment, exact lost-receipt reload and manual recovery; actual preview locate/click/input/navigation/close; frozen annotation and explicit PNG attachment delivered once. All relay wire/storage scans passed.',
  );
  console.log('Synthetic screenshots: ' + profile);
});
