const { randomUUID } = require('node:crypto');
const { isAbsolute } = require('node:path');
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const string = (value, max, empty = false) =>
  typeof value === 'string' &&
  (empty || value.length > 0) &&
  value.length <= max &&
  !value.includes('\0');
const text = (value, max, empty = false) =>
  string(value, max, empty) && !/[\x00-\x1f\x7f]/.test(value);
const identifier = (value) => string(value, 160) && /^[A-Za-z0-9_:-]+$/.test(value);
const revision = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
const fields = (value, names) =>
  object(value) && Object.keys(value).every((key) => names.includes(key));
const args = (value) =>
  Array.isArray(value) && value.length <= 128 && value.every((part) => string(part, 4096, true));
const projectIds = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 100 &&
  value.every(identifier) &&
  new Set(value).size === value.length;
const envName = (name) => string(name, 100) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
const headerName = (name) =>
  string(name, 100) &&
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) &&
  ![
    'host',
    'content-length',
    'transfer-encoding',
    'connection',
    'upgrade',
    'proxy-authorization',
    'proxy-connection',
  ].includes(name.toLowerCase());
function names(value, header = false) {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every(header ? headerName : envName) &&
    new Set(value.map((name) => (header ? name.toLowerCase() : name))).size === value.length
  );
}
function privateMap(value, header = false) {
  return (
    object(value) &&
    names(Object.keys(value), header) &&
    Object.values(value).every((part) =>
      header ? text(part, 8192, true) : string(part, 8192, true),
    )
  );
}
function url(value) {
  if (!text(value, 4096)) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.href === value &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      (parsed.protocol === 'https:' ||
        (parsed.protocol === 'http:' &&
          ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname)))
    );
  } catch {
    return false;
  }
}
function connection(value, reading = false) {
  if (!object(value)) return false;
  if (value.transport === 'stdio')
    return (
      (reading || fields(value, ['transport', 'command', 'args', 'env'])) &&
      text(value.command, 4096) &&
      isAbsolute(value.command) &&
      args(value.args) &&
      (reading ? names(value.envNames) : value.env === undefined || privateMap(value.env))
    );
  return (
    ['http', 'sse'].includes(value.transport) &&
    (reading || fields(value, ['transport', 'url', 'headers'])) &&
    url(value.url) &&
    (reading
      ? names(value.headerNames, true)
      : value.headers === undefined || privateMap(value.headers, true))
  );
}
function validateAction(value) {
  const common = ['action', 'expectedRevision', 'id'];
  const valid =
    object(value) &&
    (value.action === 'read'
      ? fields(value, ['action'])
      : revision(value.expectedRevision) &&
        (value.action === 'save'
          ? fields(value, [
              ...common,
              'name',
              'description',
              'projectIds',
              'enabled',
              'connection',
            ]) &&
            (value.id === undefined || identifier(value.id)) &&
            text(value.name, 100) &&
            !!value.name.trim() &&
            text(value.description, 2000, true) &&
            projectIds(value.projectIds) &&
            (value.enabled === undefined || typeof value.enabled === 'boolean') &&
            connection(value.connection)
          : value.action === 'enabled'
            ? fields(value, [...common, 'enabled']) &&
              identifier(value.id) &&
              typeof value.enabled === 'boolean'
            : value.action === 'remove' && fields(value, common) && identifier(value.id)));
  if (!valid) throw new Error('MCP 本机设置请求无效');
  if (Buffer.byteLength(JSON.stringify(value)) > 65536) throw new Error('MCP 本机设置请求过大');
  return structuredClone(value);
}
// This projection is local-only. Credential values from a malformed host response
// are discarded; only explicitly permitted editor fields reach the settings frame.
function publicState(value) {
  if (
    !object(value) ||
    !revision(value.revision) ||
    !Array.isArray(value.projects) ||
    value.projects.length > 10000 ||
    !Array.isArray(value.presets) ||
    value.presets.length > 100 ||
    Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024
  )
    throw new Error('MCP 本机状态不可验证');
  const projects = value.projects.map((project) => {
    if (!object(project) || !identifier(project.id) || !text(project.name, 300))
      throw new Error('MCP 本机项目不可验证');
    return { id: project.id, name: project.name };
  });
  const presets = value.presets.map((preset) => {
    if (
      !object(preset) ||
      !identifier(preset.id) ||
      !/^mcpv_[a-f0-9]{32}$/.test(preset.versionId) ||
      !text(preset.name, 100) ||
      !preset.name.trim() ||
      !text(preset.description, 2000, true) ||
      !projectIds(preset.projectIds) ||
      typeof preset.enabled !== 'boolean' ||
      !connection(preset.connection, true)
    )
      throw new Error('MCP 本机配置不可验证');
    const c = preset.connection;
    return {
      id: preset.id,
      versionId: preset.versionId,
      name: preset.name,
      description: preset.description,
      projectIds: [...preset.projectIds],
      enabled: preset.enabled,
      connection:
        c.transport === 'stdio'
          ? {
              transport: c.transport,
              command: c.command,
              args: [...c.args],
              envNames: [...c.envNames],
            }
          : { transport: c.transport, url: c.url, headerNames: [...c.headerNames] },
    };
  });
  if (
    new Set(projects.map((p) => p.id)).size !== projects.length ||
    new Set(presets.map((p) => p.id)).size !== presets.length ||
    new Set(presets.map((p) => p.versionId)).size !== presets.length
  )
    throw new Error('MCP 本机引用不可验证');
  return { revision: value.revision, projects, presets };
}
class DesktopMcpSettings {
  /** @param {{bridge: () => any, schedule?: (callback: () => void) => unknown, cancel?: (timer: unknown) => void}} options */
  constructor({ bridge, schedule = (fn) => setTimeout(fn, 30000), cancel = clearTimeout }) {
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
      return Promise.reject(new Error('本机执行组件暂不可用，请稍后刷新 MCP 设置'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const pending = { child, current, resolve, reject, timer: undefined };
      this.pending.set(requestId, pending);
      pending.timer = this.schedule(() =>
        this.fail(requestId, 'MCP 设置结果尚未确认，请刷新检查；不会自动重试'),
      );
      try {
        child.send({ type: 'mcp-config', requestId, action }, (error) => {
          if (error) this.fail(requestId, 'MCP 设置未能送达，请刷新本机连接');
        });
      } catch {
        this.fail(requestId, 'MCP 设置未能送达，请刷新本机连接');
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
    if (message?.type !== 'mcp-config-result') return false;
    const pending = this.pending.get(message.requestId);
    if (!pending || child !== pending.child || child !== this.bridge()) return true;
    if (this.closed || !pending.current()) {
      this.fail(message.requestId, 'MCP 设置窗口已变化，请重新打开');
      return true;
    }
    if (message.ok !== true) {
      this.fail(message.requestId, 'MCP 本机设置未确认，请刷新后检查配置与版本');
      return true;
    }
    try {
      const state = publicState(message.state);
      this.pending.delete(message.requestId);
      this.cancel(pending.timer);
      pending.resolve(state);
    } catch {
      this.fail(message.requestId, 'MCP 本机返回状态不可验证，请重新读取');
    }
    return true;
  }
  disconnect(child) {
    for (const [id, pending] of this.pending)
      if (pending.child === child) this.fail(id, '执行组件已重启，请刷新 MCP 设置确认保存状态');
  }
  invalidate() {
    for (const [id, pending] of this.pending)
      if (!pending.current()) this.fail(id, 'MCP 设置窗口已关闭');
  }
  close() {
    this.closed = true;
    for (const id of this.pending.keys()) this.fail(id, 'Moor 已退出');
  }
}
module.exports = { DesktopMcpSettings, validateAction, publicState };
