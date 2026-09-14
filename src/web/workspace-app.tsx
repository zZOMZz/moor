import { useWorkspaceLayout, SidebarSizer, WorkspaceToolMenu } from './workspace-layout';
import {
  SessionTimeline,
  SessionInformation,
  hasTurnFileChanges,
  turnFileChanges,
} from './session-timeline';
import { SESSION_FORK_FEATURE } from '../fork-protocol';
import { PROJECT_DIFF_FEATURE } from '../project-content-protocol';
import { WorkspaceContentUI, type WorkspaceContentHandle } from './workspace-content-ui';
import { WorkspaceAttentionUI } from './workspace-attention-ui';
import { WorkspaceSessionTools } from './workspace-session-tools';
import { WorkspaceGithubUI } from './workspace-github-ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Folder,
  Settings,
  Plus,
  RefreshCw,
  Monitor,
  PanelLeft,
  GitFork,
  Paperclip,
  X,
} from 'lucide-react';
import { WorkspaceController, type WorkspaceClientState } from './workspace-controller';
import { SecureWorkspaceController } from './secure-controller';
import {
  SecureApp,
  type SecureAccountApi,
  type SecureUiController,
  type Account,
} from './secure-app';
import type {
  DesktopWorkspaceRequest,
  DesktopWorkspaceSource,
} from '../desktop/workspace-protocol';
import type { DesktopSecureRequest } from '../security/desktop-client-protocol';
import {
  desktopWorkspaceContextSchema,
  desktopAddProjectResultSchema,
} from '../desktop/workspace-protocol';
import type { z } from 'zod';
import { RunControls } from './ui';
import { resolveRunSelection, type RunSelection } from '../run-config';
import { markdown } from './content';
import { sessionPermissionReviews } from '../session-client';
import { productCanonicalJson as canonical } from '../security/encrypted-product-catalog';
import {
  attachmentInputReason,
  attachmentPreviewUrl,
  attachmentText,
  formatAttachmentSize,
} from './attachments';
import { attachmentReferenceSchema } from '../content-protocol';
import { WorkspaceAttachmentView } from './workspace-attachment-view';
import { ATTACHMENTS_FEATURE } from '../attachment-protocol';
import { WorkspaceInteractionUI } from './workspace-interaction-ui';
import { WorkspaceSkillsUI } from './workspace-skills-ui';
import { WorkspaceMcpUI } from './workspace-mcp-ui';
import { WorkspaceGitUI } from './workspace-git-ui';
import { WorkspaceForkUI, type WorkspaceForkHandle } from './workspace-fork-ui';
import { WorkspacePreviewUI } from './workspace-preview-ui';
import { WorkspaceRolesUI } from './workspace-roles-ui';
import { WorkspaceTasksUI } from './workspace-tasks-ui';

type Run = (action: () => Promise<unknown>) => boolean;
const message = (error: unknown) =>
  error instanceof Error ? error.message : '操作尚未确认，请重新核对。';
