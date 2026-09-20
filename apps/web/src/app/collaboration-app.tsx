import { useEffect, useState, type ReactNode } from 'react';
import { actorKey, actorSchema, type AttentionActor } from '@moor/protocol/attention';
import {
  collaborationAllows,
  collaborationReadResponseSchema,
  type TaskPhase,
} from '@moor/protocol/collaboration-protocol';
import { CollaborationClient, type CollaborationDocument } from '@moor/client/collaboration-client';
import { readClientSession } from '@moor/client/session-client';
import { IndexedSecureStorage } from '../platform/secure-store';
import { api, ApiError, type Identity } from '../platform/api';
import { z } from 'zod';
import { paint } from '../components/ui';

type Read = z.infer<typeof collaborationReadResponseSchema>;
const phases: Record<TaskPhase, string> = {
  queued: '已入队',
  claimed: '主机准备中',
  dispatching: '执行结果待确认',
  accepted: '主机已接受',
  running: '执行中',
  completed: '执行结束',
  failed: '执行失败',
  interrupted: '已中断 · 请核查',
  cancelled: '已撤回',
  blocked: '等待处理',
};
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : '尚未确认，请检查连接。';

function CollaborationBoard({
  client,
  initial,
  actor,
  route,
  refreshRead,
}: {
  client: CollaborationClient;
  initial: Read;
  actor: AttentionActor;
  route: string;
  refreshRead(): Promise<Read>;
}) {
  const [state, setState] = useState<CollaborationDocument>(client.state.snapshot());
  const [read, setRead] = useState(initial);
  const [status, setStatus] = useState('正在同步');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [draftId, setDraftId] = useState('shared-draft');
  const [parents, setParents] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [account, setAccount] = useState('');
  const [role, setRole] = useState<'viewer' | 'editor' | 'operator'>('editor');
  const [invitation, setInvitation] = useState('');
  const heads = client.state.draftHeads(draftId);
  const composerKey = JSON.stringify([
    'moor-collaboration-composer',
    location.origin,
    actor,
    initial.scope,
    draftId,
  ]);
  const canEdit = collaborationAllows(read.role, 'edit'),
    canSubmit = read.enabled && collaborationAllows(read.role, 'submit');

  useEffect(() => client.state.subscribe(() => setState(client.state.snapshot())), [client]);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(composerKey);
      if (saved) {
        const parsed = z
          .object({ text: z.string(), parents: z.array(z.string()) })
          .strict()
          .parse(JSON.parse(saved));
        setText(parsed.text);
        setParents(parsed.parents);
        return;
      }
    } catch (cause) {
      setError(errorText(cause));
    }
    const current = client.state.draftHeads(draftId);
    setText(current.length === 1 ? current[0].input.prompt : '');
    setParents(current.length === 1 ? [current[0].operationId] : []);
  }, [composerKey, client, draftId]);

  const sync = async () => {
    try {
      const latest = await refreshRead();
      setRead(latest);
      if (!latest.enabled) {
        setStatus('尚未开启共享 · 草稿仅保存在本机');
        return;
      }
      await client.state.sync();
      setStatus('已同步到执行主机');
      setError('');
    } catch (cause) {
      setStatus('本机保存 · 等待同步');
      setError(errorText(cause));
    }
  };
  useEffect(() => {
    let disposed = false,
      socket: WebSocket | undefined,
      retry: ReturnType<typeof setTimeout> | undefined;
    let syncing: Promise<void> | undefined,
      again = false;
    const refresh = () => {
      if (disposed) return;
      if (syncing) {
        again = true;
        return;
      }
      syncing = sync().finally(() => {
        syncing = undefined;
        if (again) {
          again = false;
          refresh();
        }
      });
    };
    const connect = () => {
      if (
        disposed ||
        socket?.readyState === WebSocket.OPEN ||
        socket?.readyState === WebSocket.CONNECTING
      )
        return;
      socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/events');
      socket.onopen = refresh;
      socket.onmessage = refresh;
      socket.onclose = () => {
        if (!disposed) retry = setTimeout(connect, 2000);
      };
    };
    const online = () => {
      connect();
      refresh();
    };
    const visible = () => {
      if (document.visibilityState === 'visible') online();
    };
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', visible);
    connect();
    refresh();
    return () => {
      disposed = true;
      clearTimeout(retry);
      socket?.close();
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [client, refreshRead]);

  const edit = (value: string, versions = parents) => {
    setText(value);
    setParents(versions);
    try {
      localStorage.setItem(composerKey, JSON.stringify({ text: value, parents: versions }));
    } catch (cause) {
      setError('本机编辑内容未保存：' + errorText(cause));
    }
  };
  const save = async (merge = false) => {
    const revision = await client.control.saveDraft({
      draftId,
      parents: merge ? heads.map((head) => head.operationId) : parents,
      input: { prompt: text, selection: heads.length === 1 ? heads[0].input.selection : {} },
    });
    edit(text, [revision.operationId]);
    return revision;
  };
  const act = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
      await sync();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const history = readClientSession(read.session, read.target).history;
  const draftIds = [
    ...new Set([
      draftId,
      ...state.operations.filter((op) => op.kind === 'draft').map((op) => op.draftId),
    ]),
  ];
  return (
    <main
      style={{ maxWidth: 1000, margin: 'auto', padding: 24, overflow: 'auto', height: '100vh' }}
    >
      <header>
        <a href="/">返回 Moor</a>
        <h1>共享草稿与任务队列</h1>
        {!read.enabled && read.role === 'owner' && (
          <button disabled={busy} onClick={() => void act(() => api(route + '/enable', {}))}>
            开启此会话共享
          </button>
        )}
        <p>
          {read.session.meta.title || '共享会话'} · {status}
        </p>
        <p>
          你的协作账号：<code>{actor.accountId}</code>
        </p>
        <button onClick={() => void sync()}>重新同步</button>{' '}
        <button
          onClick={() =>
            void navigator.clipboard
              .writeText(location.href)
              .catch((cause) => setError(errorText(cause)))
          }
        >
          复制会话链接
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      <section aria-labelledby="shared-draft-title">
        <h2 id="shared-draft-title">共享草稿</h2>
        <p>主机离线时先保存在此设备；连接恢复后汇合。保存草稿不会执行。</p>
        <label>
          选择草稿{' '}
          <select value={draftId} onChange={(event) => setDraftId(event.target.value)}>
            {draftIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>{' '}
        <button disabled={!canEdit} onClick={() => setDraftId('draft-' + crypto.randomUUID())}>
          新建草稿
        </button>
        {heads.length > 1 && (
          <p role="status">有 {heads.length} 个并发版本。请阅读后合并，再提交执行。</p>
        )}
        {heads.map((head) => (
          <details key={head.operationId} open={heads.length > 1}>
            <summary>
              {head.author.actor.accountId} · {head.operationId}
            </summary>
            <pre style={{ whiteSpace: 'pre-wrap' }}>{head.input.prompt}</pre>
            <button disabled={!canEdit} onClick={() => edit(head.input.prompt, [head.operationId])}>
              编辑此版本
            </button>
          </details>
        ))}
        <label style={{ display: 'block' }}>
          指令
          <textarea
            value={text}
            maxLength={100000}
            disabled={!canEdit || busy}
            onChange={(event) => edit(event.target.value)}
            rows={8}
            style={{ width: '100%' }}
          />
        </label>
        <button disabled={!canEdit || busy} onClick={() => void act(() => save())}>
          保存共享草稿
        </button>{' '}
        {heads.length > 1 && (
          <button disabled={!canEdit || busy} onClick={() => void act(() => save(true))}>
            保存已审阅的合并版本
          </button>
        )}{' '}
        <button
          disabled={!canSubmit || busy || !text.trim() || heads.length > 1}
          onClick={() =>
            void act(async () => {
              const revision = await save();
              await client.control.sendTurn({
                draftRevisionId: revision.operationId,
                target: read.target,
                expiresAt: Date.now() + 24 * 60 * 60 * 1000,
              });
              setStatus('已在本机授权提交 · 等待主机确认');
            })
          }
        >
          授权提交任务
        </button>
        <p>
          提交会固定本次内容和执行电脑，并授权在 24
          小时内按队列顺序开始执行。离线提交将在恢复连接后自动入队。
        </p>
      </section>
      <section aria-labelledby="shared-queue-title">
        <h2 id="shared-queue-title">任务队列</h2>
        {state.operations
          .filter((op) => op.kind === 'submit')
          .map((task) => {
            const receipt = state.tasks.find((item) => item.taskId === task.operationId);
            return (
              <article
                key={task.operationId}
                style={{ borderTop: '1px solid var(--border, #aaa)', padding: '12px 0' }}
              >
                <p>
                  {receipt
                    ? phases[receipt.phase]
                    : state.pending.includes(task.operationId)
                      ? '本机已提交 · 尚未同步'
                      : '主机已保存 · 等待协调'}{' '}
                  · {task.author.actor.accountId}
                </p>
                <pre style={{ whiteSpace: 'pre-wrap' }}>{task.input.prompt}</pre>
                {receipt?.reason && <p>{receipt.reason}</p>}
                {canSubmit &&
                  receipt &&
                  ['queued', 'claimed', 'blocked'].includes(receipt.phase) && (
                    <button
                      disabled={busy}
                      onClick={() => void act(() => client.control.withdrawTask(task.operationId))}
                    >
                      撤回排队任务
                    </button>
                  )}
              </article>
            );
          })}
      </section>
      <section>
        <h2>已确认的会话历史</h2>
        {history.map((turn) => (
          <article key={turn.id}>
            <strong>{turn.role === 'user' ? '用户' : '助手'}</strong>
            {(turn.items ?? [])
              .filter((item: any) => item.type === 'text' || item.type === 'system_notice')
              .map((item: any, index: number) => (
                <pre key={index} style={{ whiteSpace: 'pre-wrap' }}>
                  {item.text ?? item.message}
                </pre>
              ))}
          </article>
        ))}
      </section>
      {read.enabled && read.role === 'owner' && (
        <section>
          <h2>协作成员</h2>
          <p>
            成员使用自己的账号登录此中转，再打开会话链接。权限覆盖此执行主机上该工作区已启用共享的会话。
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const result = z
                  .object({ invitation: z.string(), expiresAt: z.number() })
                  .parse(await api('/api/account-invitations', {}));
                setInvitation(
                  location.origin + '/?invite=' + encodeURIComponent(result.invitation),
                );
              })
            }
          >
            创建一次性账号注册邀请
          </button>
          {invitation && (
            <p>
              邀请 24 小时有效，注册本身不授予工作区访问权限。
              <input
                aria-label="账号注册链接"
                readOnly
                value={invitation}
                style={{ width: '100%' }}
              />
            </p>
          )}
          <label>
            成员账号 ID{' '}
            <input value={account} onChange={(event) => setAccount(event.target.value)} />
          </label>{' '}
          <select
            aria-label="成员权限"
            value={role}
            onChange={(event) => setRole(event.target.value as typeof role)}
          >
            <option value="viewer">仅查看</option>
            <option value="editor">编辑草稿</option>
            <option value="operator">编辑与提交执行</option>
          </select>{' '}
          <button
            disabled={busy || !account.trim()}
            onClick={() =>
              void act(() => api(route + '/member', { accountId: account.trim(), role }))
            }
          >
            保存成员权限
          </button>{' '}
          <button
            disabled={busy || !account.trim()}
            onClick={() =>
              void act(() => api(route + '/member', { accountId: account.trim(), role: null }))
            }
          >
            撤销成员权限
          </button>
        </section>
      )}
    </main>
  );
}

