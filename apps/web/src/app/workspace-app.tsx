import { changeRunSelection } from '@moor/protocol/run-config';
import { AGENT_RUN_DEFAULTS_FEATURE } from '@moor/protocol/agent-controls';
import { UsagePanel, latestContextUsage } from '../components/usage-panel';
import { AppearanceSettings } from '../components/appearance';
import {
  NavigationSessions,
  NavigationProjectGroup,
  useNavigationSessions,
  navigationProjects,
  projectKey,
  workspaceKey,
  type NavigationProject,
} from '../features/sessions/workspace-navigation';
import {
  useWorkspaceLayout,
  SidebarSizer,
  WorkspaceToolMenu,
} from '../features/workspace/workspace-layout';
import {
  SessionTimeline,
  SessionInformation,
  hasTurnFileChanges,
  turnFileChanges,
} from '../features/sessions/session-timeline';
import { SESSION_FORK_FEATURE } from '@moor/protocol/fork-protocol';
import { PROJECT_DIFF_FEATURE } from '@moor/protocol/project-content-protocol';
import {
  WorkspaceContentUI,
  type WorkspaceContentHandle,
} from '../features/files/workspace-content-ui';
import { WorkspaceAttentionUI } from '../features/attention/workspace-attention-ui';
import { WorkspaceSessionTools } from '../features/workspace/workspace-session-tools';
import { WorkspaceGithubUI } from '../features/github/workspace-github-ui';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
  ArrowUp,
  Square,
  SquarePen,
  Search,
  ChevronDown,
  GitBranch,
  CircleUserRound,
  X,
} from 'lucide-react';
import {
  WorkspaceController,
  type WorkspaceClientState,
} from '../features/workspace/workspace-controller';
import { WorkspaceAccountPanel } from '../features/auth/workspace-account';
import type { Account, AccountApi } from '../platform/account';
import { sessionPendingOperations } from '../features/workspace/workspace-store';