function readable(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function WorkspaceConversation({
  controller,
  state,
  busy,
  run,
  onDirty,
  addProject,
  configureAgent,
}: {
  controller: WorkspaceController;
  state: WorkspaceClientState;
  busy: boolean;
  run: Run;
  onDirty(value: boolean): void;
  addProject?: () => void;
  configureAgent?: () => void;
}) {
  const [text, setText] = useState(state.draft?.text ?? ''),
    [selection, setSelection] = useState<RunSelection>(state.draft?.selection ?? {});
  const [saveError, setSaveError] = useState('');
  const contentPanel = useRef<WorkspaceContentHandle>(null),
    forkPanel = useRef<WorkspaceForkHandle>(null);
  const draftVersion = useRef(0),
    saving = useRef(false),
    active = useRef(true);
  const dirty = useRef({ composer: false, interaction: false });
  const reportDirty = (kind: 'composer' | 'interaction', value: boolean) => {
    dirty.current[kind] = value;
    onDirty(dirty.current.composer || dirty.current.interaction);
  };
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!saving.current && !saveError) {
      setText(state.draft?.text ?? '');
      setSelection(state.draft?.selection ?? {});
    }
  }, [state.draft?.revision, saveError]);
  const save = (nextText: string, nextSelection: RunSelection) => {
    setText(nextText);
    setSelection(nextSelection);
    reportDirty('composer', true);
    saving.current = true;
    const version = ++draftVersion.current;
    void controller
      .saveDraft(nextText, nextSelection)
      .then(() => {
        if (!active.current || version !== draftVersion.current) return;
        saving.current = false;
        setSaveError('');
        reportDirty('composer', false);
      })
      .catch((error: unknown) => {
        if (active.current && version === draftVersion.current) {
          saving.current = false;
          setSaveError(message(error));
        }
      });
  };
  useEffect(() => {
    const target = state.searchFocus;
    if (!target || target.sessionId !== state.sessionId) return;
    const node = Array.from(document.querySelectorAll<HTMLElement>('.workspace-turn')).find(
      (element) => element.dataset.turnId === target.turnId,
    );
    node?.scrollIntoView?.({ block: 'center' });
    node?.focus({ preventScroll: true });
  }, [state.searchFocus?.turnId, state.searchFocus?.sessionId, state.sessionId]);
  const session = state.session;
  if (!session || !state.sessionId || !state.scope)
    return (
      <section className="workspace-empty">
        <Folder aria-hidden="true" />
        <h1>{state.project?.projectName ?? '从你的项目开始'}</h1>
        <p>
          {state.project
            ? '选择已有会话，或在侧栏新建会话。'
            : '添加本机文件夹，开始你的第一个会话。'}
        </p>
        {!state.project && addProject && (
          <button className="workspace-add-project" disabled={busy} onClick={addProject}>
            <Plus size={16} />
            添加项目
          </button>
        )}
        {state.project && !state.project.runtime.agents.length && configureAgent && (
          <>
            <p>此电脑尚未配置 Agent。</p>
            <button onClick={configureAgent} disabled={busy}>
              配置本机 Agent
            </button>
          </>
        )}
      </section>
    );
  const reviews = sessionPermissionReviews(session, {
    ...state.scope.target,
    sessionId: state.sessionId,
  });
  const activeTurns = session.history.filter((turn) => turn.role === 'assistant' && !turn.finished);
  let validation = '';
  try {
    resolveRunSelection(selection, session.agent?.runConfig);
  } catch (error) {
    validation = message(error);
  }
  const pending = state.ledger?.operations.filter((entry) => entry.status === 'pending') ?? [];
  const attachments = state.ledger?.attachments?.[state.sessionId]?.items ?? [];
  const attachmentSupported = state.project?.runtime.features?.includes(ATTACHMENTS_FEATURE);
  const attachmentBlocked = attachments.some(
    (item) =>
      !item.uploaded ||
      item.pending ||
      attachmentInputReason(item.reference, session.agent?.inputCapabilities),
  );
  return (
    <>
      <header className="workspace-session-header">
        <div>
          <small>
            {state.project?.projectName} · {state.project?.hostName}
          </small>
          <h1>{session.meta.title || '未命名会话'}</h1>
        </div>
        <WorkspaceToolMenu>
          <WorkspaceContentUI
            controller={controller}
            busy={busy}
            run={run}
            controlRef={contentPanel}
          />
          <WorkspaceSkillsUI controller={controller} state={state} busy={busy} run={run} />
          <WorkspaceMcpUI controller={controller} state={state} busy={busy} run={run} />
          <WorkspaceGitUI controller={controller} state={state} busy={busy} run={run} />
          <WorkspaceForkUI
            controller={controller}
            state={state}
            busy={busy}
            run={run}
            controlRef={forkPanel}
          />
          <WorkspacePreviewUI controller={controller} state={state} busy={busy} run={run} />
          <WorkspaceRolesUI controller={controller} state={state} busy={busy} run={run} />
          <WorkspaceTasksUI controller={controller} state={state} busy={busy} run={run} />
          <WorkspaceGithubUI controller={controller} state={state} busy={busy} run={run} />
          <WorkspaceSessionTools controller={controller} state={state} busy={busy} run={run} />
        </WorkspaceToolMenu>
        <SessionInformation
          history={session.history}
          disabled={busy || dirty.current.composer || dirty.current.interaction || !!saveError}
          onCommand={(command) =>
            run(() => controller.saveDraft(text ? text + '\n' + command : command, selection))
          }
          onFiles={
            state.project?.runtime.features?.includes(PROJECT_DIFF_FEATURE)
              ? (turnId) => {
                  contentPanel.current?.open('changes', turnId);
                }
              : undefined
          }
        />
        <button
          disabled={busy}
          onClick={() => run(() => controller.refreshSession())}
          aria-label="刷新会话"
        >
          <RefreshCw size={16} />
        </button>
      </header>
      {session.meta.forkOrigin && (
        <aside className="fork-origin">
          <span>
            来自「{session.meta.forkOrigin.sourceTitle || '未命名会话'}」 ·{' '}
            {session.meta.forkOrigin.directory === 'worktree' ? '独立工作目录' : '沿用源目录'}
          </span>
          <details>
            <summary>来源与截止点</summary>
            <p>
              {session.meta.forkOrigin.cutoff.kind === 'current'
                ? '创建时 Agent 已保存上下文'
                : '完成回合：' + session.meta.forkOrigin.cutoff.turnId}
            </p>
            <code>{session.meta.forkOrigin.sourceVersion}</code>
          </details>
          <button
            disabled={busy}
            onClick={() =>
              run(() => controller.openSession(session.meta.forkOrigin!.sourceSessionId))
            }
          >
            打开源会话
          </button>
        </aside>
      )}
      {state.offline && (
        <p className="workspace-status" role="status">
          执行电脑暂不可达，显示本机缓存；草稿仍可编辑。
        </p>
      )}
      {session.meta.taskOrigin && (
        <aside className="task-plan-card" aria-label="子任务来源">
          <span>
            子任务 · 完成条件：{session.meta.taskOrigin.completion}。此会话不能再次授权协作任务。
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              run(() => controller.openSession(session.meta.taskOrigin!.parentSessionId))
            }
          >
            打开父会话
          </button>
        </aside>
      )}

      <SessionTimeline
        history={session.history}
        variant="workspace"
        focusTurnId={state.focusedTurnId ?? state.searchFocus?.turnId}
        renderItem={(item, turn, index) => {
          if (!item || typeof item !== 'object') return null;
          const entry = item as Record<string, unknown>;
          if (entry.type === 'attachment') {
            const reference = attachmentReferenceSchema.safeParse(entry.attachment);
            if (reference.success)
              return (
                <WorkspaceAttachmentView
                  key={index}
                  controller={controller}
                  scope={state.scope!}
                  sessionId={state.sessionId!}
                  reference={reference.data}
                  busy={busy}
                  run={run}
                />
              );
          }
          if (entry.type === 'text')
            return (
              <div
                key={index}
                dangerouslySetInnerHTML={{
                  __html: markdown(typeof entry.text === 'string' ? entry.text : ''),
                }}
              />
            );
          if (entry.type === 'system_notice')
            return (
              <p key={index} role="status">
                {readable(entry.text ?? entry.message ?? entry.meta ?? entry.name)}
              </p>
            );
          return (
            <details key={index}>
              <summary>
                {readable(
                  entry.title ??
                    (entry.type === 'thought'
                      ? '思考过程'
                      : entry.type === 'tool_call'
                        ? '工具调用'
                        : '回合详情'),
                )}
              </summary>
              <pre>{readable(entry)}</pre>
            </details>
          );
        }}
        afterTurn={(turn) =>
          reviews
            .filter((review) => review.assistantTurnId === turn.id)
            .map((review) => (
              <section
                className="workspace-permission"
                key={review.requestId}
                aria-label="待审批操作"
              >
                <strong>需要你的确认</strong>
                <pre>{readable(JSON.parse(review.itemJson))}</pre>
                {review.options.map((option) => (
                  <button
                    key={option.optionId}
                    disabled={busy || state.offline}
                    onClick={() =>
                      run(() =>
                        controller.respondPermission(review, {
                          outcome: 'selected',
                          optionId: option.optionId,
                        }),
                      )
                    }
                  >
                    {option.name}
                  </button>
                ))}
                <button
                  disabled={busy || state.offline}
                  onClick={() =>
                    run(() => controller.respondPermission(review, { outcome: 'cancelled' }))
                  }
                >
                  取消操作
                </button>
              </section>
            ))
        }
        actions={(turn) => (
          <>
            {hasTurnFileChanges(turn) &&
              state.project?.runtime.features?.includes(PROJECT_DIFF_FEATURE) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => contentPanel.current?.open('changes', turn.id)}
                >
                  查看回合文件变更 · {turnFileChanges(turn)!.changeCount}
                </button>
              )}
            {turn.finished && state.project?.runtime.features?.includes(SESSION_FORK_FEATURE) && (
              <button
                type="button"
                className="session-fork-action"
                aria-label="从此回合创建副本"
                title="从此回合创建副本"
                disabled={busy || state.offline}
                onClick={() => forkPanel.current?.open(turn.id)}
              >
                <GitFork size={15} />
              </button>
            )}
          </>
        )}
      />
      {!!pending.length && (
        <details className="workspace-pending">
          <summary>待确认操作 · {pending.length}</summary>
          {pending.map((entry) => (
            <div key={entry.original.value.operationId}>
              <p>
                {entry.original.kind === 'control'
                  ? entry.original.value.action === 'create'
                    ? '创建会话'
                    : '停止回合'
                  : '会话操作'}{' '}
                · {entry.original.value.sessionId}
              </p>
              <small>{entry.original.value.operationId}</small>
              <button
                disabled={busy || state.offline}
                onClick={() => run(() => controller.inspect(entry.original.value.operationId))}
              >
                核查结果
              </button>
              <button
                disabled={busy || state.offline}
                onClick={() => run(() => controller.retry(entry.original.value.operationId))}
              >
                重试原操作
              </button>
              <button
                disabled={busy || state.offline}
                onClick={() => run(() => controller.abandon(entry.original.value.operationId))}
              >
                结束原操作
              </button>
            </div>
          ))}
        </details>
      )}
      <WorkspaceInteractionUI
        controller={controller}
        state={state}
        busy={busy}
        run={run}
        onDirty={(value) => reportDirty('interaction', value)}
      />
      <form
        className="workspace-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && !saving.current && !saveError) run(() => controller.send());
        }}
      >
        <textarea
          aria-label="消息"
          placeholder="描述你想完成的事情…"
          value={text}
          onChange={(event) => save(event.target.value, selection)}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (files.length && !busy) {
              event.preventDefault();
              run(() => controller.addAttachments(files));
            }
          }}
        />
        <div className="workspace-attachments">
          <label className="workspace-attach-trigger">
            <Paperclip size={14} />
            添加附件
            <input
              type="file"
              multiple
              aria-label="添加附件"
              disabled={busy}
              onChange={(event) => {
                const files = [...(event.currentTarget.files ?? [])];
                event.currentTarget.value = '';
                if (files.length) run(() => controller.addAttachments(files));
              }}
            />
          </label>
          {!!attachments.length && (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => controller.reloadDraft())}
            >
              重新读取附件
            </button>
          )}
          {attachments.map((item) => {
            const image = attachmentPreviewUrl(item.reference, item.data),
              text = attachmentText(item.reference, item.data);
            const reason = attachmentSupported
              ? attachmentInputReason(item.reference, session.agent?.inputCapabilities)
              : '此执行电脑尚未提供附件能力，请更新主机。';
            return (
              <article key={item.reference.attachmentId}>
                <span>
                  {item.reference.name} · {formatAttachmentSize(item.reference.content.byteLength)}
                </span>
                <small>
                  {item.pending ? '等待主机确认' : item.uploaded ? '已上传' : '保存在本机'}
                </small>
                {image && <img src={image} alt={item.reference.name} />}
                {text !== undefined && (
                  <details>
                    <summary>预览附件</summary>
                    <pre>{text}</pre>
                  </details>
                )}
                {reason && <p>{reason}</p>}
                {item.pending ? (
                  <button
                    type="button"
                    disabled={busy || state.offline}
                    onClick={() => run(() => controller.retry(item.pending!.request.operationId))}
                  >
                    重试附件原操作
                  </button>
                ) : (
                  <>
                    {!item.uploaded && (
                      <button
                        type="button"
                        disabled={busy || state.offline || !!reason}
                        onClick={() =>
                          run(() => controller.uploadAttachment(item.reference.attachmentId))
                        }
                      >
                        上传附件
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy || (item.uploaded && (state.offline || !attachmentSupported))}
                      onClick={() =>
                        run(() => controller.removeAttachment(item.reference.attachmentId))
                      }
                    >
                      移除附件
                    </button>
                  </>
                )}
              </article>
            );
          })}
        </div>
        {saveError && (
          <div role="alert">
            <p>{saveError} 当前输入保留在编辑框中。</p>
            <button
              type="button"
              onClick={() =>
                run(async () => {
                  await controller.reloadDraft();
                  setText(controller.state.draft?.text ?? '');
                  setSelection(controller.state.draft?.selection ?? {});
                  setSaveError('');
                  reportDirty('composer', false);
                })
              }
            >
              重新读取已保存草稿
            </button>
          </div>
        )}
        <RunControls
          idPrefix="workspace"
          capabilities={session.agent?.runConfig}
          selection={selection}
          agentType={session.meta.agentType}
          disabled={busy}
          loading={false}
          canRefresh={!state.offline && !busy}
          validation={validation}
          status={state.modelError}
          existing
          onChange={(key, value) => {
            const next = { ...selection };
            if (value) next[key] = value;
            else delete next[key];
            save(text, next);
          }}
          onRefresh={() => run(() => controller.refreshAgentOptions())}
          onOpenModels={() => run(() => controller.refreshAgentOptions())}
        />
        <div className="workspace-compose-actions">
          <small>{saving.current ? '正在保存草稿…' : '草稿保存在本机'}</small>
          {activeTurns.length === 1 ? (
            <button
              type="button"
              disabled={busy || state.offline}
              onClick={() => run(() => controller.stop(activeTurns[0]!.id))}
            >
              停止
            </button>
          ) : (
            <button
              type="submit"
              disabled={
                busy ||
                saving.current ||
                !!saveError ||
                !!validation ||
                (!text.trim() &&
                  !attachments.length &&
                  !state.ledger?.annotations?.[state.sessionId ?? '']?.annotations.some(
                    (item) => item.selectionId,
                  )) ||
                attachmentBlocked ||
                state.offline ||
                !!pending.length ||
                !!state.ledger?.interactions?.[state.sessionId]?.value.pending
              }
            >
              发送
            </button>
          )}
        </div>
      </form>
    </>
  );
}

