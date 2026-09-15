const { randomUUID } = require('node:crypto');
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const revision = (value) =>
  Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const name = (value) =>
  typeof value === 'string' &&
  value === value.trim() &&
  value.length > 0 &&
  value.length <= 100 &&
  !/[\u0000-\u001f\u007f]/.test(value);
function validateAction(value) {
  if (!object(value)) throw Error('电脑名称请求无效');
  if (value.action === 'read' && Object.keys(value).length === 1) return { action: 'read' };
  if (
    value.action === 'rename' &&
    Object.keys(value).length === 3 &&
    name(value.name) &&
    revision(value.expectedRevision)
  )
    return { action: 'rename', name: value.name, expectedRevision: value.expectedRevision };
  throw Error('电脑名称已变化或请求无效，请重新读取后保存');
}
function publicState(value) {
  if (
    !object(value) ||
    !object(value.metadata) ||
    value.metadata.version !== 1 ||
    !name(value.metadata.name) ||
    !revision(value.metadata.revision) ||
    !['unpaired', 'pending', 'synced', 'unsupported', 'conflict', 'revoked'].includes(value.sync)
  )
    throw Error('电脑名称返回状态不可验证');
  return {
    metadata: { version: 1, name: value.metadata.name, revision: value.metadata.revision },
    sync: value.sync,
  };
}
class DesktopDeviceMetadata {
  /** @param {{bridge: () => any, schedule?: (callback: () => void) => unknown, cancel?: (timer: unknown) => void}} options */
  constructor({ bridge, schedule = (fn) => setTimeout(fn, 15000), cancel = clearTimeout }) {
    this.bridge = bridge;
    this.schedule = schedule;
    this.cancel = cancel;
    this.pending = new Map();
    this.closed = false;
  }
  request(input, current) {
    const action = validateAction(input),
      child = this.bridge();
    if (this.closed || !current() || !child?.connected || this.pending.size >= 8)
      return Promise.reject(Error('本机执行组件暂不可用，请稍后读取电脑名称'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const pending = { child, current, action, resolve, reject, timer: undefined };
      this.pending.set(requestId, pending);
      pending.timer = this.schedule(() =>
        this.fail(requestId, '电脑名称保存结果尚未确认，请重新读取；不会自动重试'),
      );
      try {
        child.send({ type: 'device-metadata', requestId, action }, (error) => {
          if (error) this.fail(requestId, '电脑名称请求未能送达，请重新读取');
        });
      } catch {
        this.fail(requestId, '电脑名称请求未能送达，请重新读取');
      }
    });
  }
  fail(id, message) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.cancel(pending.timer);
    pending.reject(Error(message));
  }
  receive(child, message) {
    if (message?.type !== 'device-metadata-result') return false;
    const pending = this.pending.get(message.requestId);
    if (!pending || child !== pending.child || child !== this.bridge()) return true;
    if (this.closed || !pending.current()) {
      this.fail(message.requestId, '电脑设置窗口已变化，请重新读取');
      return true;
    }
    if (message.ok !== true) {
      this.fail(message.requestId, '电脑名称未确认或版本已变化，请重新读取后保存');
      return true;
    }
    try {
      const state = publicState(message.state);
      const action = pending.action;
      if (
        action.action === 'rename' &&
        (state.metadata.name !== action.name ||
          ![action.expectedRevision, action.expectedRevision + 1].includes(state.metadata.revision))
      )
        throw Error('电脑名称回执与原请求不一致');
      this.pending.delete(message.requestId);
      this.cancel(pending.timer);
      pending.resolve(state);
    } catch {
      this.fail(message.requestId, '电脑名称回执不可验证，请重新读取');
    }
    return true;
  }
  disconnect(child) {
    for (const [id, pending] of this.pending)
      if (pending.child === child) this.fail(id, '执行组件已重启，请重新读取电脑名称');
  }
  invalidate() {
    for (const [id, pending] of this.pending)
      if (!pending.current()) this.fail(id, '电脑设置窗口已关闭');
  }
  close() {
    this.closed = true;
    for (const id of this.pending.keys()) this.fail(id, 'Moor 已退出');
  }
}
module.exports = { DesktopDeviceMetadata, validateAction, publicState };
