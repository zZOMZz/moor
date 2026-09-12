const { randomUUID } = require('node:crypto');
const { isAbsolute } = require('node:path');
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const string = (value, max, empty = false) =>
  typeof value === 'string' &&
  (empty || value.length > 0) &&
  value.length <= max &&
  !value.includes('\0');
const identifier = (value) => string(value, 160) && /^[A-Za-z0-9_:-]+$/.test(value);
const revision = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
const args = (value) =>
  Array.isArray(value) && value.length <= 128 && value.every((part) => string(part, 4096, true));
function validateAction(value) {
  const fields = {
    read: [],
    builtin: ['agentType'],
    save: ['id', 'name', 'command', 'args', 'enabled'],
    enabled: ['id', 'enabled'],
    remove: ['id'],
    check: ['id', 'versionId'],
  };
  if (!object(value) || !Object.hasOwn(fields, value.action))
    throw new Error('Agent 本机设置请求无效');
  const allowed = [
    'action',
    ...fields[value.action],
    ...(value.action === 'read' ? [] : ['expectedRevision']),
  ];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    (value.action !== 'read' && !revision(value.expectedRevision))
  )
    throw new Error('请先刷新 Agent 本机设置');
  for (const field of fields[value.action]) {
    if (value.action === 'save' && ['id', 'enabled'].includes(field) && value[field] === undefined)
      continue;
    const valid =
      field === 'agentType'
        ? ['codex', 'claude'].includes(value[field])
        : field === 'enabled'
          ? typeof value[field] === 'boolean'
          : field === 'args'
            ? args(value[field])
            : field === 'command'
              ? string(value[field], 4096) && isAbsolute(value[field])
              : field === 'name'
                ? string(value[field], 100) && !/[\x00-\x1f\x7f]/.test(value[field])
                : identifier(value[field]);
    if (!valid) throw new Error('Agent 本机设置字段无效');
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 65536) throw new Error('Agent 本机设置请求过大');
  return structuredClone(value);
}
function capabilities(value) {
  if (
    !object(value) ||
    !Array.isArray(value.models) ||
    value.models.length > 500 ||
    !Array.isArray(value.modes) ||
    value.modes.length > 100
  )
    throw new Error('Agent 能力不可验证');
  const models = value.models.map((model) => {
    if (
      !object(model) ||
      !string(model.id, 300) ||
      !string(model.name, 300) ||
      !Array.isArray(model.efforts) ||
      model.efforts.length > 30 ||
      !model.efforts.every((effort) => string(effort, 300))
    )
      throw new Error('Agent 模型不可验证');
    return { id: model.id, name: model.name, efforts: [...model.efforts] };
  });
  const modes = value.modes.map((mode) => {
    if (
      !object(mode) ||
      !string(mode.id, 300) ||
      !string(mode.name, 300) ||
      (mode.description !== undefined && !string(mode.description, 4000, true))
    )
      throw new Error('Agent 审批模式不可验证');
    return {
      id: mode.id,
      name: mode.name,
      ...(mode.description === undefined ? {} : { description: mode.description }),
    };
  });
  if (value.effortConfigId !== undefined && !string(value.effortConfigId, 300))
    throw new Error('Agent effort 不可验证');
  return {
    models,
    modes,
    ...(value.effortConfigId === undefined ? {} : { effortConfigId: value.effortConfigId }),
  };
}
function publicState(value) {
  if (
    !object(value) ||
    !revision(value.revision) ||
    !Array.isArray(value.presets) ||
    value.presets.length > 100
  )
    throw new Error('Agent 本机状态不可验证');
  const presets = value.presets.map((preset) => {
    if (
      !object(preset) ||
      !identifier(preset.id) ||
      !identifier(preset.versionId) ||
      !string(preset.name, 100) ||
      !string(preset.cliType, 200) ||
      !string(preset.agentType, 200) ||
      typeof preset.enabled !== 'boolean'
    )
      throw new Error('Agent 配置状态不可验证');
    let launch = {};
    if (preset.cliType === 'custom') {
      if (!string(preset.command, 4096) || !isAbsolute(preset.command) || !args(preset.args))
        throw new Error('Agent 本机启动配置不可验证');
      launch = { command: preset.command, args: [...preset.args] };
    }
    let checked;
    if (preset.checked !== undefined) {
      const value = preset.checked;
      if (!object(value) || value.versionId !== preset.versionId || typeof value.ok !== 'boolean')
        throw new Error('Agent 检查版本不可验证');
      let inputCapabilities;
      if (value.inputCapabilities !== undefined) {
        if (
          !object(value.inputCapabilities) ||
          ['image', 'audio', 'embeddedContext'].some(
            (k) => typeof value.inputCapabilities[k] !== 'boolean',
          )
        )
          throw new Error('Agent 输入能力不可验证');
        inputCapabilities = Object.fromEntries(
          ['image', 'audio', 'embeddedContext'].map((k) => [k, value.inputCapabilities[k]]),
        );
      }
      checked = {
        versionId: value.versionId,
        ok: value.ok,
        ...(value.runConfig === undefined ? {} : { runConfig: capabilities(value.runConfig) }),
        ...(inputCapabilities ? { inputCapabilities } : {}),
        ...(!value.ok ? { error: 'Agent 连接检查失败，请检查本机程序与登录状态。' } : {}),
      };
    }
    return {
      id: preset.id,
      name: preset.name,
      versionId: preset.versionId,
      cliType: preset.cliType,
      agentType: preset.agentType,
      enabled: preset.enabled,
      ...launch,
      ...(checked ? { checked } : {}),
    };
  });
  if (new Set(presets.map((preset) => preset.id)).size !== presets.length)
    throw new Error('Agent 配置引用不可验证');
  return { revision: value.revision, presets };
}
class DesktopAgentSettings {
  /** @param {{bridge: () => any, schedule?: (callback: () => void) => unknown, cancel?: (timer: unknown) => void}} options */
  constructor({ bridge, schedule = (fn) => setTimeout(fn, 90000), cancel = clearTimeout }) {
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
      return Promise.reject(new Error('本机执行组件暂不可用，请稍后刷新 Agent 设置'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const pending = { child, current, resolve, reject, timer: undefined };
      this.pending.set(requestId, pending);
      pending.timer = this.schedule(() =>
        this.fail(requestId, 'Agent 设置结果尚未确认，请刷新检查；不会自动重试'),
      );
      try {
        child.send({ type: 'agent-config', requestId, action }, (error) => {
          if (error) this.fail(requestId, 'Agent 设置未能送达，请刷新本机连接');
        });
      } catch {
        this.fail(requestId, 'Agent 设置未能送达，请刷新本机连接');
      }
    });
  }
  fail(id, message) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.cancel(pending.timer);
    pending.reject(new Error(message));
  }
  receive(child, message) {
    if (message?.type !== 'agent-config-result') return false;
    const pending = this.pending.get(message.requestId);
    if (!pending || child !== pending.child || child !== this.bridge()) return true;
    if (this.closed || !pending.current()) {
      this.fail(message.requestId, 'Agent 设置窗口已变化，请重新打开');
      return true;
    }
    if (message.ok !== true) {
      this.fail(message.requestId, 'Agent 本机设置未确认，请刷新后检查配置与版本');
      return true;
    }
    try {
      const state = publicState(message.state);
      this.pending.delete(message.requestId);
      this.cancel(pending.timer);
      pending.resolve(state);
    } catch {
      this.fail(message.requestId, 'Agent 本机返回状态不可验证，请重新读取');
    }
    return true;
  }
  disconnect(child) {
    for (const [id, pending] of this.pending)
      if (pending.child === child) this.fail(id, '执行组件已重启，请刷新 Agent 设置确认保存状态');
  }
  invalidate() {
    for (const [id, pending] of this.pending)
      if (!pending.current()) this.fail(id, 'Agent 设置窗口已关闭');
  }
  close() {
    this.closed = true;
    for (const id of this.pending.keys()) this.fail(id, 'Moor 已退出');
  }
}
module.exports = { DesktopAgentSettings, validateAction, publicState };