export function WorkspaceApp({
  controller,
  secure,
  accountApi,
  onAccountVerified,
  openSettings,
  addLocalProject,
  readDesktopContext,
  subscribeDesktopChanges,
}: {
  controller: WorkspaceController;
  secure: SecureUiController;
  accountApi: SecureAccountApi;
  onAccountVerified?: (account: Account | null) => void;
  openSettings?: () => Promise<unknown>;
  addLocalProject?: () => Promise<unknown>;
  readDesktopContext?: () => Promise<unknown>;
  subscribeDesktopChanges?: (listener: () => void) => () => void;
}) {
  const [state, setState] = useState(controller.state),
    [encrypted, setEncrypted] = useState(secure.state);
  const [view, setView] = useState<'plain' | 'secure' | 'connections'>('plain');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [plainDirty, setPlainDirty] = useState(false),
    [secureBlocked, setSecureBlocked] = useState(false);
  const [agentId, setAgentId] = useState('');
  const layout = useWorkspaceLayout();
  const navigationOpen = layout.open,
    setNavigationOpen = layout.setOpen;
  const [collapsedProject, setCollapsedProject] = useState('');
  const [sessionFilter, setSessionFilter] = useState('active'),
    [sessionQuery, setSessionQuery] = useState('');
  const rootElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!layout.narrow || !navigationOpen) return;
    const root = rootElement.current,
      body = root?.querySelector<HTMLElement>('.workspace-body');
    if (!body) return;
    body.inert = true;
    root?.querySelector<HTMLButtonElement>('.workspace-sidebar button')?.focus();
    return () => {
      body.inert = false;
      root?.querySelector<HTMLButtonElement>('.workspace-navigation-bar button')?.focus();
    };
  }, [layout.narrow, navigationOpen]);
  const hideMobileNavigation = () => {
    if (window.innerWidth <= 700) setNavigationOpen(false);
  };
  const [desktop, setDesktop] = useState<{
    serial: number;
    value: z.infer<typeof desktopWorkspaceContextSchema>;
  } | null>(null);
  const desktopHandled = useRef(0),
    navigationHandled = useRef(-1),
    notificationHandled = useRef('');
  const action = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = controller.subscribe(() => setState(controller.state));
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [controller]);
  useEffect(() => secure.subscribe(setEncrypted), [secure]);
  useEffect(() => {
    if (readDesktopContext) return;
    void controller.refreshCatalog('local').catch((reason: unknown) => {
      if (mounted.current) setError(message(reason));
    });
  }, [controller, readDesktopContext]);
  useEffect(() => {
    if (!readDesktopContext) return;
    let active = true,
      serial = 0;
    const refresh = () => {
      const current = ++serial;
      void readDesktopContext()
        .then((raw) => {
          if (active && current === serial)
            setDesktop({ serial: current, value: desktopWorkspaceContextSchema.parse(raw) });
        })
        .catch((reason: unknown) => {
          if (active && current === serial) setError(message(reason));
        });
    };
    const unsubscribe = subscribeDesktopChanges?.(refresh);
    refresh();
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [readDesktopContext, subscribeDesktopChanges]);
  const verified = useCallback(
    (account: Account | null) => {
      onAccountVerified?.(account);
      if (account?.owner) void controller.refreshCatalog('remote').catch(() => {});
    },
    [controller, onAccountVerified],
  );
  const run: Run = (task) => {
    if (action.current) return false;
    action.current = true;
    setBusy(true);
    setError('');
    void task()
      .catch((reason: unknown) => {
        if (mounted.current) setError(message(reason));
      })
      .finally(() => {
        action.current = false;
        if (mounted.current) setBusy(false);
      });
    return true;
  };
  const blocked = busy || plainDirty || secureBlocked;
  useEffect(() => {
    if (!desktop || blocked || desktopHandled.current === desktop.serial) return;
    desktopHandled.current = desktop.serial;
    run(async () => {
      const context = desktop.value;
      if (context.revision !== navigationHandled.current) {
        navigationHandled.current = context.revision;
        if (context.view === 'remote') setView('connections');
      }
      if (!context.localReady) return;
      await controller.refreshCatalog('local');
      const notification = context.notification;
      if (!notification || notification.eventId === notificationHandled.current) return;
      notificationHandled.current = notification.eventId;
      const project = controller.state.catalogs.local?.targets.find(
        ({ target }) =>
          target.userId === notification.userId &&
          target.machineId === notification.machineId &&
          target.workspaceId === notification.workspaceId &&
          target.localProjectId === notification.localProjectId,
      );
      if (!project) throw Error('通知对应的本机项目尚不可用，请恢复原电脑后重新读取。');
      setView('plain');
      await controller.selectProject('local', project.target);
      await controller.openSession(notification.sessionId);
      hideMobileNavigation();
    });
  }, [desktop, blocked, controller]);
  const sessions = view === 'plain' ? state.sessions : encrypted.sessions;
  const selectedSession = view === 'plain' ? state.sessionId : encrypted.session?.meta.id;
  const secureReplica = encrypted.catalog?.products.replicas.find(
    (entry) => entry.id === encrypted.replicaId,
  );
  const agents =
    view === 'plain'
      ? (state.project?.runtime.agents ?? [])
      : (encrypted.catalog?.workspaces.find(
          (workspace) => workspace.id === secureReplica?.runtimeWorkspaceId,
        )?.agents ?? []);
  const selectedAgent = agents.some((agent) => agent.id === agentId)
    ? agentId
    : (agents[0]?.id ?? '');
  const choose = (
    source: DesktopWorkspaceSource,
    target: NonNullable<WorkspaceClientState['project']>['target'],
  ) =>
    run(async () => {
      setView('plain');
      await controller.selectProject(source, target);
    });
  const addProject = addLocalProject
    ? () => {
        if (blocked) return;
        run(async () => {
          setNotice('');
          const result = desktopAddProjectResultSchema.parse(await addLocalProject());
          if (result.canceled || !mounted.current) return;
          await controller.refreshCatalog('local');
          const entry = controller.state.catalogs.local?.targets.find(
            ({ target }) =>
              target.localProjectId === result.projectId &&
              target.owner === result.identity.owner &&
              target.deviceId === result.identity.deviceId &&
              target.workspaceId === result.identity.workspaceId &&
              target.machineId === result.identity.machineId &&
              target.userId === result.identity.userId,
          );
          if (!entry) throw Error('主机已登记项目，目录尚未更新，请刷新本机项目列表。');
          await controller.selectProject('local', entry.target);
          if (!mounted.current) return;
          setView('plain');
          const initialAgent =
            entry.runtime.agents.find((agent) => agent.id === agentId) ?? entry.runtime.agents[0];
          if (initialAgent) {
            const sessionId = await controller.createSession(initialAgent.id);
            await controller.refreshSessions();
            await controller.openSession(sessionId);
          }
          if (!mounted.current) return;
          setNotice(
            result.settingsSaved
              ? initialAgent
                ? '项目已添加，新会话已就绪。'
                : '项目已添加，请先配置本机 Agent。'
              : '项目已由主机保存，本机设置副本保存失败；请在设置中重新核对。',
          );
          hideMobileNavigation();
        });
      }
    : undefined;
  const scopeKey = canonical([state.scope ?? null, state.sessionId ?? null]);
  const sessionList = (
    <section className="workspace-session-list" aria-label="会话列表">
      <div className="workspace-list-title">
        <select
          aria-label="会话筛选"
          value={sessionFilter}
          onChange={(event) => setSessionFilter(event.target.value)}
        >
          <option value="active">最近会话</option>
          <option value="archived">已归档</option>
          <option value="all">全部会话</option>
        </select>
        <button
          aria-label="刷新会话列表"
          disabled={blocked || (view === 'plain' ? !state.project : !secureReplica)}
          onClick={() =>
            run(() => (view === 'plain' ? controller.refreshSessions() : secure.refreshSessions()))
          }
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <ul>
        {sessions
          .filter(
            (session) =>
              (sessionFilter === 'all' ||
                (sessionFilter === 'archived' ? session.isArchived : !session.isArchived)) &&
              (session.title || '未命名会话')
                .toLocaleLowerCase()
                .includes(sessionQuery.toLocaleLowerCase()),
          )
          .sort((a, b) => Number(!!b.isPinned) - Number(!!a.isPinned))
          .map((session) => (
            <li key={session.id}>
              <button
                aria-current={selectedSession === session.id ? 'page' : undefined}
                disabled={blocked}
                onClick={() =>
                  run(async () => {
                    if (view === 'plain') await controller.openSession(session.id);
                    else await secure.openSession(session.id);
                    hideMobileNavigation();
                  })
                }
              >
                <span className="workspace-session-title">
                  {session.isPinned ? '置顶 · ' : ''}
                  {session.title || '未命名会话'}
                </span>
                <small>
                  {session.isArchived
                    ? '已归档'
                    : session.status?.type === 'working'
                      ? '进行中'
                      : session.agentType}
                </small>
              </button>
            </li>
          ))}
      </ul>
    </section>
  );
  return (
    <div
      className="workspace-app"
      ref={rootElement}
      style={layout.style}
      data-navigation={navigationOpen ? 'open' : 'closed'}
      onKeyDown={(event) => {
        if (
          event.key === 'Escape' &&
          (!(event.target as HTMLElement).closest('[role="dialog"]') ||
            (event.target as HTMLElement).closest('#workspace-navigation'))
        ) {
          const details = (event.target as HTMLElement).closest('details[open]');
          if (details) {
            details.removeAttribute('open');
            details.querySelector('summary')?.focus();
          } else if (window.innerWidth <= 700) setNavigationOpen(false);
        }
      }}
    >
      <aside
        id="workspace-navigation"
        className="workspace-sidebar"
        aria-label="项目与会话"
        role={layout.narrow ? 'dialog' : undefined}
        aria-modal={layout.narrow && navigationOpen ? true : undefined}
        hidden={!navigationOpen}
      >
        <header>
          <img src="/moor-logo.png" alt="Moor" width={90} height={30} />
          <button
            className="workspace-navigation-close"
            aria-label="关闭项目与会话"
            onClick={() => setNavigationOpen(false)}
          >
            <X size={16} />
          </button>
        </header>
        <div className="workspace-navigation-actions">
          {addProject && (
            <button
              className="workspace-add-project"
              disabled={blocked || (desktop !== null && !desktop.value.localReady)}
              onClick={addProject}
            >
              <Plus size={15} />
              添加项目
            </button>
          )}
        </div>
        {!!agents.length && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!selectedAgent || blocked) return;
              run(async () => {
                if (view === 'plain') {
                  const id = await controller.createSession(selectedAgent);
                  await controller.refreshSessions();
                  await controller.openSession(id);
                } else await secure.createSession(selectedAgent);
                hideMobileNavigation();
              });
            }}
          >
            <select
              aria-label="新会话 Agent"
              value={selectedAgent}
              disabled={blocked}
              onChange={(event) => setAgentId(event.target.value)}
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            <button type="submit" disabled={blocked || !selectedAgent}>
              <Plus size={16} />
              新会话
            </button>
          </form>
        )}
        <div className="workspace-sidebar-search">
          <input
            aria-label="筛选当前项目会话"
            placeholder="筛选会话"
            value={sessionQuery}
            onChange={(event) => setSessionQuery(event.target.value)}
          />{' '}
          {view === 'plain' && (
            <WorkspaceAttentionUI controller={controller} state={state} busy={blocked} run={run} />
          )}
        </div>
        <nav className="workspace-projects" aria-label="电脑和项目">
          {(['local', 'remote'] as const).flatMap((source) =>
            (state.catalogs[source]?.targets ?? []).map((entry) => {
              const key = source + ':' + canonical(entry.target);
              const selected =
                view === 'plain' &&
                state.scope?.source === source &&
                canonical(state.scope.target) === canonical(entry.target);
              const expanded = selected && collapsedProject !== key;
              return (
                <section className="workspace-project-group" key={key}>
                  <div className="workspace-project-heading">
                    <button
                      className="workspace-project"
                      aria-current={selected ? 'page' : undefined}
                      disabled={blocked}
                      title={
                        entry.projectName +
                        ' · ' +
                        entry.hostName +
                        (source === 'local' ? ' · 本机' : '')
                      }
                      onClick={() => {
                        setCollapsedProject('');
                        choose(source, entry.target);
                      }}
                    >
                      <Folder size={15} />
                      <span>
                        {entry.projectName}
                        <small>
                          {entry.hostName}
                          {source === 'local' ? ' · 本机' : ''}
                          {entry.online ? '' : ' · 离线'}
                        </small>
                      </span>
                    </button>
                    {selected && (
                      <button
                        aria-label={expanded ? '折叠项目会话' : '展开项目会话'}
                        aria-expanded={expanded}
                        onClick={() => setCollapsedProject(expanded ? key : '')}
                      >
                        {expanded ? '−' : '+'}
                      </button>
                    )}
                  </div>
                  {selected && <div hidden={!expanded}>{sessionList}</div>}
                </section>
              );
            }),
          )}
          {encrypted.status?.connection?.hosts.map((host) => (
            <div key={host.deviceId}>
              <button
                className="workspace-project"
                disabled={blocked}
                onClick={() =>
                  run(async () => {
                    setView('secure');
                    await secure.selectHost(host.deviceId);
                  })
                }
              >
                <Monitor size={16} />
                <span>
                  {encrypted.hostId === host.deviceId
                    ? (encrypted.catalog?.deviceMetadata?.name ?? host.deviceId)
                    : host.deviceId}
                </span>
              </button>
              {encrypted.hostId === host.deviceId &&
                encrypted.catalog?.products.replicas.map((replica) => (
                  <button
                    className="workspace-project"
                    key={replica.id}
                    disabled={blocked || !replica.available}
                    aria-current={
                      view === 'secure' && encrypted.replicaId === replica.id ? 'page' : undefined
                    }
                    onClick={() =>
                      run(async () => {
                        setView('secure');
                        await secure.selectReplica(replica.id);
                      })
                    }
                  >
                    <Folder size={16} />
                    <span>
                      {encrypted.catalog?.products.projects.find(
                        (project) => project.id === replica.projectId,
                      )?.name ?? replica.localProjectId}
                    </span>
                  </button>
                ))}
            </div>
          ))}
          {view === 'secure' && secureReplica && sessionList}
          {!Object.values(state.catalogs).some((catalog) => catalog.targets.length) && (
            <p className="workspace-muted">点击“添加项目”，选择本机文件夹。</p>
          )}
        </nav>

        <footer>
          <button
            aria-label="刷新电脑"
            title="刷新电脑"
            disabled={blocked}
            onClick={() =>
              run(async () => {
                await controller.refreshCatalog('local');
                if (state.catalogs.remote) await controller.refreshCatalog('remote');
              })
            }
          >
            <RefreshCw size={15} />
          </button>
          {openSettings && (
            <button
              aria-label="本机设置"
              title="本机设置"
              disabled={blocked}
              onClick={() => run(openSettings)}
            >
              <Settings size={15} />
            </button>
          )}

          <button
            disabled={blocked}
            onClick={() => {
              setView('connections');
              hideMobileNavigation();
            }}
          >
            <Monitor size={16} />
            连接其他电脑
          </button>
        </footer>
      </aside>
      {navigationOpen && <SidebarSizer width={layout.width} resize={layout.resize} />}
      {navigationOpen && (
        <button
          className="workspace-navigation-backdrop"
          aria-label="收起项目与会话"
          onClick={() => setNavigationOpen(false)}
        />
      )}
      <div className="workspace-body">
        <div className="workspace-navigation-bar">
          <button
            aria-controls="workspace-navigation"
            aria-expanded={navigationOpen}
            onClick={() => setNavigationOpen((open) => !open)}
          >
            <PanelLeft size={16} />
            项目与会话
          </button>
        </div>
        {desktop && !desktop.value.localReady && (
          <p className="workspace-status" role="status">
            本机执行组件正在准备。连接其他电脑或打开设置仍可继续。
          </p>
        )}
        {notice && (
          <p className="workspace-status" role="status">
            {notice}
          </p>
        )}
        {error && (
          <div className="workspace-error" role="alert">
            {error}
          </div>
        )}
        <main hidden={view !== 'plain'} className="workspace-conversation">
          <WorkspaceConversation
            key={scopeKey}
            controller={controller}
            state={state}
            busy={busy}
            run={run}
            onDirty={setPlainDirty}
            addProject={addProject}
            configureAgent={
              state.scope?.source === 'local' && openSettings
                ? () => {
                    run(openSettings);
                  }
                : undefined
            }
          />
        </main>
        <div hidden={view === 'plain'} className="workspace-secure-content">
          <SecureApp
            controller={secure}
            accountApi={accountApi}
            onAccountVerified={verified}
            layout={view === 'connections' ? 'connections' : 'session'}
            onNavigationBlocked={setSecureBlocked}
          />
        </div>
      </div>
    </div>
  );
}

