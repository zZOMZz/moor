const { randomUUID } = require('node:crypto');
function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}
function string(value, max) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
function validateAction(value) {
  const fields = {
    read: [],
    'credential-save': ['credentialId', 'label', 'token'],
    'credential-remove': ['credentialId'],
    'credential-check': ['credentialId'],
    'project-bind': ['localProjectId', 'credentialId', 'owner', 'repo'],
    'project-unbind': ['localProjectId'],
    'project-check': ['localProjectId'],
    'project-writes': ['localProjectId', 'enabled'],
  };
  if (!object(value) || !Object.hasOwn(fields, value.action))
    throw new Error('GitHub 本机设置请求无效');
  const allowed = [
    'action',
    ...fields[value.action],
    ...(value.action === 'read' ? [] : ['expectedRevision']),
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('GitHub 本机设置请求无效');
  if (
    value.action !== 'read' &&
    (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0)
  )
    throw new Error('请先刷新 GitHub 本机设置');
  for (const field of fields[value.action]) {
    if (field === 'enabled') {
      if (typeof value.enabled !== 'boolean') throw new Error('GitHub 本机设置字段无效');
      continue;
    }
    if (
      field === 'credentialId' &&
      value.action === 'credential-save' &&
      value[field] === undefined
    )
      continue;
    if (
      !string(
        value[field],
        field === 'token'
          ? 4096
          : field === 'label' || field === 'repo'
            ? 100
            : field === 'owner'
              ? 39
              : 160,
      )
    )
      throw new Error('GitHub 本机设置字段无效');
  }
  return structuredClone(value);
}
function status(value) {
  if (!object(value) || !['unchecked', 'connected', 'denied', 'unavailable'].includes(value.state))
    throw new Error('GitHub 本机状态不可验证');
  return {
    state: value.state,
    ...(Number.isSafeInteger(value.checkedAt) && value.checkedAt >= 0
      ? { checkedAt: value.checkedAt }
      : {}),
    ...(string(value.login, 39) ? { login: value.login } : {}),
  };
}
const safeHostErrors = new Set([
  'GitHub 本机配置已变化，请刷新',
  'GitHub 本机配置请求无效',
  'GitHub 本机配置保存失败，请重新读取状态',
  'GitHub 本机配置无法安全读取',
  'GitHub 本机配置权限或格式需要检查',
  'GitHub 配置不属于当前执行主机账号',
  'GitHub 私有数据目录不可验证',
  'GitHub 私有数据目录不能位于已登记项目内，请将运行数据迁移到代码目录外',
  'GitHub 凭据不存在',
  '项目尚未登记在此执行主机',
  '项目 GitHub 登记已变化，请重新登记',
  '项目目录不可用，请重新登记项目',
  '项目目录已变化，请重新登记',
  '项目 GitHub 登记不存在',
  '启用外部写入前请先验证项目仓库',
]);
// Whitelist every renderer field: a malformed child response can never return a
// saved token, private file record, or an arbitrary extra credential property.
function publicState(value) {
  if (
    !object(value) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.credentials) ||
    value.credentials.length > 20 ||
    !Array.isArray(value.projects) ||
    value.projects.length > 100
  )
    throw new Error('GitHub 本机状态不可验证');
  const credentials = value.credentials.map((credential) => {
    if (!object(credential) || !string(credential.id, 160) || !string(credential.label, 100))
      throw new Error('GitHub 凭据状态不可验证');
    return { id: credential.id, label: credential.label, status: status(credential.status) };
  });
  const projects = value.projects.map((project) => {
    if (
      !object(project) ||
      !string(project.id, 160) ||
      !string(project.name, 200) ||
      !string(project.rootPath, 4096)
    )
      throw new Error('GitHub 项目状态不可验证');
    const result = { id: project.id, name: project.name, rootPath: project.rootPath };
    if (project.binding) {
      const b = project.binding;
      if (
        !object(b) ||
        !string(b.credentialId, 160) ||
        !string(b.owner, 39) ||
        !string(b.repo, 100) ||
        typeof b.current !== 'boolean' ||
        (b.repositoryId !== undefined &&
          (!Number.isSafeInteger(b.repositoryId) || b.repositoryId <= 0))
      )
        throw new Error('GitHub 仓库绑定不可验证');
      result.binding = {
        credentialId: b.credentialId,
        owner: b.owner,
        repo: b.repo,
        current: b.current,
        status: status(b.status),
        ...(typeof b.writesEnabled === 'boolean' ? { writesEnabled: b.writesEnabled } : {}),
        ...(b.repositoryId === undefined ? {} : { repositoryId: b.repositoryId }),
      };
    }
    return result;
  });
  if (
    new Set(credentials.map((c) => c.id)).size !== credentials.length ||
    new Set(projects.map((p) => p.id)).size !== projects.length ||
    projects.some((p) => p.binding && !credentials.some((c) => c.id === p.binding.credentialId))
  )
    throw new Error('GitHub 本机状态引用不可验证');
  return { revision: value.revision, credentials, projects };
}
class DesktopGitHubSettings {
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
      return Promise.reject(new Error('本机执行组件暂不可用，请稍后刷新 GitHub 设置'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const pending = { child, current, resolve, reject, timer: undefined };
      this.pending.set(requestId, pending);
      pending.timer = this.schedule(() =>
        this.fail(requestId, 'GitHub 设置结果尚未确认，请刷新后检查；不会自动重试'),
      );
      try {
        child.send({ type: 'github-config', requestId, action }, (error) => {
          if (error) this.fail(requestId, 'GitHub 设置未能送达，请刷新本机连接');
        });
      } catch {
        this.fail(requestId, 'GitHub 设置未能送达，请刷新本机连接');
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
    if (message?.type !== 'github-config-result') return false;
    const pending = this.pending.get(message.requestId);
    if (!pending || child !== pending.child || child !== this.bridge()) return true;
    if (this.closed || !pending.current()) {
      this.fail(message.requestId, 'GitHub 设置窗口已变化，请重新打开');
      return true;
    }
    if (message.ok !== true) {
      this.fail(
        message.requestId,
        safeHostErrors.has(message.error)
          ? message.error
          : 'GitHub 本机配置操作失败，请刷新设置并检查凭据、项目与连接',
      );
      return true;
    }
    try {
      const value = publicState(message.state);
      this.pending.delete(message.requestId);
      this.cancel(pending.timer);
      pending.resolve(value);
    } catch {
      this.fail(message.requestId, 'GitHub 本机返回状态不可验证，请重新读取');
    }
    return true;
  }
  disconnect(child) {
    for (const [id, pending] of this.pending)
      if (pending.child === child) this.fail(id, '执行组件已重启，请刷新 GitHub 设置确认保存状态');
  }
  invalidate() {
    for (const [id, pending] of this.pending)
      if (!pending.current()) this.fail(id, 'GitHub 设置窗口已关闭');
  }
  close() {
    this.closed = true;
    for (const id of this.pending.keys()) this.fail(id, 'Moor 已退出');
  }
}
module.exports = { DesktopGitHubSettings, publicState, validateAction };
