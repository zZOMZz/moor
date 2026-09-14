const { randomUUID, createHash } = require('node:crypto');
const { realpathSync } = require('node:fs');
const { isAbsolute } = require('node:path');
const { isDeepStrictEqual } = require('node:util');

class DesktopProjectRegistration {
  constructor({ bridge, schedule = (fn) => setTimeout(fn, 15000), cancel = clearTimeout }) {
    this.bridge = bridge;
    this.schedule = schedule;
    this.cancel = cancel;
    this.pending = new Map();
    this.closed = false;
  }
  request(path, identity, current) {
    const child = this.bridge();
    if (this.closed || !current() || !child?.connected || this.pending.size)
      return Promise.reject(Error('本机执行组件不可用或正在登记项目，请稍后重试。'));
    if (typeof path !== 'string' || !isAbsolute(path))
      return Promise.reject(Error('项目目录无效。'));
    const action = {
      path: realpathSync(path),
      identity: {
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        machineId: identity.machineId,
      },
    };
    const projectId =
      'project_' + createHash('sha256').update(action.path).digest('hex').slice(0, 24);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const pending = { child, current, action, projectId, resolve, reject, timer: undefined };
      this.pending.set(requestId, pending);
      pending.timer = this.schedule(() =>
        this.fail(requestId, '项目登记结果尚未确认，请刷新本机项目后检查；不会自动重试。'),
      );
      try {
        child.send({ type: 'register-project', requestId, action }, (error) => {
          if (error) this.fail(requestId, '项目登记未能送达，请检查本机连接。');
        });
      } catch {
        this.fail(requestId, '项目登记未能送达，请检查本机连接。');
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
    if (message?.type !== 'register-project-result') return false;
    const pending = this.pending.get(message.requestId);
    if (!pending || child !== pending.child || child !== this.bridge()) return true;
    if (this.closed || !pending.current()) {
      this.fail(message.requestId, '本机连接或窗口已变化，请刷新项目列表确认登记结果。');
      return true;
    }
    if (
      message.ok !== true ||
      !isDeepStrictEqual(message.state, {
        identity: pending.action.identity,
        path: pending.action.path,
        projectId: pending.projectId,
      })
    ) {
      this.fail(
        message.requestId,
        '项目登记未确认。请检查目录是否可访问、是否包含 Moor 私有数据，或刷新本机项目后重试。',
      );
      return true;
    }
    this.pending.delete(message.requestId);
    this.cancel(pending.timer);
    pending.resolve(structuredClone(message.state));
    return true;
  }
  disconnect(child) {
    for (const [id, pending] of this.pending)
      if (pending.child === child) this.fail(id, '本机连接已断开，请刷新项目列表确认登记结果。');
  }
  invalidate() {
    for (const [id, pending] of this.pending)
      if (!pending.current()) this.fail(id, '窗口已变化，请刷新项目列表确认登记结果。');
  }
  close() {
    this.closed = true;
    for (const id of this.pending.keys()) this.fail(id, 'Moor 已退出。');
  }
}
module.exports = { DesktopProjectRegistration };