export async function bootWorkspace() {
  const bridges = window as unknown as {
    moorWorkspace?: {
      version: number;
      request(value: DesktopWorkspaceRequest): Promise<unknown>;
      context(): Promise<unknown>;
      addProject(): Promise<unknown>;
      onChange(listener: () => void): () => void;
    };
    moorSecure?: {
      version: number;
      request(value: DesktopSecureRequest): Promise<unknown>;
      account: SecureAccountApi;
    };
    moorDesktop?: { openSettings?: () => Promise<unknown> };
  };
  if (bridges.moorWorkspace?.version !== 1 || bridges.moorSecure?.version !== 1)
    throw Error('桌面工作区接口不可用。');
  const container = document.getElementById('app');
  if (!container) throw Error('桌面页面容器不可用。');
  let account: Account | null = null;
  const controller = new WorkspaceController({
    request: (value) => bridges.moorWorkspace!.request(value),
  });
  const secure = new SecureWorkspaceController({
    request: (value) => bridges.moorSecure!.request(value),
    account: () => (account?.owner ? { origin: account.origin, owner: account.owner } : null),
  });
  const root = createRoot(container);
  root.render(
    <WorkspaceApp
      controller={controller}
      secure={secure}
      accountApi={(value) => bridges.moorSecure!.account(value)}
      onAccountVerified={(value) => {
        account = value;
      }}
      openSettings={bridges.moorDesktop?.openSettings}
      addLocalProject={bridges.moorWorkspace.addProject}
      readDesktopContext={bridges.moorWorkspace.context}
      subscribeDesktopChanges={bridges.moorWorkspace.onChange}
    />,
  );
  window.addEventListener(
    'pagehide',
    () => {
      root.unmount();
      controller.close();
      secure.close();
    },
    { once: true },
  );
}
