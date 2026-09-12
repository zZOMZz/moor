const { randomUUID } = require('node:crypto');
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const string = (v, max) =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
function validateAction(value) {
  const fields = {
    read: [],
    'service-save': [
      'id',
      'localProjectId',
      'executionId',
      'label',
      'address',
      'port',
      'startPath',
      'enabled',
    ],
    'service-remove': ['id'],
    'service-enabled': ['id', 'enabled'],
  };
  if (!object(value) || !Object.hasOwn(fields, value.action))
    throw new Error('预览本机设置请求无效');
  const allowed = [
    'action',
    ...fields[value.action],
    ...(value.action === 'read' ? [] : ['expectedRevision']),
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('预览本机设置请求无效');
  if (
    value.action !== 'read' &&
    (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0)
  )
    throw new Error('请先刷新预览本机设置');
  for (const field of fields[value.action]) {
    if (
      value.action === 'service-save' &&
      ['id', 'enabled'].includes(field) &&
      value[field] === undefined
    )
      continue;
    if (field === 'enabled') {
      if (typeof value.enabled !== 'boolean') throw new Error('预览设置字段无效');
    } else if (field === 'port') {
      if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535)
        throw new Error('请填写有效的预览端口');
    } else if (field === 'address') {
      if (!['127.0.0.1', '::1'].includes(value.address)) throw new Error('预览仅支持本机回环地址');
    } else if (!string(value[field], field === 'label' ? 100 : field === 'startPath' ? 2048 : 160))
      throw new Error('预览设置字段无效');
  }
  return structuredClone(value);
}
function publicState(value) {
  if (
    !object(value) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.targets) ||
    value.targets.length > 1000 ||
    !Array.isArray(value.services) ||
    value.services.length > 100
  )
    throw new Error('预览本机返回状态不可验证');
  const targets = value.targets.map((target) => {
    if (
      !object(target) ||
      !string(target.localProjectId, 160) ||
      !string(target.executionId, 160) ||
      !string(target.label, 200) ||
      !string(target.rootPath, 4096) ||
      !string(target.projectRoot, 4096)
    )
      throw new Error('预览执行目录不可验证');
    return {
      localProjectId: target.localProjectId,
      executionId: target.executionId,
      label: target.label,
      rootPath: target.rootPath,
      projectRoot: target.projectRoot,
    };
  });
  const services = value.services.map((service) => {
    if (
      !object(service) ||
      !string(service.id, 160) ||
      !string(service.label, 100) ||
      !string(service.localProjectId, 160) ||
      !string(service.executionId, 160) ||
      !['127.0.0.1', '::1'].includes(service.address) ||
      !Number.isInteger(service.port) ||
      service.port < 1 ||
      service.port > 65535 ||
      !string(service.startPath, 2048) ||
      typeof service.enabled !== 'boolean' ||
      typeof service.current !== 'boolean'
    )
      throw new Error('预览服务状态不可验证');
    return {
      id: service.id,
      localProjectId: service.localProjectId,
      executionId: service.executionId,
      label: service.label,
      address: service.address,
      port: service.port,
      startPath: service.startPath,
      enabled: service.enabled,
      current: service.current,
    };
  });
  if (
    new Set(services.map((s) => s.id)).size !== services.length ||
    new Set(targets.map((t) => JSON.stringify([t.localProjectId, t.executionId]))).size !==
      targets.length ||
    services.some(
      (s) =>
        s.current &&
        !targets.some(
          (t) => t.localProjectId === s.localProjectId && t.executionId === s.executionId,
        ),
    )
  )
    throw new Error('预览服务引用不可验证');
  return { revision: value.revision, targets, services };
}
const safeErrors = new Set([
  '预览私有配置必须保存在项目目录外',
  '预览私有配置目录不可验证',
  '预览本机配置权限或格式需要检查',
  '预览本机配置已变化，请刷新',
  '预览配置不属于当前执行主机账号',
  '预览本机配置无法安全读取',
  '预览本机设置请求无效',
  '预览服务登记不存在',
  '预览执行目录不存在或尚未就绪，请刷新',
  '预览执行目录不可用，请刷新本机设置',
  '不能将 Moor 自身的服务登记为项目预览',
  '该执行目录的预览服务超过限制',
  '该预览地址已登记到其他执行目录，请先删除原登记',
  '修改执行目录前请删除原服务登记',
  '预览登记的执行目录或地址已变化，请重新登记',
  '预览本机配置保存失败，请重新读取',
]);
class DesktopPreviewSettings {
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
      return Promise.reject(new Error('本机执行组件暂不可用，请稍后刷新预览设置'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const pending = { child, current, resolve, reject, timer: undefined };
      this.pending.set(requestId, pending);
      pending.timer = this.schedule(() =>
        this.fail(requestId, '预览设置结果尚未确认，请刷新检查；不会自动重试'),
      );
      try {
        child.send({ type: 'preview-config', requestId, action }, (error) => {
          if (error) this.fail(requestId, '预览设置未能送达，请刷新本机连接');
        });
      } catch {
        this.fail(requestId, '预览设置未能送达，请刷新本机连接');
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
    if (message?.type !== 'preview-config-result') return false;
    const pending = this.pending.get(message.requestId);
    if (!pending || child !== pending.child || child !== this.bridge()) return true;
    if (this.closed || !pending.current()) {
      this.fail(message.requestId, '预览设置窗口已变化，请重新打开');
      return true;
    }
    if (message.ok !== true) {
      this.fail(
        message.requestId,
        safeErrors.has(message.error) ? message.error : '预览本机设置操作失败，请刷新后检查',
      );
      return true;
    }
    try {
      const state = publicState(message.state);
      this.pending.delete(message.requestId);
      this.cancel(pending.timer);
      pending.resolve(state);
    } catch {
      this.fail(message.requestId, '预览本机返回状态不可验证，请重新读取');
    }
    return true;
  }
  disconnect(child) {
    for (const [id, p] of this.pending)
      if (p.child === child) this.fail(id, '执行组件已重启，请刷新预览设置确认保存状态');
  }
  invalidate() {
    for (const [id, p] of this.pending) if (!p.current()) this.fail(id, '预览设置窗口已关闭');
  }
  close() {
    this.closed = true;
    for (const id of this.pending.keys()) this.fail(id, 'Moor 已退出');
  }
}
module.exports = { DesktopPreviewSettings, validateAction, publicState };