import type {
  DesktopWorkspaceRequest,
  DesktopWorkspaceSource,
} from '@moor/client/workspace-protocol';
import {
  desktopWorkspaceContextSchema,
  desktopAddProjectResultSchema,
} from '@moor/client/workspace-protocol';
import type { z } from 'zod';
import { RunControls } from '../components/ui';
import { resolveRunSelection, type RunSelection } from '@moor/protocol/run-config';
import { markdown } from '../components/content';
import { sessionPermissionReviews } from '@moor/client/session-client';
import { productCanonicalJson as canonical } from '@moor/protocol/canonical-json';
import {
  attachmentInputReason,
  attachmentPreviewUrl,
  attachmentText,
  formatAttachmentSize,
} from '../features/attachments/attachments';
import { attachmentReferenceSchema } from '@moor/protocol/content-protocol';
import { WorkspaceAttachmentView } from '../features/attachments/workspace-attachment-view';
import { ATTACHMENTS_FEATURE } from '@moor/protocol/attachment-protocol';
import { WorkspaceInteractionUI } from '../features/interactions/workspace-interaction-ui';
import { WorkspaceSkillsUI } from '../features/skills/workspace-skills-ui';
import { WorkspaceGitUI } from '../features/git/workspace-git-ui';
import { WorkspaceForkUI, type WorkspaceForkHandle } from '../features/fork/workspace-fork-ui';

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
  navigate,
  onDirty,
  addProject,
  configureAgent,
  projects,
  onProjectChange,
}: {
  controller: WorkspaceController;
  state: WorkspaceClientState;
  busy: boolean;
  run: Run;
  navigate: Run;
  onDirty(value: boolean): void;
  addProject?: () => void;
  configureAgent?: () => void;
  projects: NavigationProject[];
  onProjectChange(project: NavigationProject): void;
}) {
  const [text, setText] = useState(state.draft?.text ?? ''),
    [selection, setSelection] = useState<RunSelection>(state.draft?.selection ?? {});
  const [saveError, setSaveError] = useState('');
  const latestComposer = useRef({ text, selection });
  latestComposer.current = { text, selection };
  const contentPanel = useRef<WorkspaceContentHandle>(null),
    forkPanel = useRef<WorkspaceForkHandle>(null),
    gitPanel = useRef<{ open(): boolean }>(null),
    skillsPanel = useRef<{ open(): boolean }>(null);
  const [branch, setBranch] = useState<string>();
  const readBranch = useCallback(() => {
    let active = true;
    if (!state.sessionId || state.offline || state.sessionLoad.status !== 'ready') {
      setBranch(undefined);
      return () => {};
    }
    void controller
      .readGitContext()
      .then((value) => {
        if (active) setBranch(value?.execution.branch ?? value?.repository.branch);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [controller, state.sessionId, state.offline, state.sessionLoad.status]);
  useEffect(readBranch, [readBranch]);
  const active = useRef(true),
    draftVersion = useRef(0),
    draftDirty = useRef(false);
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!draftDirty.current && !saveError) {
      setText(state.draft?.text ?? '');
      setSelection(state.draft?.selection ?? {});
    }
  }, [state.draft?.revision, saveError]);
  const save = (nextText: string, nextSelection: RunSelection) => {
    setText(nextText);
    setSelection(nextSelection);
    setSaveError('');
    draftDirty.current = true;
    const version = ++draftVersion.current;
    controller.queueDraft(
      nextText,
      nextSelection,
      (error) => {
        if (active.current && version === draftVersion.current) setSaveError(message(error));
      },
      () => {
        if (active.current && version === draftVersion.current) draftDirty.current = false;
      },
    );
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
  if (!session || !state.sessionId || !state.scope) {
    const loading = ['loading-cache', 'refreshing'].includes(state.sessionLoad.status);
    if (loading)
      return (
        <section
          className="workspace-empty workspace-session-loading"
          role="status"
          aria-label="正在打开会话"
          aria-busy="true"
        >
          <img className="moor-logo" src="/moor-logo.png" alt="Moor" width={96} height={32} />
        </section>
      );
    return (
      <section className="workspace-empty">
        <Folder aria-hidden="true" />
        <h1>
          {state.sessionLoad.status === 'failed'
            ? state.sessionLoad.reason === 'local'
              ? '本机会话恢复失败'
              : '会话暂不可用'
            : (state.project?.projectName ?? '从你的项目开始')}
        </h1>
        <p>
          {state.sessionLoad.status === 'failed'
            ? state.sessionLoad.reason === 'local'
              ? '本机缓存无法读取，请重试或检查存储。'
              : '执行电脑暂不可达，本机尚无此会话缓存。'
            : state.project
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
  }
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
  const pending = sessionPendingOperations(state.ledger, state.sessionId);
  const retiredTask = state.ledger?.tasks?.[state.sessionId]?.pending;
  const attachments = state.ledger?.attachments?.[state.sessionId]?.items ?? [];
  const attachmentSupported = state.project?.runtime.features?.includes(ATTACHMENTS_FEATURE);
  const sessionRefreshing = ['loading-cache', 'refreshing'].includes(state.sessionLoad.status);
  const sessionWritable = state.sessionLoad.status === 'ready' && !state.offline;
  const attachmentBlocked = attachments.some(
    (item) =>
      !item.uploaded ||
      item.pending ||
      attachmentInputReason(item.reference, session.agent?.inputCapabilities),
  );
  const canSend =
    !busy &&
    !saveError &&
    !state.modelError &&
    !validation &&
    (text.trim() || attachments.length) &&
    !attachmentBlocked &&
    sessionWritable &&
    !pending.length &&
    !retiredTask &&
    !activeTurns.length &&
    !state.ledger?.interactions?.[state.sessionId]?.value.pending;
  return (
    <>
      <header className="workspace-session-header">
        <h1>{session.meta.title || '新对话'}</h1>
        <div className="workspace-header-tools">
          {sessionRefreshing && (
            <span
              className="workspace-session-sync"
              role="status"
              aria-label="正在与执行电脑同步会话"
              title="正在同步会话"
            >
              <RefreshCw className="spin" size={15} aria-hidden="true" />
            </span>
          )}
          <WorkspaceToolMenu>
            <WorkspaceSessionTools
              controller={controller}
              state={state}
              busy={busy}
              run={run}
              navigate={navigate}
            />
            <WorkspaceForkUI
              controller={controller}
              state={state}
              busy={busy || !sessionWritable}
              run={run}
              navigate={navigate}
              controlRef={forkPanel}
            />
            <SessionInformation
              history={session.history}
              disabled={busy || !sessionWritable || !!saveError}
              onCommand={(command) => save(text ? text + '\n' + command : command, selection)}
              onFiles={
                state.project?.runtime.features?.includes(PROJECT_DIFF_FEATURE)
                  ? (turnId) => {
                      contentPanel.current?.open('changes', turnId);
                    }
                  : undefined
              }
            />
            <button
              disabled={busy || sessionRefreshing}
              onClick={() => navigate(() => controller.refreshSession())}
              aria-label="刷新会话"
            >
              <RefreshCw size={16} />
              <span>刷新会话</span>
            </button>
          </WorkspaceToolMenu>
          <WorkspaceToolMenu kind="environment" hidden={!session.history.length}>
            <WorkspaceContentUI
              controller={controller}
              busy={busy}
              run={run}
              controlRef={contentPanel}
            />
            <div className="workspace-environment-location">
              <Monitor size={16} />
              <span>{state.project?.hostName}</span>
              <small>{sessionRefreshing ? '同步中' : state.offline ? '离线' : '已连接'}</small>
            </div>
            <WorkspaceGitUI
              controller={controller}
              state={state}
              busy={busy}
              run={run}
              controlRef={gitPanel}
              onChanged={readBranch}
            />
            <WorkspaceGithubUI
              controller={controller}
              state={state}
              busy={busy || !sessionWritable}
              run={run}
            />
          </WorkspaceToolMenu>
        </div>
      </header>
      {!session.history.length && (
        <div className="workspace-welcome">
          <h2>今天想完成什么？</h2>
          <p>{state.project?.projectName} · 随时开始一个想法</p>
        </div>
      )}
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
              navigate(() => controller.openSession(session.meta.forkOrigin!.sourceSessionId))
            }
          >
            打开源会话
          </button>
        </aside>
      )}
      {!sessionRefreshing && (state.offline || state.sessionLoad.status === 'failed') && (
        <p className="workspace-status" role="status">
          {state.sessionLoad.status === 'failed' && state.sessionLoad.reason === 'local'
            ? '本机缓存读取失败；当前输入仍保留在编辑器中。'
            : state.offline
              ? '执行电脑暂不可达，显示本机缓存；草稿仍可编辑。'
              : '连接已恢复，当前会话尚未重新同步，正在显示本机缓存。'}
        </p>
      )}
      <SessionTimeline
        history={session.history}
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
                    disabled={busy || !sessionWritable}
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
                  disabled={busy || !sessionWritable}
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
                disabled={busy || !sessionWritable}
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
                disabled={busy || !sessionWritable}
                onClick={() => run(() => controller.inspect(entry.original.value.operationId))}
              >
                核查结果
              </button>
              <button
                disabled={busy || !sessionWritable}
                onClick={() => run(() => controller.retry(entry.original.value.operationId))}
              >
                重试原操作
              </button>
              <button
                disabled={busy || !sessionWritable}
                onClick={() => run(() => controller.abandon(entry.original.value.operationId))}
              >
                结束原操作
              </button>
            </div>
          ))}
        </details>
      )}
      {retiredTask && (
        <details className="workspace-pending">
          <summary>待确认的旧版操作</summary>
          <p>协作功能已移除，原操作记录仍保留。核查结果不会创建任务。</p>
          <code>{retiredTask.operationId}</code>
          <button
            disabled={busy || !sessionWritable}
            onClick={() => run(() => controller.recoverRetiredTask(retiredTask, 'inspect'))}
          >
            核查旧版操作
          </button>
          <button
            disabled={busy || !sessionWritable}
            onClick={() => run(() => controller.recoverRetiredTask(retiredTask, 'retry'))}
          >
            重试旧版原操作
          </button>
        </details>
      )}
      <WorkspaceInteractionUI
        controller={controller}
        state={state}
        busy={busy || !sessionWritable}
        run={run}
        onDirty={onDirty}
      />
      <form
        className="workspace-composer"
        data-empty={!session.history.length}
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) run(() => controller.send());
        }}
      >
        <div className="workspace-composer-context" aria-label="执行上下文">
          <label>
            <Folder size={14} />
            <select
              aria-label="选择项目"
              value={
                state.project && state.scope
                  ? projectKey({ ...state.project, source: state.scope.source })
                  : ''
              }
              disabled={busy || !!saveError}
              onChange={(event) => {
                const project = projects.find((entry) => projectKey(entry) === event.target.value);
                if (project) onProjectChange(project);
              }}
            >
              {projects.map((entry) => (
                <option key={projectKey(entry)} value={projectKey(entry)}>
                  {entry.projectName} · {entry.hostName}
                </option>
              ))}
            </select>
            <ChevronDown size={12} />
          </label>
          <label>
            <Monitor size={14} />
            <select
              aria-label="执行电脑"
              value={
                state.project && state.scope
                  ? projectKey({ ...state.project, source: state.scope.source })
                  : ''
              }
              disabled={busy || !!saveError}
              onChange={(event) => {
                const project = projects.find((entry) => projectKey(entry) === event.target.value);
                if (project) onProjectChange(project);
              }}
            >
              {projects
                .filter(
                  (entry) =>
                    entry.target.catalogProjectId === state.scope?.target.catalogProjectId &&
                    entry.target.owner === state.scope?.target.owner &&
                    entry.target.serverKey === state.scope?.target.serverKey,
                )
                .map((entry) => (
                  <option key={projectKey(entry)} value={projectKey(entry)}>
                    {entry.hostName}
                    {entry.online ? '' : ' · 离线'}
                  </option>
                ))}
            </select>
            <ChevronDown size={12} />
          </label>
          <button
            type="button"
            disabled={busy || !sessionWritable}
            onClick={() => gitPanel.current?.open()}
            title="选择 Git 分支与工作目录"
          >
            <GitBranch size={14} />
            <span>{branch ?? '工作目录'}</span>
            <ChevronDown size={12} />
          </button>
        </div>
        <div className="workspace-input-box">
          <textarea
            aria-label="消息"
            placeholder="描述你想完成的事情，输入 $ 使用 Skills…"
            rows={2}
            onKeyDown={(event) => {
              if (event.key === '$' && !event.nativeEvent.isComposing && !text.trim() && !busy) {
                event.preventDefault();
                skillsPanel.current?.open();
              }
              if (
                event.key === 'Enter' &&
                (event.metaKey || event.ctrlKey) &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
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
                    {item.reference.name} ·{' '}
                    {formatAttachmentSize(item.reference.content.byteLength)}
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
                      disabled={busy || !sessionWritable}
                      onClick={() => run(() => controller.retry(item.pending!.request.operationId))}
                    >
                      重试附件原操作
                    </button>
                  ) : (
                    <>
                      {!item.uploaded && (
                        <button
                          type="button"
                          disabled={busy || !sessionWritable || !!reason}
                          onClick={() =>
                            run(() => controller.uploadAttachment(item.reference.attachmentId))
                          }
                        >
                          上传附件
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={
                          busy || (item.uploaded && (!sessionWritable || !attachmentSupported))
                        }
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
                    draftVersion.current++;
                    draftDirty.current = false;
                    setSaveError('');
                  })
                }
              >
                重新读取已保存草稿
              </button>
            </div>
          )}
          <div className="workspace-compose-actions">
            <WorkspaceToolMenu kind="composer">
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
              <WorkspaceSkillsUI
                controller={controller}
                state={state}
                busy={busy || !sessionWritable}
                run={run}
                controlRef={skillsPanel}
              />
            </WorkspaceToolMenu>
            <RunControls
              idPrefix="workspace"
              capabilities={session.agent?.runConfig}
              selection={selection}
              agentType={session.meta.agentType}
              disabled={busy}
              loading={state.modelLoading === true}
              canRefresh={sessionWritable && !busy}
              validation={validation}
              status={state.modelError}
              existing
              onChange={(key, value) => {
                const next = changeRunSelection(selection, key, value, session.agent?.runConfig);
                if (key === 'modeId')
                  run(async () => {
                    await controller.saveApprovalDefault(value);
                    const latest = latestComposer.current;
                    save(latest.text, { ...latest.selection, modeId: value });
                  });
                else save(text, next);
              }}
              onRefresh={() => run(() => controller.refreshAgentOptions())}
              onSaveDefaults={
                state.project?.runtime.features?.includes(AGENT_RUN_DEFAULTS_FEATURE)
                  ? (defaults) => controller.saveRunDefaults(defaults)
                  : undefined
              }
            />
            <UsagePanel
              context={latestContextUsage(session.history)}
              usage={session.accountUsage}
              loading={state.usageLoading}
              onRead={() => run(() => controller.readUsage())}
            />
            {activeTurns.length === 1 ? (
              <button
                type="button"
                disabled={busy || !sessionWritable}
                onClick={() => run(() => controller.stop(activeTurns[0]!.id))}
              >
                <Square size={14} fill="currentColor" />
                <span className="sr-only">停止</span>
              </button>
            ) : (
              <button type="submit" disabled={!canSend}>
                <ArrowUp size={18} />
                <span className="sr-only">发送</span>
              </button>
            )}
          </div>
        </div>
      </form>
    </>
  );
}

