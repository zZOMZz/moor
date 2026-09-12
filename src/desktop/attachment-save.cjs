const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const LIMIT = 8 * 1024 * 1024;
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,160}$/.test(value);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
function attachmentPayload(input) {
  if (!exact(input, ['scope', 'reference', 'data'])) throw new Error('附件保存请求无效');
  const { scope, reference, data } = input;
  if (
    !exact(scope, ['owner', 'deviceId', 'workspaceId', 'localProjectId', 'sessionId']) ||
    typeof scope.owner !== 'string' ||
    !scope.owner.length ||
    scope.owner.length > 1000 ||
    /[\x00-\x1f\x7f]/.test(scope.owner) ||
    !['deviceId', 'workspaceId', 'localProjectId', 'sessionId'].every((key) => id(scope[key]))
  )
    throw new Error('附件保存范围无效');
  if (
    !exact(reference, ['contentVersion', 'attachmentId', 'name', 'content']) ||
    reference.contentVersion !== 1 ||
    !id(reference.attachmentId) ||
    typeof reference.name !== 'string' ||
    !reference.name.length ||
    reference.name.length > 200 ||
    /[\/\\\x00-\x1f\x7f]/.test(reference.name) ||
    ['.', '..'].includes(reference.name)
  )
    throw new Error('附件引用或文件名无效');
  const content = reference.content;
  if (
    !exact(content, ['version', 'byteLength', 'mediaType']) ||
    !Number.isSafeInteger(content.byteLength) ||
    content.byteLength < 0 ||
    content.byteLength > LIMIT ||
    typeof content.version !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(content.version) ||
    typeof content.mediaType !== 'string' ||
    content.mediaType.length > 100 ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(content.mediaType) ||
    typeof data !== 'string' ||
    data.length > 4 * Math.ceil(LIMIT / 3)
  )
    throw new Error('附件大小或内容描述无效');
  const bytes = Buffer.from(data, 'base64');
  if (
    bytes.length !== content.byteLength ||
    bytes.toString('base64') !== data ||
    'sha256:' + createHash('sha256').update(bytes).digest('hex') !== content.version
  )
    throw new Error('附件字节或校验和不匹配');
  return { scope: structuredClone(scope), reference: structuredClone(reference), bytes };
}
function trustedContent(event, registry) {
  const entry = registry.get(event?.sender),
    frame = event?.senderFrame;
  if (
    !entry ||
    entry.window.isDestroyed() ||
    event.sender.isDestroyed() ||
    frame !== event.sender.mainFrame ||
    !frame
  )
    throw new Error('无效的附件保存来源');
  let origin;
  try {
    origin = new URL(frame.url).origin;
  } catch {
    throw new Error('无效的附件保存来源');
  }
  if (origin !== entry.origin || frame.origin !== entry.origin)
    throw new Error('附件保存来源已改变');
  return entry;
}
/** Write only a path chosen in the native save dialog, never a renderer path. */
async function writeChosenFile(
  destination,
  bytes,
  { fileSystem = fs, uuid = randomUUID, assertCurrent = () => {} } = {},
) {
  assertCurrent();
  if (typeof destination !== 'string' || !path.isAbsolute(destination))
    throw new Error('请选择有效的保存位置');
  const stat = await fileSystem.lstat(destination).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (stat && (!stat.isFile() || stat.isSymbolicLink()))
    throw new Error('不能覆盖链接或非普通文件');
  assertCurrent();
  const temporary = path.join(path.dirname(destination), '.moor-save-' + uuid());
  let handle;
  try {
    handle = await fileSystem.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    // This is the commit boundary: navigation while writing the temporary file
    // aborts before replacement. Once rename succeeds the save really completed.
    assertCurrent();
    // Rename replaces a final-component symlink rather than following it.
    await fileSystem.rename(temporary, destination);
  } finally {
    if (handle) await handle.close();
    await fileSystem.unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
function createAttachmentSaver({
  registry,
  showSaveDialog,
  writeFile = writeChosenFile,
  downloads,
}) {
  const epochs = new WeakMap();
  let busy = false;
  const invalidate = (sender) => epochs.set(sender, (epochs.get(sender) ?? 0) + 1);
  return {
    invalidate,
    cancel(event) {
      trustedContent(event, registry);
      invalidate(event.sender);
    },
    async save(event, input) {
      const entry = trustedContent(event, registry),
        epoch = epochs.get(event.sender) ?? 0;
      const payload = attachmentPayload(input);
      const assertCurrent = () => {
        if ((epochs.get(event.sender) ?? 0) !== epoch || trustedContent(event, registry) !== entry)
          throw new Error('保存期间会话目标或页面已改变，请重新下载。');
      };
      if (busy) throw new Error('请先完成当前附件保存对话框。');
      busy = true;
      try {
        const result = await showSaveDialog(entry.window, {
          title: '保存附件',
          defaultPath: path.join(downloads(), payload.reference.name),
          buttonLabel: '保存附件',
          properties: ['showOverwriteConfirmation', 'createDirectory'],
        });
        if (result.canceled || !result.filePath) return { status: 'cancelled' };
        assertCurrent();
        await writeFile(result.filePath, payload.bytes, { assertCurrent });
        return { status: 'saved' };
      } finally {
        busy = false;
      }
    },
  };
}
module.exports = { attachmentPayload, trustedContent, createAttachmentSaver, writeChosenFile };
