import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleStart } from './google-login';
import { SecureWorkspaceController, type SecureWorkspaceState } from './secure-controller';
import type {
  DesktopSecureRequest,
  DesktopSecureStatus,
} from '../security/desktop-client-protocol';
import type { RootPublicJwk } from '../security/e2ee-trust';

type Account = {
  origin: string;
  owner: string | null;
  needsSetup: boolean;
  google: { enabled: boolean };
};
type AccountResult =
  | { ok: true; value: Account | { loggedOut: true } }
  | { ok: false; error: { message: string } };
export type SecureAccountApi = (request: { action: 'status' | 'logout' }) => Promise<AccountResult>;
export type SecureUiController = Pick<
  SecureWorkspaceController,
  | 'state'
  | 'subscribe'
  | 'refreshStatus'
  | 'device'
  | 'connect'
  | 'disconnect'
  | 'selectHost'
  | 'selectReplica'
  | 'refreshSessions'
  | 'openSession'
  | 'refreshSession'
  | 'createSession'
  | 'send'
  | 'stop'
  | 'metadata'
  | 'recover'
  | 'refreshOperations'
  | 'saveDraft'
  | 'close'
  | 'invalidate'
>;
const failure = (value: unknown) =>
  value instanceof Error ? value.message : '操作尚未确认，请核对后手动继续。';
const phaseLabels = {
  empty: '尚未配对',
  cancelled: '配对已取消',
  pending: '等待批准',
  revoked: '设备已撤销',
  active: '设备已授权',
} as const;
const operationLabels = {
  pending: '结果待确认',
  ending: '正在确认放弃',
  accepted: '主机已接受',
  abandoned: '主机已确认放弃',
  rejected: '主机已拒绝',
} as const;

