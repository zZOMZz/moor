const { randomUUID } = require('node:crypto');
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const string = (v, max) =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
function validateAction(value) {
  const fields = {
    read: [],
    'source-save': ['id', 'label', 'rootPath', 'enabled'],
    'source-remove': ['id'],
    'source-enabled': ['id', 'enabled'],
  };
  if (!object(value) || !Object.hasOwn(fields, value.action))
    throw new Error('Skills 本机设置请求无效');
  const allowed = [
    'action',
    ...fields[value.action],
    ...(value.action === 'read' ? [] : ['expectedRevision']),
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('Skills 本机设置请求无效');
  if (
    value.action !== 'read' &&
    (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0)
  )
    throw new Error('请先刷新 Skills 本机设置');
  for (const field of fields[value.action]) {
    if (
      value.action === 'source-save' &&
      ['id', 'enabled'].includes(field) &&
      value[field] === undefined
    )
      continue;
    if (field === 'enabled') {
      if (typeof value.enabled !== 'boolean') throw new Error('Skills 设置字段无效');
    } else if (
      !string(value[field], field === 'label' ? 100 : field === 'rootPath' ? 4096 : 160) ||
      (field === 'rootPath' && !require('node:path').isAbsolute(value.rootPath))
    )
      throw new Error('Skills 设置字段无效');
  }
  return structuredClone(value);
}
function publicState(value) {
  if (
    !object(value) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.sources) ||
    value.sources.length > 20
  )
    throw new Error('Skills 本机返回状态不可验证');
  const sources = value.sources.map((source) => {
    if (
      !object(source) ||
      !string(source.id, 160) ||
      !string(source.label, 100) ||
      !string(source.rootPath, 4096) ||
      !require('node:path').isAbsolute(source.rootPath) ||
      typeof source.enabled !== 'boolean' ||
      typeof source.current !== 'boolean'
    )
      throw new Error('Skills 目录状态不可验证');
    return {
      id: source.id,
      label: source.label,
      rootPath: source.rootPath,
      enabled: source.enabled,
      current: source.current,
    };
  });
  if (
    new Set(sources.map((s) => s.id)).size !== sources.length ||
    new Set(sources.map((s) => s.rootPath)).size !== sources.length
  )
    throw new Error('Skills 目录引用不可验证');
  return { revision: value.revision, sources };
}
const safeErrors = new Set([
  'Skills 私有配置必须保存在项目目录外',
  'Skills 私有配置目录不可验证',
  'Skills 本机配置权限或格式需要检查',
  'Skills 本机配置已变化，请刷新',
  'Skills 配置不属于当前执行主机账号',
  'Skills 本机配置无法安全读取',
  'Skills 本机设置请求无效',
  'Skills 目录登记不存在',
  'Skills 目录必须是存在的真实目录，不能是符号链接',
  'Skills 目录已变化，请重新登记',
  'Skills 目录不可用，请重新登记',
  'Skills 私有目录范围不可验证',
  'Skills 目录不能包含或位于 Moor 私有数据目录',
  'Skills 目录已经登记',
  'Skills 目录数量超过限制',
  'Skills 本机配置保存失败，请重新读取',
]);
class DesktopSkillsSettings {
  /** @param {{bridge: () => any, schedule?: (callback: () => void) => unknown, cancel?: (timer: unknown) => void}} options */
  constructor({ bridge, schedule = (fn) => setTimeout(fn, 20000), cancel = clearTimeout }) {
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
      return Promise.reject(new Error('本机执行组件暂不可用，请稍后刷新 Skills 设置'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const pending = { child, current, resolve, reject, timer: undefined };
      this.pending.set(requestId, pending);
      pending.timer = this.schedule(() =>
        this.fail(requestId, 'Skills 设置结果尚未确认，请刷新检查；不会自动重试'),
      );
      try {
        child.send({ type: 'skills-config', requestId, action }, (error) => {
          if (error) this.fail(requestId, 'Skills 设置未能送达，请刷新本机连接');
        });
      } catch {
        this.fail(requestId, 'Skills 设置未能送达，请刷新本机连接');
      }
    });
  }
  fail(requestId, message) {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    this.cancel(pending.timer);
    pending.reject(new Error(message));
  }
  receive(child, message) {
    if (message?.type !== 'skills-config-result') return false;
    const pending = this.pending.get(message.requestId);
    if (!pending || child !== pending.child || child !== this.bridge()) return true;
    if (this.closed || !pending.current()) {
      this.fail(message.requestId, 'Skills 设置窗口已变化，请重新打开');
      return true;
    }
    if (message.ok !== true) {
      this.fail(
        message.requestId,
        safeErrors.has(message.error) ? message.error : 'Skills 本机设置操作失败，请刷新后检查',
      );
      return true;
    }
    try {
      const state = publicState(message.state);
      this.pending.delete(message.requestId);
      this.cancel(pending.timer);
      pending.resolve(state);
    } catch {
      this.fail(message.requestId, 'Skills 本机返回状态不可验证，请重新读取');
    }
    return true;
  }
  disconnect(child) {
    for (const [id, p] of this.pending)
      if (p.child === child) this.fail(id, '执行组件已重启，请刷新 Skills 设置确认保存状态');
  }
  invalidate() {
    for (const [id, p] of this.pending) if (!p.current()) this.fail(id, 'Skills 设置窗口已关闭');
  }
  close() {
    this.closed = true;
    for (const id of this.pending.keys()) this.fail(id, 'Moor 已退出');
  }
}
module.exports = { DesktopSkillsSettings, validateAction, publicState };
