import { Popover } from '@base-ui/react/popover';
import { WorkspaceGraph, type WorkspaceClientState } from '@moor/client/features/workspace/compose';
import { sessionPendingOperations } from '@moor/client/operations/workspace/compose';
import { AGENT_RUN_DEFAULTS_FEATURE } from '@moor/protocol/agent-controls';
import { SESSION_FORK_FEATURE } from '@moor/protocol/fork-protocol';
import { PROJECT_DIFF_FEATURE } from '@moor/protocol/project-content-protocol';
import { changeRunSelection } from '@moor/protocol/run-config';
import {
  ArrowUp,
  ChevronDown,
  CircleUserRound,
  Compass,
  Folder,
  FolderOpen,
  GitBranch,
  GitCompareArrows,
  GitFork,
  ListChecks,
  Monitor,
  PanelLeft,
  Paperclip,
  Plus,
  RefreshCw,
  ScanLine,
  Search,
  Settings,
  Square,
  SquarePen,
  X,
} from 'lucide-react';
import type { ComponentProps } from 'react';
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { AppearanceSettings } from '../components/appearance';
import { UsagePanel, latestContextUsage } from '../components/usage-panel';
import { bindWorkspaceAttachmentViewPort } from '../features/attachments/workspace-attachment-view';
import {
  WorkspaceAttentionUI,
  bindWorkspaceAttentionUiPort,
} from '../features/attention/workspace-attention-ui';
import { WorkspaceAccountPanel } from '../features/auth/workspace-account';
import { useContentDockLayout } from '../features/files/workspace-content-layout';
import {
  WorkspaceContentUI,
  bindWorkspaceContentUiPort,
  type WorkspaceContentHandle,
} from '../features/files/workspace-content-ui';
import { bindWorkspaceForkUiPort } from '../features/fork/workspace-fork-ui';
import { bindWorkspaceGitUiPort } from '../features/git/workspace-git-ui';
import {
  WorkspaceGithubUI,
  bindWorkspaceGithubUiPort,
} from '../features/github/workspace-github-ui';
import { bindWorkspaceInteractionUiPort } from '../features/interactions/workspace-interaction-ui';
import { sessionPerformanceCommitted } from '../features/performance/performance-signals';
import { ComposerInput } from '../features/sessions/composer-input';
import {
  SessionInformation,
  SessionTimeline,
  hasTurnFileChanges,
  turnFileChanges,
  type TimelineTurn,
} from '../features/sessions/session-timeline';
import {
  NavigationProjectGroup,
  NavigationSessions,
  bindWorkspaceNavigationPort,
  logicalProjectGroups,
  navigationProjects,
  navigationSessionQuery,
  projectKey,
  useNavigationSessions,
  workspaceKey,
  type NavigationProject,
} from '../features/sessions/workspace-navigation';
import { bindWorkspaceNavigationPagesPort } from '../features/sessions/workspace-navigation-pages';
import { bindWorkspaceSkillsUiPort } from '../features/skills/workspace-skills-ui';
import {
  SidebarSizer,
  WorkspaceToolMenu,
  useWorkspaceLayout,
} from '../features/workspace/workspace-layout';
import {
  WorkspaceSessionTools,
  bindWorkspaceSessionToolsPort,
} from '../features/workspace/workspace-session-tools';
import type { Account, AccountApi } from '../platform/account';
import { UiPortsProvider, type UiPorts } from '../platform/ui-ports';
import { bindWorkspacePort, type WorkspacePort } from './workspace-port';
const WorkspaceConversationHistoryPortSelection = {
  attachments: ['readAttachment'],
  sessions: ['respondPermission'],
} as const;
type WorkspaceConversationHistoryPort = WorkspacePort<
  typeof WorkspaceConversationHistoryPortSelection
>;
const bindWorkspaceConversationHistoryPort = (graph: WorkspaceConversationHistoryPort) =>
  bindWorkspacePort(graph, WorkspaceConversationHistoryPortSelection);

const WorkspaceConversationPortSelection = {
  view: ['contextRevision', 'identity', 'state'],
  git: ['openGit', 'readGitContext'],
  drafts: ['queueDraft', 'reloadDraft'],
  metadata: ['metadata'],
  files: ['openProjectContent', 'openSearch'],
  sessions: [
    'createSession',
    'openSession',
    'readUsage',
    'refreshAgentOptions',
    'refreshSession',
    'respondPermission',
    'saveApprovalDefault',
    'saveRunDefaults',
    'send',
    'stop',
  ],
  fork: ['openFork'],
  github: ['openGithub'],
  attachments: ['addAttachments', 'readAttachment', 'removeAttachment', 'uploadAttachment'],
  operations: ['abandon', 'inspect', 'recoverRetiredTask', 'retry'],
  interactions: [
    'answerQuestion',
    'dismissInteraction',
    'retryInteraction',
    'saveQuestionDraft',
    'saveSteerDraft',
    'steer',
    'steerDraft',
  ],
  skills: ['openSkills'],
} as const;
type WorkspaceConversationPort = WorkspacePort<typeof WorkspaceConversationPortSelection>;
const bindWorkspaceConversationPort = (graph: WorkspaceConversationPort) =>
  bindWorkspacePort(graph, WorkspaceConversationPortSelection);

import {
  attachmentInputReason,
  attachmentPreviewUrl,
  attachmentText,
  formatAttachmentSize,
} from '@moor/client/features/attachments/attachments';
import { workspaceInteractionSnapshot } from '@moor/client/features/interactions/workspace-interactions';
import { ATTACHMENTS_FEATURE } from '@moor/protocol/attachment-protocol';
import { productCanonicalJson as canonical } from '@moor/protocol/canonical-json';
import { attachmentReferenceSchema } from '@moor/protocol/content-protocol';
import { QUESTION_LIMITS, STEER_FEATURE } from '@moor/protocol/interaction-protocol';
import { resolveRunSelection, type RunSelection } from '@moor/protocol/run-config';
import {
  addProjectResultSchema,
  workspaceContextSchema,
} from '@moor/protocol/workspace-client-protocol';
import {
  sessionPermissionReviews,
  type SessionPermissionReview,
} from '@moor/session/session-operations';
import type { z } from 'zod';
import { markdown } from '../components/content';
import { RunControls } from '../components/ui';
import { WorkspaceAttachmentView } from '../features/attachments/workspace-attachment-view';
import { WorkspaceForkUI, type WorkspaceForkHandle } from '../features/fork/workspace-fork-ui';
import { WorkspaceGitUI } from '../features/git/workspace-git-ui';
import { WorkspaceInteractionUI } from '../features/interactions/workspace-interaction-ui';
import { WorkspaceSkillsUI } from '../features/skills/workspace-skills-ui';