export async function bootCollaboration(owner: string, identity: Promise<Identity | null>) {
  const query = new URLSearchParams(location.search),
    workspace = query.get('workspace'),
    replica = query.get('replica'),
    session = query.get('session');
  const root = { render: (node: ReactNode) => paint('#app', node) };
  if (!workspace || !replica || !session) {
    root.render(
      <main style={{ padding: 24 }}>
        <h1>共享会话</h1>
        <p>请从 Moor 的会话页面打开共享草稿，或使用所有者提供的会话链接。</p>
        <p>
          你的账号 ID：<code>{owner}</code>
        </p>
        <a href="/">返回 Moor</a>
      </main>,
    );
    return;
  }
  const route =
    '/api/collaboration/' + [workspace, replica, session].map(encodeURIComponent).join('/');
  const storage = new IndexedSecureStorage({ databaseName: 'moor-collaboration-v1' });
  const descriptorKey = JSON.stringify([
    'collaboration-view',
    location.origin,
    owner,
    workspace,
    replica,
    session,
  ]);
  const cached = await storage.read(descriptorKey);
  const cachedSchema = z
    .object({ actor: actorSchema, read: collaborationReadResponseSchema, clientId: z.string() })
    .strict();
  let saved = cached == null ? undefined : cachedSchema.parse(cached);
  const me = await identity;
  let currentActor: AttentionActor | undefined = me?.actor
    ? actorSchema.parse(me.actor)
    : saved?.actor;
  const current = () => {
    if (
      !currentActor ||
      currentActor.accountId !== owner ||
      (saved && actorKey(saved.actor) !== actorKey(currentActor))
    )
      throw Error('协作账号已变化，请重新登录');
  };
  const readOnline = async () => {
    const identity = (await api('/api/me')) as Identity;
    if (
      !identity.actor ||
      identity.owner !== owner ||
      (currentActor && actorKey(identity.actor) !== actorKey(currentActor))
    ) {
      currentActor = undefined;
      throw Error('协作账号已变化，请重新登录');
    }
    currentActor = actorSchema.parse(identity.actor);
    const read = collaborationReadResponseSchema.parse(await api(route + '/read'));
    readClientSession(read.session, read.target);
    current();
    await storage.exclusive(descriptorKey, current, async () => {
      const previous = await storage.read(descriptorKey);
      const existing = previous == null ? undefined : cachedSchema.parse(previous);
      if (
        existing &&
        (actorKey(existing.actor) !== actorKey(currentActor!) ||
          JSON.stringify(existing.read.scope) !== JSON.stringify(read.scope) ||
          JSON.stringify(existing.read.target) !== JSON.stringify(read.target))
      )
        throw Error('共享会话的执行绑定已变化，原待同步任务仍保留在本机');
      const next = {
        actor: currentActor!,
        read,
        clientId: existing?.clientId ?? crypto.randomUUID(),
      };
      await storage.compareAndSet(descriptorKey, previous ?? null, next, current);
      saved = next;
    });
    return read;
  };
  try {
    try {
      await readOnline();
    } catch (cause) {
      if (!saved || (cause instanceof ApiError && [401, 403].includes(cause.status))) throw cause;
    }
    current();
    if (!saved) throw Error('此设备还没有共享会话缓存，请先在线打开一次');
    const client = new CollaborationClient({
      scope: saved.read.scope,
      author: { actor: saved.actor, clientId: saved.clientId },
      storage,
      transport: {
        sync: async (request) => {
          current();
          return api(route + '/sync', request);
        },
        offer: async (request) => {
          current();
          return api(route + '/offer', request);
        },
      },
      current,
      uuid: () => crypto.randomUUID(),
      now: Date.now,
    });
    await client.state.recover();
    root.render(
      <CollaborationBoard
        client={client}
        initial={saved.read}
        actor={saved.actor}
        route={route}
        refreshRead={readOnline}
      />,
    );
  } catch (cause) {
    root.render(
      <main style={{ padding: 24 }}>
        <h1>共享会话暂不可用</h1>
        <p role="alert">{errorText(cause)}</p>
        <p>
          你的账号 ID：<code>{owner}</code>
        </p>
        <a href="/">返回 Moor</a>
      </main>,
    );
  }
}