export function WorkspaceApp({
  controller,
  accountApi,
  onAccountVerified,
  openSettings,
  addLocalProject,
  readDesktopContext,
  subscribeDesktopChanges,
  subscribeSessionChanges,
  localAvailable = true,
  accountExtras,
}: {
  controller: WorkspaceController;
  accountApi: AccountApi;
  onAccountVerified?: (account: Account | null) => void;
  openSettings?: () => Promise<unknown>;
  addLocalProject?: () => Promise<unknown>;
  readDesktopContext?: () => Promise<unknown>;
  subscribeDesktopChanges?: (listener: () => void) => () => void;
  subscribeSessionChanges?: (listener: (notice: unknown) => void) => () => void;
  localAvailable?: boolean;
  accountExtras?: ReactNode;
}) {
  const [state, setState] = useState(controller.state);
  const [view, setView] = useState<'plain' | 'connections'>('plain');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [plainDirty, setPlainDirty] = useState(false);
  const [agentId, setAgentId] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false),
    [workspace, setWorkspace] = useState(''),
    [searchOpen, setSearchOpen] = useState(false),
    [account, setAccount] = useState<Account | null>(null);
  const allProjects = navigationProjects(state);
  const workspaces = [
    ...new Map(allProjects.map((entry) => [workspaceKey(entry), entry.workspaceName])).entries(),
  ];
  const activeWorkspace = workspaces.some(([key]) => key === workspace) ? workspace : '';
  const projects = allProjects.filter(
    (entry) => !activeWorkspace || workspaceKey(entry) === activeWorkspace,
  );
  const layout = useWorkspaceLayout();
  const navigationOpen = layout.open,
    setNavigationOpen = layout.setOpen;
  const [sessionQuery, setSessionQuery] = useState('');
  const [pinnedShown, setPinnedShown] = useState(30),
    [recentShown, setRecentShown] = useState(30);
  const navigation = useNavigationSessions(controller, state, projects, sessionQuery);
  useEffect(() => {
    const refresh = () => {
      void controller.refreshCatalog('remote').catch(() => {});
    };
    window.addEventListener('moor:catalog-changed', refresh);
    return () => window.removeEventListener('moor:catalog-changed', refresh);
  }, [controller]);
  useEffect(() => {
    setPinnedShown(30);
    setRecentShown(30);
  }, [activeWorkspace, sessionQuery]);
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
    navigationAction = useRef(0),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = controller.subscribe(() => setState(controller.state));
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [controller]);
  useEffect(() => {
    const catchUp = () => {
      if (document.visibilityState !== 'hidden') controller.scheduleSync?.();
    };
    const unsubscribe = subscribeSessionChanges?.((notice) => controller.scheduleSync(notice));
    window.addEventListener('online', catchUp);
    window.addEventListener('focus', catchUp);
    document.addEventListener('visibilitychange', catchUp);
    return () => {
      unsubscribe?.();
      window.removeEventListener('online', catchUp);
      window.removeEventListener('focus', catchUp);
      document.removeEventListener('visibilitychange', catchUp);
    };
  }, [controller, subscribeSessionChanges]);
  useEffect(() => {
    if (readDesktopContext || !localAvailable) return;
    void controller.refreshCatalog('local').catch((reason: unknown) => {
      if (mounted.current) setError(message(reason));
    });
  }, [controller, readDesktopContext, localAvailable]);
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
      setAccount(account);
      onAccountVerified?.(account);
      if (account?.owner && localAvailable)
        void controller.refreshCatalog('remote').catch(() => {});
    },
    [controller, onAccountVerified, localAvailable],
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
  const navigate: Run = (task) => {
    if (action.current || plainDirty) return false;
    const version = ++navigationAction.current;
    setError('');
    void task().catch((reason: unknown) => {
      if (mounted.current && version === navigationAction.current) setError(message(reason));
    });
    return true;
  };
  const blocked = busy || plainDirty;
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
  const sessions = state.sessions;
  const agents = state.project?.runtime.agents ?? [];
  const selectedAgent = agents.some((agent) => agent.id === agentId)
    ? agentId
    : (agents[0]?.id ?? '');
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
  const navigationEntries = projects
    .flatMap((project) =>
      (navigation.sessions[projectKey(project)] ?? [])
        .filter(
          (session) =>
            !session.isArchived &&
            ((session.title || '未命名会话')
              .toLowerCase()
              .includes(sessionQuery.trim().toLowerCase()) ||
              session.id.toLowerCase().includes(sessionQuery.trim().toLowerCase())),
        )
        .map((session) => ({
          project: {
            ...project,
            online:
              project.online &&
              !navigation.cached.includes(projectKey(project)) &&
              !navigation.unavailable.includes(projectKey(project)),
          },
          session,
        })),
    )
    .sort(
      (a, b) =>
        (b.session.lastMessageAt ?? 0) - (a.session.lastMessageAt ?? 0) ||
        canonical([projectKey(a.project), a.session.id]).localeCompare(
          canonical([projectKey(b.project), b.session.id]),
        ),
    );
  const pinnedEntries = navigationEntries.filter((entry) => entry.session.isPinned),
    recentEntries = navigationEntries.filter((entry) => !entry.session.isPinned);
  const navigationSelected =
    view === 'plain' && state.project && state.scope
      ? canonical([projectKey({ ...state.project, source: state.scope.source }), state.sessionId])
      : undefined;
  const openNavigationSession = (
    project: NavigationProject,
    session: (typeof sessions)[number],
  ) => {
    navigate(async () => {
      setView('plain');
      if (
        state.scope?.source !== project.source ||
        canonical(state.scope.target) !== canonical(project.target)
      )
        await controller.selectProject(project.source, project.target);
      await controller.openSession(session.id);
      hideMobileNavigation();
    });
  };
  const manageNavigationSession: Parameters<typeof NavigationSessions>[0]['onAction'] = (
    project,
    session,
    action,
    title,
    done,
    failed,
  ) => {
    run(async () => {
      try {
        await controller.projectMetadata(project.source, project.target, session, action, title);
        done?.();
      } catch (error) {
        failed?.(message(error));
        throw error;
      }
    });
  };
  const createProjectSession = (project: NavigationProject) => {
    if (blocked) return;
    run(async () => {
      const agent =
        project.runtime.agents.find((entry) => entry.id === selectedAgent) ??
        project.runtime.agents[0];
      if (!agent) throw Error('请先为此项目配置 Agent。');
      setView('plain');
      await controller.selectProject(project.source, project.target);
      const id = await controller.createSession(agent.id);
      await controller.refreshSessions();
      await controller.openSession(id);
      hideMobileNavigation();
    });
  };
  const changeComposerProject = createProjectSession;
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
        <header className="workspace-sidebar-top">
          <label className="workspace-switcher">
            <span className="workspace-avatar">M</span>
            {workspaces.length > 1 ? (
              <>
                <select
                  aria-label="切换工作区"
                  value={activeWorkspace}
                  onChange={(event) => setWorkspace(event.target.value)}
                >
                  <option value="">全部工作区</option>
                  {workspaces.map(([key, name]) => (
                    <option key={key} value={key}>
                      {name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} />
              </>
            ) : (
              <span>{workspaces[0]?.[1] ?? 'Moor'}</span>
            )}
          </label>
          <button
            className="workspace-navigation-close"
            aria-label="关闭项目与会话"
            onClick={() => setNavigationOpen(false)}
          >
            <PanelLeft size={16} />
          </button>
        </header>
        {!!agents.length && (
          <form
            className="workspace-new-conversation"
            onSubmit={(event) => {
              event.preventDefault();
              if (!selectedAgent || blocked) return;
              run(async () => {
                const id = await controller.createSession(selectedAgent);
                await controller.refreshSessions();
                await controller.openSession(id);
                setView('plain');
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
              <SquarePen size={16} />
              新对话
            </button>
          </form>
        )}
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
        <div className="workspace-sidebar-search">
          <button
            aria-label="搜索会话"
            aria-expanded={searchOpen}
            onClick={() => setSearchOpen((open) => !open)}
          >
            <Search size={15} />
            <span>搜索</span>
          </button>
          <input
            hidden={!searchOpen}
            aria-label="筛选当前工作区会话"
            placeholder="筛选会话"
            maxLength={200}
            value={sessionQuery}
            onChange={(event) => setSessionQuery(event.target.value)}
          />{' '}
          {view === 'plain' && (
            <WorkspaceAttentionUI controller={controller} state={state} busy={blocked} run={run} />
          )}
        </div>
        <nav className="workspace-projects" aria-label="电脑和项目">
          {Object.values(state.syncDisconnected ?? {}).some(Boolean) && (
            <p className="workspace-muted" role="status">
              实时连接中断，正在重连
              <button onClick={() => run(() => controller.synchronize())}>重新同步</button>
            </p>
          )}
          {navigation.unavailable.length > 0 && (
            <p className="workspace-muted" role="status">
              部分电脑的会话暂不可读取
            </p>
          )}
          <NavigationSessions
            kind="pinned"
            entries={pinnedEntries.slice(0, pinnedShown)}
            more={navigation.summaries.pinned.more || pinnedEntries.length > pinnedShown}
            loading={navigation.summaries.pinned.loading}
            cached={navigation.summaries.pinned.cached}
            legacy={navigation.summaries.pinned.legacy}
            error={navigation.summaries.pinned.error}
            onLoadMore={() => {
              void navigation.loadMore('pinned').then((current) => {
                if (current) setPinnedShown((value) => value + 30);
              });
            }}
            onRefresh={() =>
              run(async () => {
                for (const source of new Set(projects.map((project) => project.source)))
                  await controller.refreshCatalog(source);
                navigation.refresh('pinned');
              })
            }
            selected={navigationSelected}
            disabled={blocked}
            onOpen={openNavigationSession}
            onAction={manageNavigationSession}
          />
          <section className="workspace-navigation-section" aria-label="项目">
            <h2>项目</h2>
            {projects.map((project) => (
              <NavigationProjectGroup
                key={projectKey(project)}
                project={project}
                sessions={navigation.sessions[projectKey(project)]}
                selected={
                  view === 'plain' &&
                  state.scope?.source === project.source &&
                  canonical(state.scope.target) === canonical(project.target)
                }
                selectedSession={state.sessionId}
                disabled={blocked}
                query={sessionQuery}
                controller={controller}
                revision={
                  controller.projectRevision?.(project.source, project.target) ??
                  controller.navigationRevision ??
                  0
                }
                unavailable={navigation.unavailable.includes(projectKey(project))}
                onOpen={openNavigationSession}
                onAction={manageNavigationSession}
                onCreate={createProjectSession}
                onRefresh={(project) =>
                  run(() =>
                    typeof controller.refreshProjectSessions === 'function'
                      ? controller.refreshProjectSessions(project.source, project.target)
                      : controller.synchronize({
                          source: project.source,
                          connectionId: state.catalogs[project.source]!.connectionId,
                          owner: project.target.owner,
                          kind: 'connected',
                          deviceId: project.target.deviceId,
                          workspaceId: project.target.workspaceId,
                        }),
                  )
                }
              />
            ))}
          </section>
          <NavigationSessions
            kind="recent"
            entries={recentEntries.slice(0, recentShown)}
            more={navigation.summaries.recent.more || recentEntries.length > recentShown}
            loading={navigation.summaries.recent.loading}
            cached={navigation.summaries.recent.cached}
            legacy={navigation.summaries.recent.legacy}
            error={navigation.summaries.recent.error}
            onLoadMore={() => {
              void navigation.loadMore('recent').then((current) => {
                if (current) setRecentShown((value) => value + 30);
              });
            }}
            onRefresh={() =>
              run(async () => {
                for (const source of new Set(projects.map((project) => project.source)))
                  await controller.refreshCatalog(source);
                navigation.refresh('recent');
              })
            }
            selected={navigationSelected}
            disabled={blocked}
            onOpen={openNavigationSession}
            onAction={manageNavigationSession}
          />
          {!Object.values(state.catalogs).some((catalog) => catalog.targets.length) && (
            <p className="workspace-muted">
              {addProject
                ? '点击“添加项目”，选择本机文件夹。'
                : '暂无已连接项目，请在执行电脑登记项目并连接。'}
            </p>
          )}
        </nav>

        <footer className="workspace-account">
          <button
            className="workspace-account-button"
            disabled={blocked}
            onClick={() => {
              setView('connections');
              hideMobileNavigation();
            }}
            aria-label="账号与连接"
          >
            <CircleUserRound size={22} />
            <span>
              {account?.owner ? '已连接账号' : localAvailable ? '本机账号' : '离线账号'}
              <small>
                {account?.owner ? '账号与设备' : localAvailable ? 'Local workspace' : '本机缓存'}
              </small>
            </span>
          </button>
          <WorkspaceToolMenu>
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
            <button
              aria-label="刷新电脑"
              disabled={blocked}
              onClick={() =>
                run(async () => {
                  await controller.refreshCatalog('local');
                  if (state.catalogs.remote) await controller.refreshCatalog('remote');
                })
              }
            >
              <RefreshCw size={16} />
              刷新电脑
            </button>
          </WorkspaceToolMenu>
          <button aria-label="设置" title="设置" onClick={() => setSettingsOpen(true)}>
            <Settings size={16} />
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
      <AppearanceSettings
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        agentControls={
          state.session?.agent
            ? {
                name: state.session.agent.name,
                disabled: blocked,
                observedAt: state.session.agent.capabilityContext?.observedAt,
                scopeLabel: state.project?.projectName,
                error: state.modelError,
                refresh: async () => {
                  await controller.refreshAgentOptions(true);
                  await controller.readUsage(true);
                },
              }
            : undefined
        }
        openDesktopSettings={
          openSettings
            ? () => {
                run(openSettings);
              }
            : undefined
        }
      />
      <div className="workspace-body">
        <div className="workspace-navigation-bar">
          <button
            aria-controls="workspace-navigation"
            aria-expanded={navigationOpen}
            onClick={() => setNavigationOpen((open) => !open)}
          >
            <PanelLeft size={16} />
            <span className="sr-only">项目与会话</span>
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
            navigate={navigate}
            onDirty={setPlainDirty}
            projects={allProjects}
            onProjectChange={changeComposerProject}
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
        <div hidden={view === 'plain'} className="workspace-connections">
          <WorkspaceAccountPanel
            visible={view === 'connections'}
            accountApi={accountApi}
            onAccountVerified={verified}
            onBeforeLogout={() => controller.disconnectSource('remote')}
            activeTarget={state.scope?.source === 'remote' ? state.scope.target : undefined}
            beforeMove={() => controller.flushDraft()}
            endView={async () => {
              await controller.disconnectSource('remote');
              await controller.refreshCatalog('remote');
            }}
            onBack={() => setView('plain')}
            openSettings={openSettings ? () => run(openSettings) : undefined}
            extras={accountExtras}
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
      account: AccountApi;
      context(): Promise<unknown>;
      addProject(): Promise<unknown>;
      onChange(listener: () => void): () => void;
      onSync(listener: (notice: unknown) => void): () => void;
    };
    moorDesktop?: { openSettings?: () => Promise<unknown> };
  };
  if (bridges.moorWorkspace?.version !== 1) throw Error('桌面工作区接口不可用。');
  const container = document.getElementById('app');
  if (!container) throw Error('桌面页面容器不可用。');
  const controller = new WorkspaceController({
    request: (value) => bridges.moorWorkspace!.request(value),
  });
  const root = createRoot(container);
  root.render(
    <WorkspaceApp
      controller={controller}
      accountApi={(value) => bridges.moorWorkspace!.account(value)}
      openSettings={bridges.moorDesktop?.openSettings}
      addLocalProject={bridges.moorWorkspace.addProject}
      readDesktopContext={bridges.moorWorkspace.context}
      subscribeDesktopChanges={bridges.moorWorkspace.onChange}
      subscribeSessionChanges={bridges.moorWorkspace.onSync}
    />,
  );
  window.addEventListener(
    'pagehide',
    () => {
      root.unmount();
      void controller.flushDraft().finally(() => controller.close());
    },
    { once: true },
  );
}