type Run = (action: () => Promise<unknown>) => boolean;
const message = (error: unknown) =>
  error instanceof Error ? error.message : '操作尚未确认，请重新核对。';
function readable(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

const WorkspaceItemDetails = memo(function WorkspaceItemDetails({
  entry,
}: {
  entry: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
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
      {open && <pre>{readable(entry)}</pre>}
    </details>
  );
});

// Authorization is still derived from the current scoped snapshot. Only the
// unchanged, already-reviewed display string can skip JSON parsing/formatting.
const PermissionContents = memo(function PermissionContents({ itemJson }: { itemJson: string }) {
  return <pre>{readable(JSON.parse(itemJson))}</pre>;
});

const WorkspaceConversationHistory = memo(function WorkspaceConversationHistory({
  history,
  scope,
  sessionId,
  controller,
  busy,
  live,
  confirmed,
  run,
  reviews,
  focusTurnId,
  canReadChanges,
  canFork,
  contentPanel,
  forkPanel,
}: {
  history: NonNullable<WorkspaceClientState['session']>['history'];
  scope: NonNullable<WorkspaceClientState['scope']>;
  sessionId: string;
  controller: WorkspaceConversationHistoryPort;
  busy: boolean;
  live: boolean;
  confirmed: boolean;
  run: Run;
  reviews: SessionPermissionReview[];
  focusTurnId?: string;
  canReadChanges: boolean;
  canFork: boolean;
  contentPanel: RefObject<WorkspaceContentHandle | null>;
  forkPanel: RefObject<WorkspaceForkHandle | null>;
}) {
  const renderItem = useCallback(
    (item: unknown, index: number) => {
      if (!item || typeof item !== 'object') return null;
      const entry = item as Record<string, unknown>;
      if (entry.type === 'attachment') {
        const reference = attachmentReferenceSchema.safeParse(entry.attachment);
        if (reference.success)
          return (
            <WorkspaceAttachmentView
              key={index}
              controller={bindWorkspaceAttachmentViewPort(controller)}
              scope={scope}
              sessionId={sessionId}
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
      return <WorkspaceItemDetails key={index} entry={entry} />;
    },
    [controller, scope, sessionId, busy, run],
  );
  const afterTurn = useCallback(
    (turn: TimelineTurn) =>
      reviews
        .filter((review) => review.assistantTurnId === turn.id)
        .map((review) => (
          <section className="workspace-permission" key={review.requestId} aria-label="待审批操作">
            <strong>需要你的确认</strong>
            <PermissionContents itemJson={review.itemJson} />
            {review.options.map((option) => (
              <button
                key={option.optionId}
                disabled={busy || !live}
                onClick={() =>
                  run(() =>
                    controller.sessions.respondPermission(review, {
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
              disabled={busy || !live}
              onClick={() =>
                run(() => controller.sessions.respondPermission(review, { outcome: 'cancelled' }))
              }
            >
              取消操作
            </button>
          </section>
        )),
    [reviews, busy, live, run, controller],
  );
  const actions = useCallback(
    (turn: TimelineTurn) => (
      <>
        {hasTurnFileChanges(turn) && canReadChanges && (
          <button
            type="button"
            disabled={busy}
            onClick={() => contentPanel.current?.open('changes', turn.id)}
          >
            查看回合文件变更 · {turnFileChanges(turn)!.changeCount}
          </button>
        )}
        {turn.finished && canFork && (
          <button
            type="button"
            className="session-fork-action"
            aria-label="从此回合创建副本"
            title="从此回合创建副本"
            disabled={busy || !live}
            onClick={() => forkPanel.current?.open(turn.id)}
          >
            <GitFork size={15} />
          </button>
        )}
      </>
    ),
    [canReadChanges, canFork, busy, live, contentPanel, forkPanel],
  );
  return (
    <SessionTimeline
      history={history}
      live={live}
      confirmed={confirmed}
      focusTurnId={focusTurnId}
      renderItem={renderItem}
      afterTurn={reviews.length ? afterTurn : undefined}
      actions={actions}
    />
  );
});

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
  controller: WorkspaceConversationPort;
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
  const [submissionNotice, setSubmissionNotice] = useState<{
    message: string;
    warning: boolean;
  }>();
  const latestComposer = useRef({ text, selection });
  latestComposer.current = { text, selection };
  const contentPanel = useRef<WorkspaceContentHandle>(null),
    forkPanel = useRef<WorkspaceForkHandle>(null),
    gitPanel = useRef<{ open(): boolean }>(null),
    skillsPanel = useRef<{ open(): boolean }>(null);
  const [branch, setBranch] = useState<string>();
  const [dockContainer, setDockContainer] = useState<HTMLDivElement | null>(null);
  const [contentDocked, setContentDocked] = useState(false);
  const contentLayout = useContentDockLayout(contentDocked);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    sessionPerformanceCommitted(
      controller.view.identity,
      state.sessionId,
      state.session?.version,
      composerInput.current,
    );
  }, [controller, state.sessionId, state.session?.version]);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const readBranch = useCallback(() => {
    let active = true;
    if (!state.sessionId || state.offline || state.sessionLoad.status !== 'ready') {
      setBranch(undefined);
      return () => {};
    }
    void controller.git
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
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (!draftDirty.current && !saveError) {
      setText(state.draft?.text ?? '');
      setSelection(state.draft?.selection ?? {});
    }
  }, [state.draft?.revision, saveError]);
  const save = (nextText: string, nextSelection: RunSelection) => {
    latestComposer.current = { text: nextText, selection: nextSelection };
    setText(nextText);
    setSelection(nextSelection);
    setSaveError('');
    setSubmissionNotice(undefined);
    draftDirty.current = true;
    const version = ++draftVersion.current;
    controller.drafts.queueDraft(
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
  const reviews = useMemo(
    () =>
      session && state.scope && state.sessionId
        ? sessionPermissionReviews(session, { ...state.scope.target, sessionId: state.sessionId })
        : [],
    [session, state.scope, state.sessionId],
  );
  const activeTurns = useMemo(
    () => session?.history.filter((turn) => turn.role === 'assistant' && !turn.finished) ?? [],
    [session?.history],
  );
  const interactions = useMemo(() => workspaceInteractionSnapshot(state), [session?.history]);
  const contextUsage = useMemo(
    () => (session ? latestContextUsage(session.history) : undefined),
    [session?.history],
  );
  const changeCount = useMemo(
    () =>
      session?.history.reduce(
        (count, turn) =>
          count + (hasTurnFileChanges(turn) ? turnFileChanges(turn)!.changeCount : 0),
        0,
      ) ?? 0,
    [session?.history],
  );
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
          {(state.sessionLoad.status !== 'loading-cache' ||
            state.sessionLoad.showIndicator !== false) && (
            <img className="moor-logo" src="/moor-logo.png" alt="Moor" width={96} height={32} />
          )}
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
  const contextPercent =
    contextUsage && contextUsage.size > 0
      ? Math.min(100, Math.max(0, (contextUsage.used / contextUsage.size) * 100))
      : undefined;
  const sessionRefreshing = ['loading-cache', 'refreshing'].includes(state.sessionLoad.status);
  const sessionWritable =
    state.sessionLoad.status === 'ready' &&
    !state.offline &&
    session.persisted !== false &&
    !session.persistenceError &&
    !session.meta.isArchived;
  const attachmentReason = attachments.length
    ? !attachmentSupported
      ? '此执行电脑尚未提供附件能力，请更新主机。'
      : attachments.some((item) => item.pending)
        ? '附件结果待确认，请先核查或重试原操作。'
        : attachments
            .map((item) => attachmentInputReason(item.reference, session.agent?.inputCapabilities))
            .find(Boolean)
    : undefined;
  const uploadCount = attachments.filter((item) => !item.uploaded).length;
  const sendProgress =
    state.sendProgress?.sessionId === state.sessionId ? state.sendProgress : undefined;
  const savedInteraction = state.ledger?.interactions?.[state.sessionId]?.value;
  const steerSupported =
    !!interactions.activeId &&
    state.project?.runtime.features?.includes(STEER_FEATURE) &&
    interactions.capabilities?.steer === true;
  const steerReason = !steerSupported
    ? `${interactions.capabilities?.steerUnavailableReason || '当前 Agent 不支持运行中追加'}；草稿保留，任务结束后手动发送`
    : attachments.length
      ? '运行中追加仅支持文字；附件可保留，任务结束后发送'
      : text.length > QUESTION_LIMITS.text
        ? `追加内容最多 ${QUESTION_LIMITS.text} 个字符`
        : savedInteraction?.steerDraft
          ? '请先处理“回合内追加”面板中保存的草稿'
          : pending.length || savedInteraction?.pending || retiredTask
            ? '上一条操作等待确认'
            : '';
  const canSteer = !busy && !saveError && sessionWritable && !!text.trim() && !steerReason;
  const canSend =
    !busy &&
    !saveError &&
    !state.modelError &&
    !validation &&
    (text.trim() || attachments.length) &&
    !attachmentReason &&
    sessionWritable &&
    !pending.length &&
    !retiredTask &&
    !activeTurns.length &&
    !savedInteraction?.pending;
  const activityLabel = state.offline
    ? '离线'
    : sessionRefreshing
      ? '同步中'
      : !sessionWritable
        ? '待同步'
        : reviews.length
          ? '等待确认'
          : activeTurns.length
            ? '正在执行'
            : '';
  const composerStatus = saveError
    ? '草稿保存失败'
    : sendProgress
      ? sendProgress.stage === 'uploading'
        ? `正在上传附件 ${sendProgress.uploaded ?? 0}/${sendProgress.total ?? uploadCount}，后续编辑会保留`
        : sendProgress.stage === 'sending'
          ? '正在发送，后续编辑会保留'
          : '正在准备发送'
      : state.offline
        ? '离线草稿 · 连接后手动发送'
        : sessionRefreshing
          ? '正在同步会话'
          : !sessionWritable
            ? '会话尚未就绪'
            : pending.length || savedInteraction?.pending || retiredTask
              ? '上一条操作等待确认'
              : reviews.length
                ? '确认操作后继续'
                : submissionNotice && !submissionNotice.warning
                  ? submissionNotice.message
                  : activeTurns.length
                    ? steerReason || '追加到当前任务；模型与权限选择用于下一回合'
                    : attachmentReason || (uploadCount ? `发送时将上传 ${uploadCount} 个附件` : '');
  return (
    <div
      className="workspace-session-layout"
      ref={contentLayout.ref}
      style={contentLayout.style}
      data-content-open={contentDocked}
      data-review-expanded={contentLayout.expanded}
    >
      <div className="workspace-conversation-main">
        <header className="workspace-session-header">
          <div className="workspace-session-heading">
            <h1 title={session.meta.title || '新对话'}>{session.meta.title || '新对话'}</h1>
            <p>
              <span title={state.project?.projectName}>{state.project?.projectName}</span>
              <span aria-hidden="true">/</span>
              <span>{session.agent?.name || session.meta.agentType}</span>
              {activityLabel && (
                <span
                  className="workspace-activity"
                  data-working={sessionWritable && !!activeTurns.length}
                >
                  {activityLabel}
                </span>
              )}
            </p>
          </div>
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
            {!!session.history.length && (
              <>
                <button
                  type="button"
                  className="workspace-header-action"
                  aria-label="项目文件"
                  title="项目文件"
                  disabled={busy}
                  onClick={() => contentPanel.current?.open('tree')}
                >
                  <FolderOpen size={16} />
                  <span>文件</span>
                </button>
                {changeCount > 0 &&
                  state.project?.runtime.features?.includes(PROJECT_DIFF_FEATURE) && (
                    <button
                      type="button"
                      className="workspace-header-action"
                      aria-label="查看文件变更"
                      title="按回合查看已记录的文件变更"
                      disabled={busy}
                      onClick={() => contentPanel.current?.open('changes')}
                    >
                      <GitCompareArrows size={16} />
                      <span>变更</span>
                      <small>{changeCount}</small>
                    </button>
                  )}
              </>
            )}
            <WorkspaceToolMenu>
              <WorkspaceSessionTools
                controller={bindWorkspaceSessionToolsPort(controller)}
                state={state}
                busy={busy}
                run={run}
                navigate={navigate}
              />
              <WorkspaceForkUI
                controller={bindWorkspaceForkUiPort(controller)}
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
                onClick={() => navigate(() => controller.sessions.refreshSession())}
                aria-label="刷新会话"
              >
                <RefreshCw size={16} />
                <span>刷新会话</span>
              </button>
            </WorkspaceToolMenu>
            <WorkspaceToolMenu kind="environment" hidden={!session.history.length}>
              <div className="workspace-environment-location">
                <Monitor size={16} />
                <span>{state.project?.hostName}</span>
                <small>{sessionRefreshing ? '同步中' : state.offline ? '离线' : '已连接'}</small>
              </div>
              <WorkspaceGitUI
                controller={bindWorkspaceGitUiPort(controller)}
                state={state}
                busy={busy}
                run={run}
                controlRef={gitPanel}
                onChanged={readBranch}
              />
              <WorkspaceGithubUI
                controller={bindWorkspaceGithubUiPort(controller)}
                state={state}
                busy={busy || !sessionWritable}
                run={run}
              />
            </WorkspaceToolMenu>
          </div>
        </header>
        <WorkspaceContentUI
          controller={bindWorkspaceContentUiPort(controller)}
          busy={busy}
          run={run}
          controlRef={contentPanel}
          dockContainer={dockContainer}
          onVisibilityChange={setContentDocked}
          quoteFocus={composerInput}
          onQuote={(quote) => {
            const latest = latestComposer.current;
            save(latest.text + (latest.text ? '\n\n' : '') + quote, latest.selection);
            requestAnimationFrame(() => {
              if (!active.current) return;
              // Dialog finalFocus handles modal teardown; a dock has no focus trap.
              if (contentDocked) composerInput.current?.focus();
              const length = composerInput.current?.value.length ?? 0;
              composerInput.current?.setSelectionRange(length, length);
              if (composerInput.current)
                composerInput.current.scrollTop = composerInput.current.scrollHeight;
            });
          }}
          expanded={contentLayout.expanded}
          onToggleExpanded={contentLayout.toggleExpanded}
          hideTriggers
        />
        {!session.history.length && (
          <div className="workspace-welcome">
            <h2>今天想完成什么？</h2>
            <p>从一个问题、一个想法，或一处待改进的代码开始。</p>
            <div className="workspace-welcome-suggestions">
              {[
                {
                  label: '了解项目',
                  icon: Compass,
                  prompt: '帮我梳理这个项目的结构、主要模块和运行方式。',
                },
                {
                  label: '规划任务',
                  icon: ListChecks,
                  prompt: '我想实现一个功能，请先帮我分析现有代码并制定计划：',
                },
                {
                  label: '检查改动',
                  icon: ScanLine,
                  prompt: '请审查当前项目的未提交改动，重点检查潜在问题和遗漏的验证。',
                },
              ].map(({ label, icon: Icon, prompt }) => (
                <button
                  key={label}
                  type="button"
                  disabled={!!text.trim() || !!saveError || busy}
                  onClick={() => {
                    save(prompt, selection);
                    composerInput.current?.focus();
                  }}
                >
                  <Icon size={16} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
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
                navigate(() =>
                  controller.sessions.openSession(session.meta.forkOrigin!.sourceSessionId),
                )
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
        {sessionWritable && state.sessionCache?.status === 'failed' && (
          <p className="workspace-status" role="status">
            会话已由主机确认，本机离线缓存未保存。
          </p>
        )}
        <WorkspaceConversationHistory
          history={session.history}
          scope={state.scope}
          sessionId={state.sessionId}
          controller={bindWorkspaceConversationHistoryPort(controller)}
          busy={busy}
          live={sessionWritable}
          confirmed={session.persisted !== false && !session.persistenceError}
          run={run}
          reviews={reviews}
          focusTurnId={state.focusedTurnId ?? state.searchFocus?.turnId}
          canReadChanges={!!state.project?.runtime.features?.includes(PROJECT_DIFF_FEATURE)}
          canFork={!!state.project?.runtime.features?.includes(SESSION_FORK_FEATURE)}
          contentPanel={contentPanel}
          forkPanel={forkPanel}
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
                  onClick={() =>
                    run(() => controller.operations.inspect(entry.original.value.operationId))
                  }
                >
                  核查结果
                </button>
                <button
                  disabled={busy || !sessionWritable}
                  onClick={() =>
                    run(() => controller.operations.retry(entry.original.value.operationId))
                  }
                >
                  重试原操作
                </button>
                <button
                  disabled={busy || !sessionWritable}
                  onClick={() =>
                    run(() => controller.operations.abandon(entry.original.value.operationId))
                  }
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
              onClick={() =>
                run(() => controller.operations.recoverRetiredTask(retiredTask, 'inspect'))
              }
            >
              核查旧版操作
            </button>
            <button
              disabled={busy || !sessionWritable}
              onClick={() =>
                run(() => controller.operations.recoverRetiredTask(retiredTask, 'retry'))
              }
            >
              重试旧版原操作
            </button>
          </details>
        )}
        <WorkspaceInteractionUI
          controller={bindWorkspaceInteractionUiPort(controller)}
          state={state}
          busy={busy}
          run={run}
          onDirty={onDirty}
          snapshot={interactions}
        />
        <form
          className="workspace-composer workspace-composer-compact"
          data-empty={!session.history.length}
          onSubmit={(event) => {
            event.preventDefault();
            if (interactions.activeId) {
              if (canSteer) {
                const turnId = interactions.activeId;
                const prompt = text;
                const contextRevision = controller.view.contextRevision;
                run(async () => {
                  const result = await controller.interactions.steerDraft(turnId, prompt);
                  if (active.current && controller.view.contextRevision === contextRevision)
                    setSubmissionNotice({
                      message: result.warning ?? '已追加到当前任务',
                      warning: !!result.warning,
                    });
                });
              }
            } else if (canSend) run(() => controller.sessions.send());
          }}
        >
          <div className="workspace-composer-context" aria-label="执行上下文">
            <Popover.Root open={environmentOpen} onOpenChange={setEnvironmentOpen}>
              <Popover.Trigger
                className="workspace-environment-trigger"
                aria-label="执行环境"
                title={`${state.project?.projectName ?? '项目'} · ${state.project?.hostName ?? '执行电脑'} · ${branch ?? '工作目录'}`}
              >
                <Folder size={14} />
                <span className="workspace-environment-project">
                  {state.project?.projectName ?? '项目'}
                </span>
                <span className="workspace-environment-divider" aria-hidden="true">
                  /
                </span>
                <span className="workspace-environment-branch">{branch ?? '工作目录'}</span>
                <ChevronDown size={12} />
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Positioner
                  side="top"
                  align="start"
                  sideOffset={8}
                  className="popup-positioner"
                >
                  <Popover.Popup className="menu-popup workspace-environment-popup">
                    <Popover.Title>执行环境</Popover.Title>
                    <label>
                      <span>
                        <Folder size={14} />
                        项目
                      </span>
                      <select
                        aria-label="选择项目"
                        value={
                          state.project && state.scope
                            ? projectKey({ ...state.project, source: state.scope.source })
                            : ''
                        }
                        disabled={busy || !!saveError}
                        onChange={(event) => {
                          const project = projects.find(
                            (entry) => projectKey(entry) === event.target.value,
                          );
                          if (project) {
                            setEnvironmentOpen(false);
                            onProjectChange(project);
                          }
                        }}
                      >
                        {projects.map((entry) => (
                          <option key={projectKey(entry)} value={projectKey(entry)}>
                            {entry.projectName} · {entry.hostName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>
                        <Monitor size={14} />
                        执行电脑
                      </span>
                      <select
                        aria-label="执行电脑"
                        value={
                          state.project && state.scope
                            ? projectKey({ ...state.project, source: state.scope.source })
                            : ''
                        }
                        disabled={busy || !!saveError}
                        onChange={(event) => {
                          const project = projects.find(
                            (entry) => projectKey(entry) === event.target.value,
                          );
                          if (project) {
                            setEnvironmentOpen(false);
                            onProjectChange(project);
                          }
                        }}
                      >
                        {projects
                          .filter(
                            (entry) =>
                              entry.target.catalogProjectId ===
                                state.scope?.target.catalogProjectId &&
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
                    </label>
                    <button
                      type="button"
                      disabled={busy || !sessionWritable}
                      onClick={() => {
                        setEnvironmentOpen(false);
                        gitPanel.current?.open();
                      }}
                      aria-label="选择 Git 分支与工作目录"
                    >
                      <GitBranch size={14} />
                      <span>{branch ?? '工作目录'}</span>
                      <ChevronDown size={12} />
                    </button>
                    <p>切换项目或电脑将打开对应项目。</p>
                    <small>
                      {state.project?.hostName} ·{' '}
                      {sessionRefreshing ? '同步中' : state.offline ? '离线' : '已连接'}
                    </small>
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>
            {(state.offline || sessionRefreshing || state.scope.source === 'remote') && (
              <span className="workspace-environment-status" title={state.project?.hostName}>
                {state.scope.source === 'remote' && state.project?.hostName}
                {state.scope.source === 'remote' && (state.offline || sessionRefreshing)
                  ? ' · '
                  : ''}
                {state.offline ? '主机离线' : sessionRefreshing ? '同步中' : ''}
              </span>
            )}
          </div>
          <div className="workspace-input-box">
            <ComposerInput
              ref={composerInput}
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
                  run(() => controller.attachments.addAttachments(files));
                }
              }}
            />
            <div className="workspace-attachments">
              {!!attachments.length && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => controller.drafts.reloadDraft())}
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
                  <details className="workspace-attachment-chip" key={item.reference.attachmentId}>
                    <summary>
                      <Paperclip size={13} />
                      <span title={item.reference.name}>{item.reference.name}</span>
                      <small>
                        {reason
                          ? '不可发送'
                          : item.pending
                            ? '待确认'
                            : item.uploaded
                              ? '已上传'
                              : '待上传'}
                      </small>
                    </summary>
                    <div className="workspace-attachment-preview">
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
                          onClick={() =>
                            run(() =>
                              controller.operations.retry(item.pending!.request.operationId),
                            )
                          }
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
                                run(() =>
                                  controller.attachments.uploadAttachment(
                                    item.reference.attachmentId,
                                  ),
                                )
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
                              run(() =>
                                controller.attachments.removeAttachment(
                                  item.reference.attachmentId,
                                ),
                              )
                            }
                          >
                            移除附件
                          </button>
                        </>
                      )}
                    </div>
                  </details>
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
                      await controller.drafts.reloadDraft();
                      setText(controller.view.state.draft?.text ?? '');
                      setSelection(controller.view.state.draft?.selection ?? {});
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
                      if (files.length) run(() => controller.attachments.addAttachments(files));
                    }}
                  />
                </label>
                <WorkspaceSkillsUI
                  controller={bindWorkspaceSkillsUiPort(controller)}
                  state={state}
                  busy={busy || !sessionWritable}
                  run={run}
                  controlRef={skillsPanel}
                />
                <div className="workspace-composer-extras">
                  <UsagePanel
                    context={contextUsage}
                    usage={session.accountUsage}
                    loading={state.usageLoading}
                    onRead={() => {
                      if (sessionWritable) void controller.sessions.readUsage().catch(() => {});
                    }}
                    triggerLabel="上下文与账号额度"
                  />
                </div>
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
                compact
                onChange={(key, value) => {
                  const next = changeRunSelection(selection, key, value, session.agent?.runConfig);
                  if (key === 'modeId')
                    run(async () => {
                      await controller.sessions.saveApprovalDefault(value);
                      const latest = latestComposer.current;
                      save(latest.text, { ...latest.selection, modeId: value });
                    });
                  else save(text, next);
                }}
                onRefresh={() => run(() => controller.sessions.refreshAgentOptions())}
                onSaveDefaults={
                  state.project?.runtime.features?.includes(AGENT_RUN_DEFAULTS_FEATURE)
                    ? (defaults) => controller.sessions.saveRunDefaults(defaults)
                    : undefined
                }
              />
              <div className="workspace-compose-primary">
                {activeTurns.length === 1 && (
                  <button
                    type="button"
                    className="workspace-compose-submit"
                    title="停止当前执行"
                    disabled={busy || !sessionWritable}
                    onClick={() => run(() => controller.sessions.stop(activeTurns[0]!.id))}
                  >
                    <Square size={14} fill="currentColor" />
                    <span className="sr-only">停止</span>
                  </button>
                )}
                {steerSupported && (
                  <button
                    type="submit"
                    className="workspace-compose-steer"
                    title={steerReason || '追加到当前任务（⌘ / Ctrl + Enter）'}
                    disabled={!canSteer}
                  >
                    追加
                  </button>
                )}
                {!activeTurns.length && (
                  <button
                    type="submit"
                    className="workspace-compose-submit"
                    title="发送（⌘ / Ctrl + Enter）"
                    disabled={!canSend}
                  >
                    {sendProgress ? (
                      <RefreshCw className="spin" size={18} aria-hidden="true" />
                    ) : (
                      <ArrowUp size={18} />
                    )}
                    <span className="sr-only">发送</span>
                  </button>
                )}
              </div>
            </div>
          </div>
          {(composerStatus ||
            submissionNotice?.warning ||
            (contextPercent !== undefined && contextPercent >= 85)) && (
            <div className="workspace-composer-status" role="status">
              {composerStatus && <span>{composerStatus}</span>}
              {submissionNotice?.warning && <span>{submissionNotice.message}</span>}
              {contextPercent !== undefined && contextPercent >= 85 && (
                <span>上下文已使用 {Math.round(contextPercent)}%</span>
              )}
            </div>
          )}
        </form>
      </div>
      {contentDocked && contentLayout.sizer}
      <div className="workspace-content-dock" ref={setDockContainer} hidden={!contentDocked} />
    </div>
  );
}

function WorkspaceView({
  controller,
  accountApi,
  onAccountVerified,
  openSettings,
  addLocalProject,
  readRuntimeContext,
  subscribeRuntimeChanges,
  subscribeSessionChanges,
  localAvailable,
  accountExtras,
}: {
  controller: WorkspaceGraph;
  accountApi: AccountApi;
  onAccountVerified?: (account: Account | null) => void;
  openSettings?: () => Promise<unknown>;
  addLocalProject?: () => Promise<unknown>;
  readRuntimeContext?: () => Promise<unknown>;
  subscribeRuntimeChanges?: (listener: () => void) => () => void;
  subscribeSessionChanges?: (listener: (notice: unknown) => void) => () => void;
  localAvailable: boolean;
  accountExtras?: ReactNode;
}) {
  const [state, setState] = useState(() => controller.view.state);
  const [view, setView] = useState<'plain' | 'connections'>('plain');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [plainDirty, setPlainDirty] = useState(false);
  const [agentId, setAgentId] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false),
    [workspace, setWorkspace] = useState(''),
    [logicalProject, setLogicalProject] = useState(''),
    [searchOpen, setSearchOpen] = useState(false),
    [account, setAccount] = useState<Account | null>(null);
  const allProjects = navigationProjects(state);
  const workspaces = [
    ...new Map(allProjects.map((entry) => [workspaceKey(entry), entry.workspaceName])).entries(),
  ];
  const activeWorkspace = workspaces.some(([key]) => key === workspace) ? workspace : '';
  const workspaceProjects = allProjects.filter(
    (entry) => !activeWorkspace || workspaceKey(entry) === activeWorkspace,
  );
  const projectGroups = logicalProjectGroups(workspaceProjects);
  const selectedGroup = projectGroups.find((group) => group.key === logicalProject);
  const projects = selectedGroup?.projects ?? workspaceProjects;
  const shownGroups = selectedGroup ? [selectedGroup] : projectGroups;
  const pairingProject = activeWorkspace
    ? workspaceProjects.find((project) => project.source === 'remote')
    : state.scope?.source === 'remote'
      ? { source: state.scope.source, target: state.scope.target }
      : undefined;
  const layout = useWorkspaceLayout();
  const navigationOpen = layout.open,
    setNavigationOpen = layout.setOpen;
  const [sessionQuery, setSessionQuery] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (searchOpen && navigationOpen) searchInput.current?.focus();
  }, [searchOpen, navigationOpen]);
  const [pinnedShown, setPinnedShown] = useState(30),
    [recentShown, setRecentShown] = useState(30);
  const navigation = useNavigationSessions(
    bindWorkspaceNavigationPagesPort(controller),
    state,
    projects,
    sessionQuery,
  );
  useEffect(() => {
    const refresh = () => {
      void controller.catalog.refreshCatalog('remote').catch(() => {});
    };
    window.addEventListener('moor:catalog-changed', refresh);
    return () => window.removeEventListener('moor:catalog-changed', refresh);
  }, [controller]);
  useEffect(() => {
    setPinnedShown(30);
    setRecentShown(30);
  }, [activeWorkspace, selectedGroup?.key, sessionQuery]);
  const rootElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.altKey ||
        !(event.metaKey || event.ctrlKey)
      )
        return;
      const inDialog =
        event.target instanceof Element ? event.target.closest('[role="dialog"]') : null;
      if (inDialog && inDialog.id !== 'workspace-navigation') return;
      if (event.key.toLowerCase() === 'k' && !event.shiftKey) {
        event.preventDefault();
        setNavigationOpen(true);
        setSearchOpen(true);
        searchInput.current?.focus();
        searchInput.current?.select();
      } else if (event.key.toLowerCase() === 'b' && !event.shiftKey) {
        event.preventDefault();
        setNavigationOpen((open) => !open);
      } else if (event.key.toLowerCase() === 'o' && event.shiftKey) {
        event.preventDefault();
        rootElement.current
          ?.querySelector<HTMLFormElement>('.workspace-new-conversation')
          ?.requestSubmit();
      }
    };
    document.addEventListener('keydown', shortcuts);
    return () => document.removeEventListener('keydown', shortcuts);
  }, [setNavigationOpen]);

  useEffect(() => {
    if (!layout.narrow || !navigationOpen) return;
    const root = rootElement.current,
      body = root?.querySelector<HTMLElement>('.workspace-body');
    if (!body) return;
    body.inert = true;
    const target =
      root?.querySelector<HTMLInputElement>('.workspace-sidebar-search input') ??
      root?.querySelector<HTMLButtonElement>('.workspace-sidebar button');
    target?.focus();
    return () => {
      body.inert = false;
      root?.querySelector<HTMLButtonElement>('.workspace-navigation-bar button')?.focus();
    };
  }, [layout.narrow, navigationOpen]);
  const hideMobileNavigation = () => {
    if (window.innerWidth <= 700) setNavigationOpen(false);
  };
  const [runtimeContext, setRuntimeContext] = useState<{
    serial: number;
    value: z.infer<typeof workspaceContextSchema>;
  } | null>(null);
  const runtimeHandled = useRef(0),
    navigationHandled = useRef(-1),
    notificationHandled = useRef('');
  const action = useRef(false),
    navigationAction = useRef(0),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = controller.view.subscribe(() => setState(controller.view.state));
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [controller]);
  useEffect(() => {
    const catchUp = () => {
      if (document.visibilityState !== 'hidden') controller.sync.scheduleSync?.();
    };
    const unsubscribe = subscribeSessionChanges?.((notice) => controller.sync.scheduleSync(notice));
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
    if (readRuntimeContext || !localAvailable) return;
    void controller.catalog.refreshCatalog('local').catch((reason: unknown) => {
      if (mounted.current) setError(message(reason));
    });
  }, [controller, readRuntimeContext, localAvailable]);
  useEffect(() => {
    if (!readRuntimeContext) return;
    let active = true,
      serial = 0;
    const refresh = () => {
      const current = ++serial;
      void readRuntimeContext()
        .then((raw) => {
          if (active && current === serial)
            setRuntimeContext({ serial: current, value: workspaceContextSchema.parse(raw) });
        })
        .catch((reason: unknown) => {
          if (active && current === serial) setError(message(reason));
        });
    };
    const unsubscribe = subscribeRuntimeChanges?.(refresh);
    refresh();
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [readRuntimeContext, subscribeRuntimeChanges]);
  const verified = useCallback(
    (account: Account | null) => {
      setAccount(account);
      onAccountVerified?.(account);
      if (account?.owner && localAvailable)
        void controller.catalog.refreshCatalog('remote').catch(() => {});
    },
    [controller, onAccountVerified, localAvailable],
  );
  const run = useCallback<Run>((task) => {
    if (action.current) return false;
    action.current = true;
    setBusy(true);
    setError('');
    void (async () => task())()
      .catch((reason: unknown) => {
        if (mounted.current) setError(message(reason));
      })
      .finally(() => {
        action.current = false;
        if (mounted.current) setBusy(false);
      });
    return true;
  }, []);
  const navigate: Run = (task) => {
    if (action.current || plainDirty) return false;
    const version = ++navigationAction.current;
    setError('');
    void (async () => task())().catch((reason: unknown) => {
      if (mounted.current && version === navigationAction.current) setError(message(reason));
    });
    return true;
  };
  const blocked = busy || plainDirty;
  useEffect(() => {
    if (!runtimeContext || blocked || runtimeHandled.current === runtimeContext.serial) return;
    runtimeHandled.current = runtimeContext.serial;
    run(async () => {
      const context = runtimeContext.value;
      if (context.revision !== navigationHandled.current) {
        navigationHandled.current = context.revision;
        if (context.view === 'remote') setView('connections');
      }
      if (!context.localReady) return;
      await controller.catalog.refreshCatalog('local');
      const notification = context.notification;
      if (!notification || notification.eventId === notificationHandled.current) return;
      notificationHandled.current = notification.eventId;
      const project = controller.view.state.catalogs.local?.targets.find(
        ({ target }) =>
          target.userId === notification.userId &&
          target.machineId === notification.machineId &&
          target.workspaceId === notification.workspaceId &&
          target.localProjectId === notification.localProjectId,
      );
      if (!project) throw Error('通知对应的本机项目尚不可用，请恢复原电脑后重新读取。');
      setView('plain');
      await controller.catalog.selectProject('local', project.target);
      await controller.sessions.openSession(notification.sessionId);
      hideMobileNavigation();
    });
  }, [runtimeContext, blocked, controller]);
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
          const result = addProjectResultSchema.parse(await addLocalProject());
          if (result.canceled || !mounted.current) return;
          await controller.catalog.refreshCatalog('local');
          const entry = controller.view.state.catalogs.local?.targets.find(
            ({ target }) =>
              target.localProjectId === result.projectId &&
              target.owner === result.identity.owner &&
              target.deviceId === result.identity.deviceId &&
              target.workspaceId === result.identity.workspaceId &&
              target.machineId === result.identity.machineId &&
              target.userId === result.identity.userId,
          );
          if (!entry) throw Error('主机已登记项目，目录尚未更新，请刷新本机项目列表。');
          await controller.catalog.selectProject('local', entry.target);
          if (!mounted.current) return;
          setView('plain');
          const initialAgent =
            entry.runtime.agents.find((agent) => agent.id === agentId) ?? entry.runtime.agents[0];
          if (initialAgent) {
            const sessionId = await controller.sessions.createSession(initialAgent.id);
            await controller.catalog.refreshSessions();
            await controller.sessions.openSession(sessionId);
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
              .includes(navigationSessionQuery(project, sessionQuery).toLowerCase()) ||
              session.id
                .toLowerCase()
                .includes(navigationSessionQuery(project, sessionQuery).toLowerCase())),
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
  const selectedAttention =
    state.session &&
    state.scope &&
    state.sessionId &&
    sessionPermissionReviews(state.session, { ...state.scope.target, sessionId: state.sessionId })
      .length
      ? ('approval' as const)
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
        await controller.catalog.selectProject(project.source, project.target);
      await controller.sessions.openSession(session.id);
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
        await controller.metadata.projectMetadata(
          project.source,
          project.target,
          session,
          action,
          title,
        );
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
      await controller.catalog.selectProject(project.source, project.target);
      const id = await controller.sessions.createSession(agent.id);
      await controller.catalog.refreshSessions();
      await controller.sessions.openSession(id);
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
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229)
          return;
        if (
          event.key === 'Escape' &&
          (!(event.target as HTMLElement).closest('[role="dialog"]') ||
            (event.target as HTMLElement).closest('#workspace-navigation'))
        ) {
          const details = (event.target as HTMLElement).closest('details[open]');
          if (details) {
            details.removeAttribute('open');
            details.querySelector('summary')?.focus();
          } else if (
            searchOpen &&
            (event.target as HTMLElement).closest('.workspace-sidebar-search')
          ) {
            if (sessionQuery) setSessionQuery('');
            else {
              setSearchOpen(false);
              searchTrigger.current?.focus();
            }
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
                  onChange={(event) => {
                    setWorkspace(event.target.value);
                    setLogicalProject('');
                  }}
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
            title="收起侧栏（⌘ / Ctrl B）"
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
                const id = await controller.sessions.createSession(selectedAgent);
                await controller.catalog.refreshSessions();
                await controller.sessions.openSession(id);
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
            <button
              type="submit"
              disabled={blocked || !selectedAgent}
              title="新对话（⌘ / Ctrl Shift O）"
              aria-keyshortcuts="Meta+Shift+O Control+Shift+O"
            >
              <SquarePen size={16} />
              新对话
            </button>
          </form>
        )}
        <div className="workspace-navigation-actions">
          {addProject && (
            <button
              className="workspace-add-project"
              disabled={blocked || (runtimeContext !== null && !runtimeContext.value.localReady)}
              onClick={addProject}
            >
              <Plus size={15} />
              添加项目
            </button>
          )}
        </div>
        <div className="workspace-sidebar-search">
          <button
            ref={searchTrigger}
            aria-label="搜索会话"
            title="搜索会话（⌘ / Ctrl K）"
            aria-keyshortcuts="Meta+K Control+K"
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen((open) => !open);
              setSessionQuery('');
            }}
          >
            <Search size={15} />
            <span>搜索</span>
            <kbd>⌘ K</kbd>
          </button>
          <div className="workspace-search-field" hidden={!searchOpen}>
            <input
              ref={searchInput}
              aria-label="筛选当前工作区会话"
              placeholder="项目、电脑或会话"
              maxLength={200}
              value={sessionQuery}
              onChange={(event) => setSessionQuery(event.target.value)}
            />
            {!!sessionQuery && (
              <button
                aria-label="清空搜索"
                onClick={() => {
                  setSessionQuery('');
                  searchInput.current?.focus();
                }}
              >
                <X size={14} />
              </button>
            )}
          </div>
          {view === 'plain' && (
            <WorkspaceAttentionUI
              controller={bindWorkspaceAttentionUiPort(controller)}
              state={state}
              busy={blocked}
              run={run}
            />
          )}
        </div>
        <nav className="workspace-projects" aria-label="电脑和项目">
          {Object.values(state.syncDisconnected ?? {}).some(Boolean) && (
            <p className="workspace-muted" role="status">
              实时连接中断，正在重连
              <button onClick={() => run(() => controller.sync.synchronize())}>重新同步</button>
            </p>
          )}
          {navigation.unavailable.length > 0 && (
            <p className="workspace-muted" role="status">
              部分电脑的会话暂不可读取
            </p>
          )}
          <NavigationSessions
            kind="pinned"
            query={sessionQuery}
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
                  await controller.catalog.refreshCatalog(source);
                navigation.refresh('pinned');
              })
            }
            selected={navigationSelected}
            selectedAttention={selectedAttention}
            disabled={blocked}
            onOpen={openNavigationSession}
            onAction={manageNavigationSession}
          />
          <section className="workspace-navigation-section" aria-label="项目">
            <div className="workspace-project-filter">
              <h2>项目</h2>
              {projectGroups.length > 1 && (
                <select
                  aria-label="筛选项目分组"
                  value={selectedGroup?.key ?? ''}
                  onChange={(event) => setLogicalProject(event.target.value)}
                >
                  <option value="">全部项目</option>
                  {projectGroups.map((group) => (
                    <option key={group.key} value={group.key}>
                      {group.name} ·{' '}
                      {[...new Set(group.projects.map((project) => project.hostName))].join('、')}
                      {!activeWorkspace && workspaces.length > 1 ? ` · ${group.workspaceName}` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {shownGroups.map((group) => (
              <Fragment key={group.key}>
                {group.projects.length > 1 && (
                  <h3 className="workspace-logical-project" title={group.name}>
                    <span>{group.name}</span>
                    <small>{group.projects.length} 个执行副本</small>
                  </h3>
                )}
                {group.projects.map((project) => (
                  <NavigationProjectGroup
                    key={projectKey(project)}
                    project={project}
                    grouped={group.projects.length > 1}
                    sessions={navigation.sessions[projectKey(project)]}
                    selected={
                      view === 'plain' &&
                      state.scope?.source === project.source &&
                      canonical(state.scope.target) === canonical(project.target)
                    }
                    selectedSession={state.sessionId}
                    disabled={blocked}
                    query={sessionQuery}
                    selectedAttention={selectedAttention}
                    controller={bindWorkspaceNavigationPort(controller)}
                    revision={
                      controller.catalog.projectRevision?.(project.source, project.target) ??
                      controller.catalog.navigationRevision ??
                      0
                    }
                    unavailable={navigation.unavailable.includes(projectKey(project))}
                    onOpen={openNavigationSession}
                    onAction={manageNavigationSession}
                    onCreate={createProjectSession}
                    onRefresh={(project) => {
                      let pending: Promise<void> | undefined;
                      run(() => {
                        pending =
                          typeof controller.catalog.refreshProjectSessions === 'function'
                            ? controller.catalog.refreshProjectSessions(
                                project.source,
                                project.target,
                              )
                            : controller.sync.synchronize({
                                source: project.source,
                                connectionId: state.catalogs[project.source]!.connectionId,
                                owner: project.target.owner,
                                kind: 'connected',
                                deviceId: project.target.deviceId,
                                workspaceId: project.target.workspaceId,
                              });
                        return pending;
                      });
                      return pending;
                    }}
                  />
                ))}
              </Fragment>
            ))}
          </section>
          <NavigationSessions
            kind="recent"
            query={sessionQuery}
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
                  await controller.catalog.refreshCatalog(source);
                navigation.refresh('recent');
              })
            }
            selected={navigationSelected}
            selectedAttention={selectedAttention}
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
                  await controller.catalog.refreshCatalog('local');
                  if (state.catalogs.remote) await controller.catalog.refreshCatalog('remote');
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
                  await controller.sessions.refreshAgentOptions(true);
                  await controller.sessions.readUsage(true);
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
            title="切换侧栏（⌘ / Ctrl B）"
            aria-keyshortcuts="Meta+B Control+B"
            onClick={() => setNavigationOpen((open) => !open)}
          >
            <PanelLeft size={16} />
            <span className="sr-only">项目与会话</span>
          </button>
        </div>
        {runtimeContext && !runtimeContext.value.localReady && (
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
            controller={bindWorkspaceConversationPort(controller)}
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
            onBeforeLogout={() => controller.catalog.disconnectSource('remote')}
            activeTarget={state.scope?.source === 'remote' ? state.scope.target : undefined}
            pairingScope={
              pairingProject && { source: pairingProject.source, target: pairingProject.target }
            }
            beforeMove={() => controller.drafts.flushDraft()}
            endView={async () => {
              await controller.catalog.disconnectSource('remote');
              await controller.catalog.refreshCatalog('remote');
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

export function WorkspaceApp({
  ports,
  ...props
}: ComponentProps<typeof WorkspaceView> & { ports: UiPorts }) {
  return (
    <UiPortsProvider ports={ports}>
      <WorkspaceView {...props} />
    </UiPortsProvider>
  );
}