type Run = (action: () => Promise<void>) => void;
function DevicePanel({
  account,
  status,
  busy,
  run,
  controller,
}: {
  account: Account;
  status: DesktopSecureStatus | null;
  busy: boolean;
  run: Run;
  controller: SecureUiController;
}) {
  const [rootKeyId, setRootKeyId] = useState('');
  const [parseError, setParseError] = useState('');
  const device = status?.device;
  const pending = device && 'pending' in device ? device.pending : null;
  return (
    <details className="secure-device secure-card" open={!device || device.phase !== 'active'}>
      <summary>
        <span>此设备</span>
        <span className="secure-status">{device ? phaseLabels[device.phase] : '正在读取…'}</span>
      </summary>
      <div className="secure-device-body">
        <p className="secure-muted">
          配对会把这台 Mac 授权为加密客户端。请向已有的可信设备核对根指纹。
        </p>
        {device && 'deviceId' in device && (
          <dl className="secure-facts">
            <dt>设备</dt>
            <dd>{device.deviceId}</dd>
            <dt>信任版本</dt>
            <dd>{device.trustEpoch ?? '尚未批准'}</dd>
            <dt>根指纹</dt>
            <dd>{device.pin.rootKeyId}</dd>
          </dl>
        )}
        {device && (device.phase === 'empty' || device.phase === 'cancelled') && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              run(() =>
                controller.device({
                  action: 'device-pair',
                  expectedRevision: device.revision,
                  pin: {
                    serverOrigin: account.origin,
                    accountId: account.owner!,
                    rootKeyId: rootKeyId.trim(),
                  },
                }),
              );
            }}
          >
            <label>
              账号根指纹
              <input
                value={rootKeyId}
                onChange={(event) => setRootKeyId(event.target.value)}
                required
                minLength={43}
                maxLength={43}
                pattern={'[A-Za-z0-9_\\-]{43}'}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
            </label>
            <button type="submit" disabled={busy}>
              生成配对请求
            </button>
          </form>
        )}
        {pending && device && 'deviceId' in device && (
          <>
            <p>
              {pending.expired
                ? '配对请求已过期，请先续期。'
                : '在已有的可信设备上核对请求指纹，再批准此配对。'}
            </p>
            <label>
              请求指纹<output className="secure-code">{pending.fingerprint}</output>
            </label>
            <label>
              公开配对请求
              <textarea
                className="secure-json"
                readOnly
                rows={5}
                value={JSON.stringify(pending.request, null, 2)}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <div className="secure-actions">
              <button
                disabled={busy}
                onClick={() =>
                  run(() =>
                    controller.device({
                      action: 'device-renew',
                      expectedRevision: device.revision,
                    }),
                  )
                }
              >
                续期请求
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  run(() =>
                    controller.device({
                      action: 'device-cancel',
                      expectedRevision: device.revision,
                    }),
                  )
                }
              >
                取消配对
              </button>
            </div>
            <p className="secure-muted">
              取消仅作废本机的待配对请求；不会撤销已在其他设备签发的授权。
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                setParseError('');
                let rootPublicKey: RootPublicJwk;
                try {
                  rootPublicKey = JSON.parse(
                    String(data.get('rootPublicKey') ?? ''),
                  ) as RootPublicJwk;
                } catch {
                  setParseError('根公钥需要是有效的 JSON。');
                  return;
                }
                const request: DesktopSecureRequest = {
                  action: 'device-accept',
                  expectedRevision: device.revision,
                  approval: String(data.get('approval') ?? '').trim(),
                  rootPublicKey,
                  signedManifest: String(data.get('signedManifest') ?? '').trim(),
                };
                run(() => controller.device(request));
              }}
            >
              <label>
                配对批准
                <textarea
                  name="approval"
                  required
                  maxLength={16384}
                  rows={3}
                  spellCheck={false}
                  disabled={busy || pending.expired}
                />
              </label>
              <label>
                根公钥 JSON
                <textarea
                  name="rootPublicKey"
                  required
                  maxLength={4096}
                  rows={3}
                  spellCheck={false}
                  disabled={busy || pending.expired}
                />
              </label>
              <label>
                签名设备清单
                <textarea
                  name="signedManifest"
                  required
                  maxLength={65536}
                  rows={3}
                  spellCheck={false}
                  disabled={busy || pending.expired}
                />
              </label>
              <button type="submit" disabled={busy || pending.expired}>
                核对并接受配对
              </button>
              {parseError && <p role="alert">{parseError}</p>}
            </form>
          </>
        )}
        {device?.phase === 'revoked' && (
          <p role="status">此设备当前已撤销。请在可信设备上处理信任状态后再继续。</p>
        )}
        {device && 'devices' in device && device.devices.length > 0 && (
          <details>
            <summary>已授权设备 · {device.devices.length}</summary>
            <ul className="secure-device-list">
              {device.devices.map((entry) => (
                <li key={entry.deviceId}>
                  <strong>{entry.deviceId}</strong>
                  <span>
                    {entry.roles
                      .map((role) => (role === 'host' ? '执行主机' : '客户端'))
                      .join('、')}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
        <button disabled={busy} onClick={() => run(() => controller.refreshStatus())}>
          刷新设备状态
        </button>
      </div>
    </details>
  );
}

function displayText(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 120000);
  try {
    return JSON.stringify(value, null, 2)?.slice(0, 120000) ?? '';
  } catch {
    return '此项内容无法显示';
  }
}
function HistoryItem({ value, finished }: { value: unknown; finished: boolean }) {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (item.type === 'text') return <p className="secure-message-text">{displayText(item.text)}</p>;
  if (item.type === 'thought')
    return (
      <details>
        <summary>思考过程</summary>
        <pre>{displayText(item.text)}</pre>
      </details>
    );
  if (item.type === 'tool_call') {
    const permission = item.permissionRequest as { outcome?: unknown } | undefined;
    return (
      <div className="secure-tool">
        <details>
          <summary>
            {displayText(item.title ?? item.kind ?? '工具调用')} · {displayText(item.status)}
          </summary>
          <pre>{displayText(item.content ?? item.rawOutput ?? item.rawInput)}</pre>
        </details>
        {permission && !permission.outcome && !finished && (
          <p className="secure-warning" role="status">
            此回合等待批准。请在执行电脑处理这次请求，然后刷新会话。
          </p>
        )}
      </div>
    );
  }
  if (item.type === 'system_notice') {
    const meta = item.meta as { message?: unknown } | undefined;
    return (
      <p className="secure-muted">
        {displayText(meta?.message ?? item.message ?? item.text ?? item.name)}
      </p>
    );
  }
  if (item.type === 'attachment')
    return (
      <details>
        <summary>附件记录</summary>
        <pre>{displayText(item.attachment)}</pre>
      </details>
    );
  return (
    <details>
      <summary>会话记录 · {displayText(item.type ?? '内容')}</summary>
      <pre>{displayText(item)}</pre>
    </details>
  );
}

function Composer({
  state,
  controller,
  run,
  onDirty,
}: {
  state: SecureWorkspaceState;
  controller: SecureUiController;
  run: Run;
  onDirty: (value: boolean) => void;
}) {
  const [text, setText] = useState(state.draft);
  const session = state.session!;
  const dirty = text !== state.draft;
  useEffect(() => {
    setText(state.draft);
  }, [state.draft]);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  const running =
    session.meta.status?.type === 'working' ||
    session.history.some((turn) => turn.role === 'assistant' && !turn.finished);
  const device = state.status?.device;
  const selectedReplica = state.catalog?.products.replicas.find(
    (entry) => entry.id === state.replicaId,
  );
  const blocked = state.operations.some(
    (operation) =>
      ['pending', 'ending'].includes(operation.state) &&
      device &&
      'deviceId' in device &&
      operation.target.origin === device.pin.serverOrigin &&
      operation.target.owner === device.pin.accountId &&
      operation.target.rootKeyId === device.pin.rootKeyId &&
      operation.target.clientDeviceId === device.deviceId &&
      operation.target.hostDeviceId === state.hostId &&
      operation.target.workspaceId === selectedReplica?.runtimeWorkspaceId &&
      operation.target.userId === session.meta.userId &&
      operation.target.sessionId === session.meta.id &&
      operation.target.machineId === session.meta.machineId &&
      operation.target.localProjectId === session.meta.project.localProjectId,
  );
  const unavailable =
    !state.status?.connection ||
    state.busy ||
    running ||
    session.meta.isArchived ||
    session.persisted === false ||
    !!session.persistenceError ||
    blocked;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (unavailable || !text.trim()) return;
    run(async () => {
      await controller.saveDraft(text);
      await controller.send(text);
    });
  }
  return (
    <form className="secure-composer" onSubmit={submit}>
      <label htmlFor="secure-prompt">
        发送到当前会话
        <textarea
          id="secure-prompt"
          value={text}
          maxLength={100000}
          rows={4}
          placeholder="写下任务，或先保存为本机草稿…"
          onChange={(event) => setText(event.target.value)}
          disabled={state.busy}
        />
      </label>
      <div className="secure-composer-bottom">
        <span className="secure-muted" role="status">
          {dirty ? '草稿尚未保存；保存后可切换会话。' : '草稿保存在本机，重连后需手动发送。'}
        </span>
        <div className="secure-actions">
          <button
            type="button"
            disabled={state.busy || !dirty}
            onClick={() => run(() => controller.saveDraft(text))}
          >
            保存草稿
          </button>
          <button className="secure-primary" type="submit" disabled={unavailable || !text.trim()}>
            发送
          </button>
        </div>
      </div>
      {blocked && (
        <p className="secure-warning">原操作的结果仍待确认。请在“原操作记录”中手动核查后再发送。</p>
      )}
      {session.persisted === false || session.persistenceError ? (
        <p className="secure-warning">执行电脑尚未确认结果已保存，暂时不能发送新指令。</p>
      ) : running ? (
        <p className="secure-muted">回合进行中。刷新会话以查看最新进展。</p>
      ) : session.meta.isArchived ? (
        <p className="secure-muted">此会话已归档，恢复后可继续发送。</p>
      ) : null}
    </form>
  );
}

export function SecureApp({
  controller,
  accountApi,
  onAccountVerified,
}: {
  controller: SecureUiController;
  accountApi: SecureAccountApi;
  onAccountVerified?: (value: Account | null) => void;
}) {
  const [state, setState] = useState(controller.state);
  const [account, setAccount] = useState<Account | null>(null);
  const [accountLoading, setAccountLoading] = useState(true);
  const [localBusy, setLocalBusy] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [agentId, setAgentId] = useState('');
  const active = useRef(true);
  const actionLock = useRef(false);
  useEffect(() => controller.subscribe(setState), [controller]);
  useEffect(() => {
    active.current = true;
    void accountApi({ action: 'status' })
      .then(async (result) => {
        if (!active.current) return;
        if (!result.ok) throw new Error(result.error.message);
        if (!('origin' in result.value)) throw new Error('账号状态未确认');
        onAccountVerified?.(result.value);
        setAccount(result.value);
        if (result.value.owner) await controller.refreshStatus();
      })
      .catch((reason: unknown) => {
        if (active.current) {
          onAccountVerified?.(null);
          controller.invalidate();
          setAccount(null);
          setError(failure(reason));
        }
      })
      .finally(() => {
        if (active.current) setAccountLoading(false);
      });
    return () => {
      active.current = false;
    };
  }, [accountApi, controller, onAccountVerified]);
  const run: Run = (action) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setLocalBusy(true);
    setError('');
    void action()
      .catch((reason: unknown) => {
        if (active.current) setError(failure(reason));
      })
      .finally(() => {
        actionLock.current = false;
        if (active.current) setLocalBusy(false);
      });
  };
  const device = state.status?.device;
  const identityMismatch = !!(
    account?.owner &&
    device &&
    'pin' in device &&
    (device.pin.accountId !== account.owner || device.pin.serverOrigin !== account.origin)
  );
  const busy = state.busy || localBusy;
  const connection = state.status?.connection;
  const catalog = state.catalog?.catalogVersion === 2 ? state.catalog : null;
  const replica = catalog?.products.replicas.find((entry) => entry.id === state.replicaId);
  const runtime = catalog?.workspaces.find((entry) => entry.id === replica?.runtimeWorkspaceId);
  const agents = runtime?.agents ?? [];
  const selectedAgent = agents.some((entry) => entry.id === agentId)
    ? agentId
    : (agents[0]?.id ?? '');
  const session = state.session;
  const scopeKey = JSON.stringify([
    state.hostId,
    state.replicaId,
    replica?.revision,
    session?.meta.id,
  ]);
  const project = catalog?.products.projects.find((entry) => entry.id === replica?.projectId);
  return (
    <div className="secure-app">
      <header className="secure-topbar">
        <div className="secure-brand">
          <img src="/moor-logo.png" alt="Moor" width={96} height={32} />
          <span>加密访问</span>
        </div>
        <div className="secure-account">
          <span>{account?.origin ?? '可信桌面客户端'}</span>
          {account?.owner && (
            <button
              disabled={busy || dirty}
              onClick={() =>
                run(async () => {
                  controller.close();
                  onAccountVerified?.(null);
                  setAccount(null);
                  const result = await accountApi({ action: 'logout' });
                  if (!result.ok) throw new Error(result.error.message);
                  location.reload();
                })
              }
            >
              退出账号
            </button>
          )}
        </div>
      </header>
      {(error || state.notice) && (
        <div className="secure-alert" role="alert">
          {error || state.notice}
        </div>
      )}
      {accountLoading ? (
        <main className="secure-welcome">
          <p role="status">正在核对账号与设备…</p>
        </main>
      ) : !account ? (
        <main className="secure-welcome">
          <h1>账号状态未确认</h1>
          <p>请核对中转地址和网络连接，然后重新读取。</p>
          <button onClick={() => location.reload()}>重新读取</button>
        </main>
      ) : !account.owner ? (
        <main className="secure-welcome">
          <section className="secure-card">
            <h1>连接你的电脑</h1>
            <p>先登录 Moor 账号，再配对这台设备以访问加密工作区。</p>
            {account.google.enabled ? (
              <GoogleStart mode={account.needsSetup ? 'setup' : 'login'} />
            ) : (
              <p>此中转尚未配置 Google 登录。配置完成后，请刷新此窗口。</p>
            )}
            <button onClick={() => location.reload()}>刷新登录状态</button>
          </section>
        </main>
      ) : identityMismatch ? (
        <main className="secure-welcome">
          <h1>设备与当前账号不匹配</h1>
          <p>请切回配对此设备的账号，或使用对应的中转地址。</p>
          <button onClick={() => location.reload()}>重新核对账号</button>
        </main>
      ) : (
        <div className="secure-layout">
          <aside className="secure-sidebar" aria-label="设备和会话">
            <p className="secure-account-id">账号 · {account.owner}</p>
            <DevicePanel
              account={account}
              status={state.status}
              busy={busy || dirty}
              run={run}
              controller={controller}
            />
            <section className="secure-card">
              <h2>加密连接</h2>
              <p className="secure-muted">
                {connection
                  ? '已连接中转。选择执行主机后，会核对其加密目录。'
                  : '连接与原操作重试均由你手动发起。'}
              </p>
              <div className="secure-actions">
                {connection ? (
                  <button
                    disabled={busy || dirty}
                    onClick={() => run(() => controller.disconnect())}
                  >
                    断开连接
                  </button>
                ) : (
                  <button
                    className="secure-primary"
                    disabled={busy || dirty || state.status?.device.phase !== 'active'}
                    onClick={() => run(() => controller.connect())}
                  >
                    {state.status?.connecting ? '正在连接…' : '连接'}
                  </button>
                )}
              </div>
              {connection && (
                <label>
                  执行主机
                  <select
                    value={state.hostId ?? ''}
                    disabled={busy || dirty}
                    onChange={(event) => {
                      if (event.target.value) run(() => controller.selectHost(event.target.value));
                    }}
                  >
                    <option value="">选择并核对主机</option>
                    {connection.hosts.map((host) => (
                      <option key={host.deviceId} value={host.deviceId}>
                        {host.deviceId}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {connection && connection.hosts.length === 0 && (
                <p className="secure-muted">当前没有在线的加密执行主机。</p>
              )}
              {catalog && (
                <>
                  <p className="secure-confirmed">已核对执行主机目录</p>
                  <label>
                    项目副本
                    <select
                      value={state.replicaId ?? ''}
                      disabled={busy || dirty}
                      onChange={(event) => {
                        if (event.target.value)
                          run(() => controller.selectReplica(event.target.value));
                      }}
                    >
                      <option value="">选择项目</option>
                      {catalog.products.replicas.map((item) => {
                        const product = catalog.products.projects.find(
                          (entry) => entry.id === item.projectId,
                        );
                        const workspace = catalog.products.workspaces.find(
                          (entry) => entry.id === item.catalogWorkspaceId,
                        );
                        return (
                          <option key={item.id} value={item.id} disabled={!item.available}>
                            {workspace?.name ?? item.catalogWorkspaceId} /{' '}
                            {product?.name ?? item.projectId}
                            {item.available ? '' : ' · 不可用'}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                  <button
                    disabled={busy || dirty}
                    onClick={() => run(() => controller.selectHost(state.hostId!))}
                  >
                    重新核对目录
                  </button>
                </>
              )}
            </section>
            <section className="secure-card">
              <div className="secure-section-title">
                <h2>会话</h2>
                <button
                  disabled={busy || !replica || !connection || dirty}
                  onClick={() => run(() => controller.refreshSessions())}
                >
                  刷新
                </button>
              </div>
              {replica && (
                <form
                  className="secure-create"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (selectedAgent) run(() => controller.createSession(selectedAgent));
                  }}
                >
                  <label>
                    新会话的 Agent
                    <select
                      value={selectedAgent}
                      disabled={busy || dirty || !connection}
                      onChange={(event) => setAgentId(event.target.value)}
                    >
                      {!agents.length && <option value="">主机未配置 Agent</option>}
                      {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="submit" disabled={busy || dirty || !connection || !selectedAgent}>
                    新建会话
                  </button>
                </form>
              )}
              <ul className="secure-sessions">
                {state.sessions.map((item) => (
                  <li key={item.id}>
                    <button
                      aria-current={session?.meta.id === item.id ? 'page' : undefined}
                      disabled={busy || dirty || !connection}
                      onClick={() => run(() => controller.openSession(item.id))}
                    >
                      <span>
                        {item.isPinned ? '置顶 · ' : ''}
                        {item.title || '未命名会话'}
                      </span>
                      <small>
                        {item.isArchived
                          ? '已归档'
                          : item.status?.type === 'working'
                            ? '进行中'
                            : item.agentType}
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
              {replica && !state.sessions.length && (
                <p className="secure-muted">当前项目没有已读取的会话。</p>
              )}
            </section>
          </aside>
          <main className="secure-workspace">
            {session ? (
              <>
                <header className="secure-session-header">
                  <div>
                    <p className="secure-eyebrow">
                      {project?.name ?? replica?.localProjectId} · {session.meta.agentType}
                    </p>
                    <h1>{session.meta.title || '未命名会话'}</h1>
                  </div>
                  <div className="secure-actions">
                    <button
                      disabled={busy || !connection || dirty}
                      onClick={() => run(() => controller.refreshSession())}
                    >
                      刷新会话
                    </button>
                    <button
                      disabled={
                        busy ||
                        !connection ||
                        session.history.every((turn) => turn.role !== 'assistant' || turn.finished)
                      }
                      onClick={() => run(() => controller.stop())}
                    >
                      停止回合
                    </button>
                  </div>
                </header>
                <details className="secure-session-settings">
                  <summary>会话设置</summary>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const data = new FormData(event.currentTarget);
                      run(() => controller.metadata('rename', String(data.get('title') ?? '')));
                    }}
                  >
                    <label>
                      会话名称
                      <input
                        name="title"
                        defaultValue={session.meta.title ?? ''}
                        maxLength={200}
                        required
                        disabled={busy || !connection}
                        key={session.meta.id + ':' + session.meta.title}
                      />
                    </label>
                    <button disabled={busy || !connection} type="submit">
                      保存名称
                    </button>
                  </form>
                  <div className="secure-actions">
                    <button
                      disabled={busy || !connection}
                      onClick={() =>
                        run(() => controller.metadata(session.meta.isPinned ? 'unpin' : 'pin'))
                      }
                    >
                      {session.meta.isPinned ? '取消置顶' : '置顶会话'}
                    </button>
                    <button
                      disabled={busy || !connection}
                      onClick={() =>
                        run(() =>
                          controller.metadata(session.meta.isArchived ? 'restore' : 'archive'),
                        )
                      }
                    >
                      {session.meta.isArchived ? '恢复会话' : '归档会话'}
                    </button>
                  </div>
                </details>
                <section className="secure-history" aria-label="会话内容">
                  {session.history.length === 0 ? (
                    <p className="secure-empty">会话已创建。写下第一条指令开始。</p>
                  ) : (
                    session.history.map((turn) => (
                      <article className={'secure-turn secure-turn-' + turn.role} key={turn.id}>
                        <div className="secure-turn-label">
                          {turn.role === 'user' ? '你' : 'Agent'}
                          {turn.role === 'assistant' && !turn.finished ? ' · 进行中' : ''}
                        </div>
                        {(turn.items ?? []).map((item: unknown, index: number) => (
                          <HistoryItem key={index} value={item} finished={turn.finished} />
                        ))}
                      </article>
                    ))
                  )}
                </section>
                <Composer
                  key={scopeKey}
                  state={state}
                  controller={controller}
                  run={run}
                  onDirty={setDirty}
                />
              </>
            ) : (
              <section className="secure-empty-state">
                <span className="secure-empty-mark" aria-hidden="true">
                  M
                </span>
                <h1>在你的电脑上继续工作</h1>
                <p>配对设备、连接执行主机，并选择项目会话。</p>
                <p className="secure-muted">会话内容由执行主机确认，通过端到端加密传输。</p>
              </section>
            )}
            <details
              className="secure-operations secure-card"
              open={state.operations.some((operation) =>
                ['pending', 'ending'].includes(operation.state),
              )}
            >
              <summary>
                原操作记录{state.operations.length ? ` · ${state.operations.length}` : ''}
              </summary>
              <p className="secure-muted">
                网络中断不会自动重发。核查、重试和放弃均使用记录中的原操作与原执行范围。
              </p>
              <button disabled={busy} onClick={() => run(() => controller.refreshOperations())}>
                刷新本机记录
              </button>
              <ul>
                {state.operations.map((operation) => (
                  <li key={operation.operationId}>
                    <div className="secure-section-title">
                      <strong>
                        {operation.kind === 'turn'
                          ? '发送指令'
                          : operation.kind === 'create'
                            ? '创建会话'
                            : operation.kind === 'stop'
                              ? '停止回合'
                              : '会话设置'}
                      </strong>
                      <span>{operationLabels[operation.state]}</span>
                    </div>
                    <details>
                      <summary>核对原操作范围</summary>
                      <dl className="secure-facts">
                        <dt>操作</dt>
                        <dd>{operation.operationId}</dd>
                        <dt>执行主机</dt>
                        <dd>{operation.target.hostDeviceId}</dd>
                        <dt>项目副本</dt>
                        <dd>
                          {operation.target.product?.replicaId ?? operation.target.localProjectId} ·
                          版本 {operation.target.product?.revision ?? '旧记录'}
                        </dd>
                        <dt>会话</dt>
                        <dd>{operation.target.sessionId}</dd>
                        <dt>请求指纹</dt>
                        <dd>{operation.requestVersion}</dd>
                      </dl>
                    </details>
                    {['pending', 'ending'].includes(operation.state) && (
                      <div className="secure-actions">
                        <button
                          disabled={busy || !connection}
                          onClick={() =>
                            run(() => controller.recover(operation.operationId, 'inspect'))
                          }
                        >
                          核查原操作
                        </button>
                        <button
                          disabled={busy || !connection || operation.state === 'ending'}
                          onClick={() =>
                            run(() => controller.recover(operation.operationId, 'retry'))
                          }
                        >
                          重试原操作
                        </button>
                        <button
                          disabled={busy || !connection}
                          onClick={() =>
                            run(() => controller.recover(operation.operationId, 'abandon'))
                          }
                        >
                          放弃原操作
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {!state.operations.length && (
                <p className="secure-muted">此账号尚无本机原操作记录。</p>
              )}
            </details>
          </main>
        </div>
      )}
    </div>
  );
}

export async function bootSecure() {
  const bridge = (
    window as unknown as {
      moorSecure?: {
        version: number;
        request(value: DesktopSecureRequest): Promise<unknown>;
        account: SecureAccountApi;
      };
    }
  ).moorSecure;
  if (
    bridge?.version !== 1 ||
    typeof bridge.request !== 'function' ||
    typeof bridge.account !== 'function'
  )
    throw new Error('可信桌面接口不可用');
  const container = document.getElementById('app');
  if (!container) throw new Error('桌面页面容器不可用');
  let verifiedAccount: Account | null = null;
  const controller = new SecureWorkspaceController({
    request: (value) => bridge.request(value),
    account: () =>
      verifiedAccount?.owner
        ? { origin: verifiedAccount.origin, owner: verifiedAccount.owner }
        : null,
  });
  const root = createRoot(container);
  root.render(
    <SecureApp
      controller={controller}
      accountApi={(value) => bridge.account(value)}
      onAccountVerified={(value) => {
        verifiedAccount = value;
      }}
    />,
  );
  window.addEventListener(
    'pagehide',
    () => {
      controller.close();
      root.unmount();
    },
    { once: true },
  );
  window.dispatchEvent(new Event('moor:ready'));
}
