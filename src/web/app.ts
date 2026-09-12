import { GIT_WORKTREE_FEATURE } from '../git-protocol';
import { GitWorkspaceController, gitWorkspaceKey, type GitTarget } from './git-workspace';
import { showGitWorkspaceControl, showGitWorkspacePanel } from './git-workspace-ui';
import { SESSION_FORK_FEATURE, forkOriginSchema, type ForkReceipt } from '../fork-protocol';
import { SessionForkController, sessionForkKey, type ForkTarget } from './session-fork';
import { showSessionForkControl, showSessionForkPanel, showForkOrigin } from './session-fork-ui';
import { NotificationController } from './notifications';
import {
  notificationBrowser,
  browserNotificationReason,
  clearLocalNotifications,
  reconcileNotificationAccount,
} from './notification-browser';
import { showNotificationPanel } from './notification-ui';
import {
  parseNotificationNavigation,
  resolveNotificationNavigation,
} from './notification-navigation';
import { QUESTIONS_FEATURE, STEER_FEATURE, type QuestionAnswer } from '../interaction-protocol';
import {
  InteractionController,
  interactionKey,
  questionDraftKey,
  questionItemSchema,
  steerItemSchema,
  interactionCapabilitiesSchema,
  sessionInformation,
  renderInteractionItem,
  type InteractionTarget,
  type QuestionItem,
  type SteerItem,
} from './interactions';
import {
  showInteractionControls,
  showQuestionPanel,
  showInformationPanel,
  showSteerPanel,
  closeInteractionPanel,
} from './interaction-ui';
import { api as request, ApiError, type Identity } from './api';
import { SESSION_SEARCH_FEATURE, type SearchHit } from '../search-protocol';
import { searchSessionContent, type SearchSession, type SessionSearchView } from './session-search';
import { showSessionSearchControl, showSessionSearchPanel } from './session-search-ui';
import { firstStartupSource } from './bootstrap';
import {
  showShell,
  showNavigation,
  showTarget,
  showNewSessionControls,
  showRunControls,
  showAuth,
  closeNavigation,
  resizeComposer,
  sendIcon,
  showAttachmentControls,
  showAttachmentPreview,
} from './ui';
import { ATTACHMENTS_FEATURE } from '../attachment-protocol';
import { attachmentReferenceSchema, type AttachmentReference } from '../content-protocol';
import { CONTENT_LIMITS } from '../content-protocol';
import {
  PROJECT_TREE_FEATURE,
  PROJECT_DIFF_FEATURE,
  projectDiffReferenceSchema,
  type ProjectDiffChange,
} from '../project-content-protocol';
import {
  projectContentKey,
  readProjectTree,
  readCurrentProjectFile,
  readProjectTurnDiff,
  readProjectDiffFile,
  type ProjectContentTarget,
} from './project-content';
import {
  showProjectContentControls,
  showProjectContentPanel,
  type ProjectContentPanelProps,
  type ProjectTurnChoice,
} from './project-content-ui';
import {
  AttachmentDraftController,
  attachmentDraftKey,
  attachmentInputReason,
  attachmentBytes,
  readAttachment,
  type AttachmentScope,
  type AttachmentTarget,
} from './attachments';
import { Flock, LoroDoc, decode, encode, delta, vv, mirror, putMeta, metas } from '../model';
import { agentSchema, type Mutation, type RuntimeWorkspace, type SessionAction } from '../protocol';
import {
  actionScope,
  deliverSessionAction,
  pendingSessionActionSchema,
  routeSessionAction,
  sessionActionKey,
  type PendingSessionAction,
} from './session-actions';
import { resolveRunSelection, selectionFromInput, type RunSelection } from '../run-config';
import type { Workspace, ProjectReplica } from '../catalog';
import * as cache from './cache';
import { esc, renderItem, renderFileChanges } from './content';
import {
  filterCatalogSessions,
  catalogSessionList,
  resolveSelection,
  type Device,
  type Selection,
  type SessionSummary,
} from './navigation';
type MoorDesktop = {
  version: 1;
  saveAttachment(value: {
    scope: AttachmentScope;
    reference: AttachmentReference;
    data: string;
  }): Promise<{ status: 'saved' | 'cancelled' }>;
  cancelAttachmentSave(): Promise<void>;
};
function desktopContent() {
  const bridge = (window as unknown as { moorDesktop?: MoorDesktop }).moorDesktop;
  return bridge?.version === 1 ? bridge : undefined;
}
function cancelAttachmentSave() {
  void desktopContent()
    ?.cancelAttachmentSave()
    .catch(() => {});
}
let notificationAccountGeneration = 0;
let notificationController: NotificationController | undefined;
let notificationPanelOpen = false;
function renderNotifications() {
  if (!notificationPanelOpen) return;
  const controller = notificationController;
  showNotificationPanel({
    controller,
    reason: localOnly
      ? '桌面原生通知请在 Moor 桌面设置中开启；默认关闭。'
      : !authenticated
        ? '当前离线，开启或修改服务器订阅需要连接。'
        : browserNotificationReason(),
    onClose: () => {
      notificationPanelOpen = false;
      showNotificationPanel();
    },
    onRefresh: () => {
      if (controller) run(() => controller.refresh());
    },
    // Do not defer this callback: permission must be requested in this click.
    onEnable: (preferences) => {
      if (controller) {
        try {
          void controller.enable(preferences).catch(error);
        } catch (cause) {
          error(cause);
        }
      }
    },
    onPreferences: (preferences) => {
      if (controller) run(() => controller.savePreferences(preferences));
    },
    onDisable: (record) => {
      if (controller) run(() => controller.disable(record));
    },
  });
}
function openNotifications() {
  closeNavigation();
  notificationPanelOpen = true;
  if (!localOnly && (!notificationController || notificationController.owner !== owner)) {
    const expectedOwner = owner,
      generation = bootGeneration,
      notificationGeneration = notificationAccountGeneration;
    notificationController = new NotificationController(owner, {
      browser: notificationBrowser,
      request: api,
      current: () =>
        owner === expectedOwner &&
        generation === bootGeneration &&
        notificationGeneration === notificationAccountGeneration,
      changed: renderNotifications,
    });
  }
  renderNotifications();
  if (notificationController) run(() => notificationController!.refresh());
}
function takeNotificationQuery() {
  const url = new URL(location.href),
    raw = url.searchParams.get('notification');
  if (raw === null) return;
  url.searchParams.delete('notification');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  return raw;
}
async function openNotificationQuery() {
  const raw = takeNotificationQuery();
  if (raw === undefined) return;
  const expectedOwner = owner,
    generation = bootGeneration,
    selection = sessionGeneration;
  const current = () => owner === expectedOwner && generation === bootGeneration;
  try {
    if (!authenticated)
      throw new Error('当前离线，只能阅读本机缓存；连接后请从会话列表查看通知对应状态。');
    const identity = await api('/api/me');
    if (!current() || selection !== sessionGeneration) return;
    if (identity.owner !== expectedOwner) throw new Error('登录账号已改变，通知没有打开任何会话。');
    const event = parseNotificationNavigation(
      raw,
      expectedOwner,
      identity.localOnly === true,
      Date.now(),
    );
    await loadDevices();
    if (!current() || selection !== sessionGeneration) return;
    const target = resolveNotificationNavigation(event, devices, catalog);
    // The route carried by a push is not authority. Use only the freshly read
    // catalog mapping of the immutable host/user/project execution identity.
    await selectWorkspace(target.space.id, {
      deviceId: target.host.deviceId,
      workspaceId: target.host.runtimeWorkspaceId,
      sessionId: event.sessionId,
      projectId: target.replica.projectId,
      replicaId: target.replica.id,
      search: '',
    });
    if (
      !current() ||
      sessionId !== event.sessionId ||
      workspace?.id !== event.workspaceId ||
      replica?.localProjectId !== event.localProjectId ||
      selected?.id !== target.host.deviceId
    )
      return;
    const article = [...document.querySelectorAll<HTMLElement>('#history [data-search-turn]')].find(
      (item) => item.dataset.searchTurn === event.turnId,
    );
    if (article) {
      article.classList.add('search-located');
      article.tabIndex = -1;
      article.focus({ preventScroll: true });
      article.scrollIntoView?.({ block: 'center' });
    }
    if (!selected.online)
      error(new ApiError('执行电脑离线，当前显示本机缓存；通知内容尚未重新确认。', 0));
    else if (!article) error(new Error('已打开对应会话；此回合尚未读到，请稍后重新读取。'));
  } catch (cause) {
    if (current()) error(cause);
  }
}
let search = '',
  projectFilter = '',
  restoredSelection = false,
  selectionLoading = 0;
let localOnly = false;
let catalog: Workspace[] = [],
  activeWorkspace: Workspace | undefined,
  replica: ProjectReplica | undefined;
let owner = '',
  devices: Device[] = [],
  selected: Device | undefined,
  workspace: RuntimeWorkspace | undefined,
  sessionId = '',
  doc = new LoroDoc(),
  flock = new Flock(),
  meta: any = null;
let events: WebSocket | null = null,
  connected = false,
  sessionGeneration = 0,
  sessionReadGeneration = 0,
  refreshTimer: ReturnType<typeof setTimeout> | undefined,
  pending: Mutation | undefined,
  sending = false;
let sessionList: SessionSummary[] = [];
let archived = false,
  listLoading = false,
  listError = '',
  listGeneration = 0,
  actionSending = false,
  actionError = '';
let pendingAction: PendingSessionAction | undefined;
let sessionPersistenceError = '';
let volatileSessionDoc: LoroDoc | undefined;
let attachments: AttachmentDraftController | undefined,
  attachmentGeneration = 0,
  attachmentLoading = false,
  attachmentWorking = false,
  attachmentLoadError = '';
type ProjectPanelState = Pick<
  ProjectContentPanelProps,
  | 'title'
  | 'mode'
  | 'busy'
  | 'error'
  | 'tree'
  | 'currentFile'
  | 'currentUnavailable'
  | 'turns'
  | 'turnId'
  | 'diff'
  | 'diffFile'
> & { target: ProjectContentTarget; generation: number };
let projectPanel: ProjectPanelState | undefined,
  projectPanelGeneration = 0,
  projectReadGeneration = 0;
let interactions: InteractionController | undefined;
let interactionLoading = false,
  interactionLoadError = '',
  interactionGeneration = 0;
let interactionPanel:
  | { mode: 'question'; key: string }
  | { mode: 'information' }
  | { mode: 'steer'; expectedTurnId: string }
  | undefined;
function resetInteractions() {
  interactionGeneration++;
  interactions = undefined;
  interactionLoading = false;
  interactionLoadError = '';
  interactionPanel = undefined;
  closeInteractionPanel();
  showInteractionControls(undefined);
}
function interactionTarget(): InteractionTarget | undefined {
  if (!owner || !selected || !workspace || !replica || !activeWorkspace || !sessionId) return;
  return {
    owner,
    deviceId: selected.id,
    workspaceId: workspace.id,
    localProjectId: replica.localProjectId,
    sessionId,
    catalogWorkspaceId: activeWorkspace.id,
    replicaId: replica.id,
  };
}
function currentInteractions() {
  const target = interactionTarget();
  return target && interactions && interactionKey(target) === interactionKey(interactions.scope)
    ? interactions
    : undefined;
}
async function loadInteractionDraft() {
  const token = ++interactionGeneration,
    target = interactionTarget(),
    generation = sessionGeneration;
  interactions = undefined;
  interactionLoading = true;
  interactionLoadError = '';
  updateComposer();
  try {
    if (!target) return;
    const controller = new InteractionController(target, {
      read: cache.read,
      write: cache.write,
      request: api,
      onChange: () => {
        if (interactions === controller) updateComposer();
      },
    });
    await controller.load();
    if (token !== interactionGeneration || generation !== sessionGeneration) return;
    interactions = controller;
  } catch (e) {
    if (token === interactionGeneration)
      interactionLoadError = '交互草稿无法恢复，请重新打开会话后重试。';
    throw e;
  } finally {
    if (token === interactionGeneration) {
      interactionLoading = false;
      updateComposer();
    }
  }
}
function interactionSnapshot() {
  const view = mirror(volatileSessionDoc ?? doc, sessionId),
    history = view.getState().history;
  const active = history.findLast((turn) => turn.role === 'assistant' && !turn.finished),
    latest = history.findLast((turn) => turn.role === 'assistant');
  const questions: QuestionItem[] = [],
    steers: SteerItem[] = [];
  for (const turn of history)
    for (const item of turn.items ?? []) {
      const question = questionItemSchema.safeParse(item);
      if (
        question.success &&
        question.data.request.workspaceId === workspace?.id &&
        question.data.request.localProjectId === replica?.localProjectId &&
        question.data.request.sessionId === sessionId &&
        question.data.request.expectedTurnId === turn.id
      )
        questions.push(question.data);
      const steer = steerItemSchema.safeParse(item);
      if (steer.success && steer.data.expectedTurnId === turn.id) steers.push(steer.data);
    }
  let capabilities: ReturnType<typeof interactionCapabilitiesSchema.parse> | undefined;
  for (const item of active?.items ?? []) {
    const value = item as any;
    if (value.type === 'agent_features') {
      const parsed = interactionCapabilitiesSchema.safeParse(value.interactionCapabilities);
      if (parsed.success) capabilities = parsed.data;
    }
  }
  const information = sessionInformation(latest?.items ?? []);
  const finishedTurns = history
    .filter((turn) => turn.role === 'assistant' && turn.finished)
    .map((turn) => turn.id);
  view.dispose();
  return { activeId: active?.id, questions, steers, capabilities, information, finishedTurns };
}
function interactionOnlineReason() {
  if (interactionLoadError) return interactionLoadError;
  if (interactionLoading || !currentInteractions()) return '正在恢复本地交互草稿…';
  if (!authenticated || !connected || !selected?.online || !replica?.available)
    return '执行电脑离线 · 草稿已保留；连接后需要手动提交。';
  return '';
}
function interactionNewReason(feature: string) {
  return (
    interactionOnlineReason() ||
    sessionPersistenceError ||
    (meta?.isArchived ? '请先恢复会话。' : '') ||
    (!workspace?.features?.includes(feature) ? '请更新执行电脑上的 Moor，以使用此交互。' : '') ||
    (sending || pending || actionSending || pendingAction ? '请先确认当前会话操作。' : '')
  );
}
function closeCurrentInteractionPanel() {
  interactionPanel = undefined;
  closeInteractionPanel();
}
function openQuestion(item: QuestionItem) {
  interactionPanel = { mode: 'question', key: questionDraftKey(item.request) };
  renderInteractions();
}
function assertInteractionController(controller: InteractionController) {
  const target = interactionTarget();
  if (controller !== currentInteractions() || !target)
    throw new Error('会话目标已改变，请重新打开原交互。');
  return target;
}
async function answerActiveQuestion(requestId: string, answer: QuestionAnswer['answer']) {
  const controller = currentInteractions(),
    snapshot = interactionSnapshot(),
    item = snapshot.questions.find((q) => questionDraftKey(q.request) === requestId);
  const reason = interactionNewReason(QUESTIONS_FEATURE);
  if (reason) throw new Error(reason);
  if (
    !controller ||
    !item ||
    item.status !== 'pending' ||
    item.request.expectedTurnId !== snapshot.activeId ||
    snapshot.capabilities?.questions !== true
  )
    throw new Error('问题已结束或不再属于当前活动回合。');
  const generation = sessionGeneration;
  await controller.answer(item.request, answer, assertInteractionController(controller));
  if (generation !== sessionGeneration) return;
  closeCurrentInteractionPanel();
  await loadSession();
}
async function submitSteer(prompt: string, expectedTurnId: string) {
  const controller = currentInteractions(),
    snapshot = interactionSnapshot(),
    reason = interactionNewReason(STEER_FEATURE);
  if (reason) throw new Error(reason);
  if (!controller || snapshot.activeId !== expectedTurnId || !expectedTurnId)
    throw new Error('原回合已经结束；追加草稿仍保留，不会转为新指令。');
  if (snapshot.capabilities?.steer !== true)
    throw new Error(
      snapshot.capabilities?.steerUnavailableReason || '当前运行时不支持回合内追加。',
    );
  const generation = sessionGeneration;
  await controller.steer(expectedTurnId, prompt, assertInteractionController(controller));
  if (generation !== sessionGeneration) return;
  closeCurrentInteractionPanel();
  await loadSession();
}
async function retryInteraction() {
  const controller = currentInteractions(),
    reason = interactionOnlineReason();
  if (reason) throw new Error(reason);
  if (!controller?.pending) throw new Error('没有待确认交互。');
  const generation = sessionGeneration;
  await controller.retry(assertInteractionController(controller));
  if (generation === sessionGeneration) await loadSession();
}
function interactionDismissal() {
  const operation = currentInteractions()?.pending,
    snapshot = interactionSnapshot();
  if (!operation) return;
  const record =
    operation.kind === 'steer'
      ? snapshot.steers.find(
          (item) =>
            item.operationId === operation.request.operationId &&
            item.expectedTurnId === operation.request.expectedTurnId,
        )
      : undefined;
  if (record?.status === 'not-injected')
    return {
      outcome: 'not-injected' as const,
      message: '主机记录确认原追加未进入活动回合。关闭记录不会自动发送新指令。',
    };
  if (snapshot.finishedTurns.includes(operation.request.expectedTurnId))
    return {
      outcome: 'unknown' as const,
      message:
        '原回合已结束，原交互送达结果仍未获得有效确认。关闭只解除本地待确认状态，不代表成功，也不会重发。',
    };
}
async function dismissInteraction() {
  const controller = currentInteractions(),
    outcome = interactionDismissal();
  if (!controller || !outcome) throw new Error('原回合仍在运行；请先确认交互结果或停止任务。');
  await controller.dismiss(outcome.outcome, outcome.message);
}
async function fillAgentCommand(command: string) {
  const snapshot = interactionSnapshot();
  if (
    !snapshot.information.commands?.some((item) => item.name === command) ||
    sending ||
    pending ||
    attachmentWorking ||
    sessionPersistenceError
  )
    throw new Error('当前无法填入该命令。');
  const field = $<HTMLTextAreaElement>('#prompt'),
    generation = sessionGeneration,
    draftKey = key('draft');
  const text = '/' + command.replace(/^\/+/, '') + (field.value ? ' ' + field.value : ' ');
  await cache.write(draftKey, text);
  if (generation !== sessionGeneration) return;
  field.value = text;
  resizeComposer();
  closeCurrentInteractionPanel();
  field.focus();
}
function renderInteractions() {
  if (!interactionTarget()) {
    showInteractionControls(undefined);
    return;
  }
  const controller = currentInteractions(),
    snapshot = interactionSnapshot(),
    reason = interactionOnlineReason();
  const operation = controller?.pending,
    record =
      operation?.kind === 'steer'
        ? snapshot.steers.find(
            (item) =>
              item.operationId === operation.request.operationId &&
              item.expectedTurnId === operation.request.expectedTurnId,
          )
        : undefined;
  const pendingMessage =
    record?.status === 'not-injected'
      ? '主机记录：原追加未进入活动回合。可手动关闭记录，再决定下一步。'
      : record?.status === 'unknown'
        ? '主机无法确认追加是否进入回合。手动重试只查询原记录，不会再次调用 Agent。'
        : undefined;
  showInteractionControls({
    questions: snapshot.questions.filter(
      (q) => q.status === 'pending' && q.request.expectedTurnId === snapshot.activeId,
    ),
    pending: operation,
    busy: controller?.busy ?? false,
    reason,
    pendingMessage,
    canDismiss: !!interactionDismissal(),
    closedCount: controller?.closed.length ?? 0,
    onQuestion: openQuestion,
    onInformation: () => {
      interactionPanel = { mode: 'information' };
      renderInteractions();
    },
    onSteer: () => {
      interactionPanel = { mode: 'steer', expectedTurnId: snapshot.activeId ?? '' };
      renderInteractions();
    },
    onRetry: () => run(retryInteraction),
    onDismiss: () => run(dismissInteraction),
  });
  if (!interactionPanel) return;
  if (interactionPanel.mode === 'information') {
    const generation = sessionGeneration;
    showInformationPanel({
      state: snapshot.information,
      canFill: !sending && !pending && !attachmentWorking && !sessionPersistenceError,
      onFill: (command) => {
        if (generation !== sessionGeneration) throw new Error('命令所属会话已改变。');
        return fillAgentCommand(command);
      },
      onClose: closeCurrentInteractionPanel,
    });
    return;
  }
  if (!controller) return;
  if (interactionPanel.mode === 'question') {
    const panel = interactionPanel,
      item = snapshot.questions.find((q) => questionDraftKey(q.request) === panel.key);
    if (!item) {
      closeCurrentInteractionPanel();
      return;
    }
    const active = item.status === 'pending' && item.request.expectedTurnId === snapshot.activeId;
    showQuestionPanel({
      item,
      values: controller.questionDraft(item.request),
      active,
      busy: controller.busy,
      pending: !!operation,
      reason:
        interactionNewReason(QUESTIONS_FEATURE) ||
        (snapshot.capabilities?.questions !== true && active ? '当前运行时尚未确认问答能力。' : ''),
      onClose: closeCurrentInteractionPanel,
      onDraft: (values) => {
        assertInteractionController(controller);
        return controller.saveQuestionDraft(item.request, values);
      },
      onAnswer: (answer) => {
        assertInteractionController(controller);
        return answerActiveQuestion(panel.key, answer);
      },
    });
    return;
  }
  const panel = interactionPanel;
  const steerReason =
    interactionNewReason(STEER_FEATURE) ||
    (!snapshot.activeId
      ? '当前没有活动回合。'
      : snapshot.activeId !== panel.expectedTurnId
        ? '原回合已经结束；此草稿不会转为新指令。'
        : snapshot.capabilities?.steer !== true
          ? snapshot.capabilities?.steerUnavailableReason ||
            (currentAgent()?.agentType === 'codex'
              ? '当前 Codex 适配器不支持回合内追加。'
              : '当前运行时不支持回合内追加。')
          : '');
  showSteerPanel({
    draft: controller.steerDraft,
    reason: steerReason,
    busy: controller.busy,
    pending: operation,
    closed: controller.closed,
    onClose: closeCurrentInteractionPanel,
    onDraft: (value) => {
      assertInteractionController(controller);
      return controller.saveSteerDraft(value);
    },
    onSubmit: (prompt) => {
      assertInteractionController(controller);
      return submitSteer(prompt, panel.expectedTurnId);
    },
  });
}

let sessionFork: SessionForkController | undefined;
let forkGeneration = 0,
  forkPanelOpen = false,
  forkTurnId: string | undefined;
let forkResource: GitWorkspaceController | undefined;
function resetSessionFork() {
  forkGeneration++;
  sessionFork = undefined;
  forkPanelOpen = false;
  forkTurnId = undefined;
  forkResource = undefined;
  showSessionForkPanel();
  showSessionForkControl();
  showForkOrigin();
}
function forkTarget(): ForkTarget | undefined {
  if (!owner || !selected || !workspace || !activeWorkspace || !replica || !sessionId) return;
  return {
    owner,
    deviceId: selected.id,
    userId: workspace.userId,
    machineId: workspace.machineId,
    workspaceId: workspace.id,
    localProjectId: replica.localProjectId,
    sessionId,
    catalogWorkspaceId: activeWorkspace.id,
    replicaId: replica.id,
  };
}
function currentSessionFork() {
  const target = forkTarget();
  return target && sessionFork && sessionForkKey(target) === sessionForkKey(sessionFork.target)
    ? sessionFork
    : undefined;
}
function forkBlocksComposer() {
  return !!sessionId && (!currentSessionFork() || currentSessionFork()!.blocked);
}
function forkReason() {
  if (!authenticated || !connected || !selected?.online || !replica?.available)
    return '执行电脑离线，可阅读缓存选项；连接后请手动操作。';
  if (!workspace?.features?.includes(SESSION_FORK_FEATURE))
    return '执行电脑尚不支持会话 Fork，请更新 Moor 后重新读取能力。';
  if (sessionPersistenceError) return sessionPersistenceError;
  return '';
}
async function loadSessionFork() {
  const target = forkTarget(),
    generation = ++forkGeneration;
  sessionFork = undefined;
  if (!target) return;
  const controller: SessionForkController = new SessionForkController(target, {
    read: cache.read,
    compareWrite: cache.compareWrite,
    request: api,
    current: () => generation === forkGeneration && currentSessionFork() === controller,
    changed: () => {
      if (generation === forkGeneration) updateComposer();
    },
  });
  sessionFork = controller;
  try {
    await controller.load();
  } catch (cause) {
    if (generation === forkGeneration) throw cause;
  }
}
async function openSessionFork(turnId?: string) {
  const controller = currentSessionFork();
  if (!controller) return;
  gitPanelOpen = false;
  showGitWorkspacePanel();
  forkResource = undefined;
  forkPanelOpen = true;
  forkTurnId = turnId;
  renderSessionFork();
  if (!forkReason()) await forkOperation((value) => value.refresh(turnId));
}
async function forkOperation<T>(work: (controller: SessionForkController) => Promise<T>) {
  const controller = currentSessionFork(),
    generation = forkGeneration;
  if (!controller || forkReason()) throw new Error(forkReason() || 'Fork 记录尚未恢复。');
  if (
    sending ||
    pending ||
    actionSending ||
    pendingAction ||
    attachmentWorking ||
    currentAttachments()?.busyId ||
    currentInteractions()?.busy ||
    currentInteractions()?.pending ||
    currentGitWorkspace()?.pending ||
    currentGitWorkspace()?.busy
  )
    throw new Error('请先确认源会话的当前操作。');
  try {
    return await work(controller);
  } catch (cause) {
    if (generation === forkGeneration) throw cause;
  }
}
async function openForkChild(controller: SessionForkController, receipt: ForkReceipt) {
  if (
    controller !== currentSessionFork() ||
    receipt.phase !== 'accepted' ||
    controller.receipt !== receipt
  )
    return;
  const generation = forkGeneration;
  await loadSessions();
  if (generation !== forkGeneration || controller !== currentSessionFork()) return;
  await openSession(receipt.childSessionId, controller.target.replicaId);
}
async function openForkWorkspace(childSessionId: string) {
  const source = currentSessionFork(),
    receipt =
      source?.receipt?.childSessionId === childSessionId
        ? source.receipt
        : source?.resources.find((resource) => resource.receipt.childSessionId === childSessionId)
            ?.receipt;
  if (!source || receipt?.execution?.mode !== 'worktree') return;
  const generation = forkGeneration;
  const controller: GitWorkspaceController = new GitWorkspaceController(
    { ...source.target, sessionId: receipt.childSessionId },
    {
      read: cache.read,
      compareWrite: cache.compareWrite,
      request: api,
      current: () =>
        generation === forkGeneration &&
        source === currentSessionFork() &&
        forkResource === controller,
      changed: () => {
        if (generation === forkGeneration) renderSessionFork();
      },
    },
  );
  forkResource = controller;
  gitPanelOpen = false;
  showSessionForkPanel();
  try {
    await controller.load();
    if (generation !== forkGeneration) return;
    renderSessionFork();
    if (!gitOnlineReason()) {
      await controller.refresh();
      await recordForkCleanup(controller);
    }
  } catch (cause) {
    if (generation === forkGeneration && forkResource === controller) throw cause;
  }
}
async function recordForkCleanup(resource: GitWorkspaceController) {
  const source = currentSessionFork();
  if (
    forkResource !== resource ||
    !source ||
    resource.source !== 'host' ||
    resource.state?.execution.status !== 'removed'
  )
    return;
  const receipt =
    source.receipt?.childSessionId === resource.target.sessionId
      ? source.receipt
      : source.resources.find((item) => item.receipt.childSessionId === resource.target.sessionId)
          ?.receipt;
  if (receipt?.phase === 'rejected')
    await source.confirmResourceCleanup(resource.target.sessionId, resource.state);
}
function renderSessionFork() {
  const controller = currentSessionFork(),
    generation = forkGeneration;
  showSessionForkControl(
    sessionId
      ? { onOpen: () => run(() => openSessionFork()), disabled: !controller?.loaded }
      : undefined,
  );
  const origin = forkOriginSchema.safeParse(meta?.forkOrigin);
  showForkOrigin(
    origin.success
      ? {
          origin: origin.data,
          onOpen: () =>
            run(async () => {
              if (generation !== forkGeneration || controller !== currentSessionFork()) return;
              const target = forkTarget();
              if (!target) return;
              await openSession(origin.data.sourceSessionId, target.replicaId);
              if (sessionId !== origin.data.sourceSessionId || replica?.id !== target.replicaId)
                return;
              if (origin.data.cutoff.kind === 'turn') {
                const turnId = origin.data.cutoff.turnId;
                const found = Array.from(
                  document.querySelectorAll<HTMLElement>('[data-search-turn]'),
                ).find((el) => el.dataset.searchTurn === turnId);
                found?.scrollIntoView?.({ block: 'center' });
                found?.classList.add('search-located');
              }
            }),
        }
      : undefined,
  );
  if (!forkPanelOpen) return;
  if (forkResource) {
    const resource = forkResource;
    const act = (work: (value: GitWorkspaceController) => Promise<void>) =>
      run(async () => {
        if (generation !== forkGeneration || forkResource !== resource) return;
        if (gitOnlineReason()) throw new Error(gitOnlineReason());
        try {
          await work(resource);
        } catch (cause) {
          if (generation === forkGeneration && forkResource === resource) throw cause;
        }
      });
    showSessionForkPanel();
    showGitWorkspacePanel({
      controller: resource,
      newSession: false,
      reason: gitOnlineReason(),
      onClose: () => {
        forkResource = undefined;
        showGitWorkspacePanel();
        renderSessionFork();
      },
      onRefresh: () =>
        act(async (value) => {
          await value.refresh();
          await recordForkCleanup(value);
        }),
      onRemove: () =>
        act(async (value) => {
          await value.remove();
          await recordForkCleanup(value);
        }),
      onDetach: () =>
        act(async (value) => {
          await value.detach();
          await recordForkCleanup(value);
        }),
      onRetry: () =>
        act(async (value) => {
          await value.retry();
          await recordForkCleanup(value);
        }),
      onPrepare: () => {},
      onNewDraft: () => {},
    });
    return;
  }
  const act = (work: (value: SessionForkController) => Promise<unknown>) =>
    run(async () => {
      if (generation !== forkGeneration || controller !== currentSessionFork()) return;
      await forkOperation(work);
    });
  showSessionForkPanel({
    controller,
    sourceTitle: String(meta?.title ?? ''),
    initialTurnId: forkTurnId,
    reason: forkReason(),
    onClose: () => {
      forkPanelOpen = false;
      showSessionForkPanel();
    },
    onRefresh: (turnId) => act((value) => value.refresh(turnId)),
    onCreate: (cutoff, directory) =>
      act(async (value) => {
        const receipt = await value.create(cutoff, directory);
        await openForkChild(value, receipt);
      }),
    onRetry: () =>
      act(async (value) => {
        const receipt = await value.retry();
        await openForkChild(value, receipt);
      }),
    onOpenChild: () =>
      run(async () => {
        if (controller?.receipt) await openForkChild(controller, controller.receipt);
      }),
    onOpenWorkspace: (childSessionId) => run(() => openForkWorkspace(childSessionId)),
  });
}

let gitWorkspace: GitWorkspaceController | undefined;
let gitLoading = false,
  gitLoadError = '',
  gitGeneration = 0,
  gitPanelOpen = false;
function resetGitWorkspace() {
  resetSessionFork();
  gitGeneration++;
  gitWorkspace = undefined;
  gitLoading = false;
  gitLoadError = '';
  gitPanelOpen = false;
  showGitWorkspacePanel();
  showGitWorkspaceControl();
}
function gitTarget(): GitTarget | undefined {
  const controller = currentAttachments();
  if (!controller || !workspace || !activeWorkspace || !replica) return;
  return {
    ...controller.scope,
    userId: workspace.userId,
    machineId: workspace.machineId,
    catalogWorkspaceId: activeWorkspace.id,
    replicaId: replica.id,
  };
}
function currentGitWorkspace() {
  const target = gitTarget();
  return target && gitWorkspace && gitWorkspaceKey(target) === gitWorkspaceKey(gitWorkspace.target)
    ? gitWorkspace
    : undefined;
}
function gitBlocksComposer() {
  return gitLoading || Boolean(gitLoadError || currentGitWorkspace()?.blocked);
}
async function loadGitWorkspace() {
  const target = gitTarget(),
    generation = ++gitGeneration;
  gitWorkspace = undefined;
  gitLoadError = '';
  gitLoading = true;
  updateComposer();
  try {
    if (!target) return;
    const controller: GitWorkspaceController = new GitWorkspaceController(target, {
      read: cache.read,
      compareWrite: cache.compareWrite,
      request: api,
      current: () => generation === gitGeneration && currentGitWorkspace() === controller,
      changed: () => {
        if (generation === gitGeneration) updateComposer();
      },
    });
    gitWorkspace = controller;
    await controller.load();
    if (generation !== gitGeneration) return;
    if (
      authenticated &&
      selected?.online &&
      replica?.available &&
      workspace?.features?.includes(GIT_WORKTREE_FEATURE)
    ) {
      try {
        await controller.refresh();
      } catch (cause) {
        if (generation === gitGeneration) error(cause);
      }
    }
  } catch (cause) {
    if (generation === gitGeneration)
      gitLoadError = 'Git 操作记录无法恢复，请重新打开原会话后再发送。';
    throw cause;
  } finally {
    if (generation === gitGeneration) {
      gitLoading = false;
      updateComposer();
    }
  }
}
function gitOnlineReason() {
  if (!workspace?.features?.includes(GIT_WORKTREE_FEATURE))
    return '执行电脑需要更新 Moor 才能使用 Git 与独立工作目录。';
  if (!authenticated || !connected || !selected?.online || !replica?.available)
    return '执行电脑离线，可查看上次缓存；连接后请手动操作。';
  return '';
}
async function gitOperation(work: (controller: GitWorkspaceController) => Promise<void>) {
  const controller = currentGitWorkspace(),
    generation = gitGeneration;
  if (!controller || gitLoading || gitLoadError)
    throw new Error(gitLoadError || 'Git 操作记录尚未恢复。');
  const reason = gitOnlineReason();
  if (reason) throw new Error(reason);
  if (
    sending ||
    pending ||
    actionSending ||
    pendingAction ||
    attachmentWorking ||
    currentAttachments()?.busyId ||
    currentInteractions()?.busy ||
    currentInteractions()?.pending
  )
    throw new Error('请先确认当前会话操作。');
  try {
    await work(controller);
  } catch (cause) {
    if (generation === gitGeneration) throw cause;
  } finally {
    if (generation === gitGeneration) updateComposer();
  }
}
function openGitWorkspace() {
  forkPanelOpen = false;
  forkResource = undefined;
  showSessionForkPanel();
  gitPanelOpen = true;
  renderGitWorkspace();
}
function renderGitWorkspace() {
  const controller = currentGitWorkspace();
  showGitWorkspaceControl({
    onOpen: openGitWorkspace,
    disabled: !workspace || !replica,
    label: controller?.execution?.mode === 'worktree' ? 'Git · 独立工作目录' : 'Git 与工作目录',
  });
  if (!gitPanelOpen) return;
  const generation = gitGeneration;
  const act = (work: (value: GitWorkspaceController) => Promise<void>) =>
    run(async () => {
      if (generation !== gitGeneration || controller !== currentGitWorkspace()) return;
      await gitOperation(work);
    });
  showGitWorkspacePanel({
    controller,
    newSession: !sessionId,
    reason: gitLoadError || (gitLoading ? '正在恢复 Git 操作记录…' : gitOnlineReason()),
    onClose: () => {
      gitPanelOpen = false;
      showGitWorkspacePanel();
    },
    onRefresh: () => act((value) => value.refresh()),
    onPrepare: (branch, oid, name) =>
      act(async (value) => {
        if (sessionId) throw new Error('已有会话保留当前工作目录，请先创建新会话。');
        await value.prepare(branch, oid, name);
      }),
    onRemove: () => act((value) => value.remove()),
    onDetach: () => act((value) => value.detach()),
    onRetry: () => act((value) => value.retry()),
    onNewDraft: () =>
      act(async (value) => {
        if (sessionId || value.pending || value.execution?.status !== 'removed') return;
        const key = draftAttachmentSessionKey(value.target);
        if ((await cache.read(key)) !== value.target.sessionId)
          throw new Error('会话草稿已改变，请重新打开。');
        await cache.write(key, crypto.randomUUID());
        await loadAttachmentDraft();
      }),
  });
}

let newProjectId = '',
  newAgentId = '',
  newSessionControlsReady = false;
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const rendered = new WeakMap<HTMLElement, string>();
function renderInto(selector: string, html: string) {
  const el = $(selector);
  if (rendered.get(el) !== html) {
    el.innerHTML = html;
    rendered.set(el, html);
  }
}
let networkNotice = false;
function error(e: unknown) {
  networkNotice = e instanceof ApiError && (e.status === 0 || (e.status === 409 && !e.rejected));
  const el = document.querySelector('#notice');
  if (el) {
    el.textContent = e instanceof Error ? e.message : String(e);
    el.classList.add('visible');
  }
}
function clearRecoveredNotice() {
  if (!networkNotice || !connected || !selected?.online) return;
  const notice = document.querySelector('#notice');
  if (notice) {
    notice.textContent = '';
    notice.classList.remove('visible');
  }
  networkNotice = false;
}
function prefix() {
  if (!activeWorkspace || !replica) throw new Error('请先选择项目副本');
  return `/api/workspaces/${activeWorkspace.id}/replicas/${replica.id}`;
}
function query() {
  return `?workspace=${encodeURIComponent(workspace!.id)}`;
}
function key(kind: string) {
  return [owner, selected?.id, workspace?.id, sessionId || 'new', kind].join('/');
}
function draftAttachmentSessionKey(scope: Omit<AttachmentScope, 'sessionId'>) {
  return (
    'attachment-session-v1/' +
    JSON.stringify([scope.owner, scope.deviceId, scope.workspaceId, scope.localProjectId])
  );
}
function currentAttachmentBase() {
  if (!owner || !selected || !workspace || !replica) return undefined;
  return {
    owner,
    deviceId: selected.id,
    workspaceId: workspace.id,
    localProjectId: replica.localProjectId,
  };
}
function currentAttachments() {
  const base = currentAttachmentBase();
  if (!base || !attachments) return undefined;
  const id = sessionId || pending?.sessionId || attachments.scope.sessionId;
  return attachmentDraftKey({ ...base, sessionId: id }) === attachmentDraftKey(attachments.scope)
    ? attachments
    : undefined;
}
function attachmentTarget(controller: AttachmentDraftController): AttachmentTarget {
  const base = currentAttachmentBase();
  if (!base || !activeWorkspace || !replica || controller !== currentAttachments())
    throw new Error('附件执行目标已改变，请重新打开原会话。');
  return { ...controller.scope, catalogWorkspaceId: activeWorkspace.id, replicaId: replica.id };
}
async function loadAttachmentDraft() {
  resetGitWorkspace();
  const token = ++attachmentGeneration,
    base = currentAttachmentBase(),
    generation = sessionGeneration;
  attachments = undefined;
  attachmentLoading = true;
  attachmentLoadError = '';
  updateComposer();
  try {
    if (!base) return;
    let id = sessionId || pending?.sessionId;
    if (!id) {
      const draftKey = draftAttachmentSessionKey(base);
      const saved = await cache.read<string>(draftKey);
      id =
        typeof saved === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(saved)
          ? saved
          : crypto.randomUUID();
      if (id !== saved) await cache.write(draftKey, id);
    }
    if (token !== attachmentGeneration || generation !== sessionGeneration) return;
    const controller = new AttachmentDraftController(
      { ...base, sessionId: id },
      {
        read: cache.read,
        write: cache.write,
        request: api,
        onChange: () => {
          if (attachments === controller) updateComposer();
        },
      },
    );
    attachments = controller;
    await controller.load();
    if (token === attachmentGeneration && generation === sessionGeneration)
      await loadGitWorkspace();
    if (token === attachmentGeneration && generation === sessionGeneration) await loadSessionFork();
  } catch (e) {
    if (token === attachmentGeneration)
      attachmentLoadError = '附件草稿无法恢复，请重新打开会话后重试。';
    throw e;
  } finally {
    if (token === attachmentGeneration) {
      attachmentLoading = false;
      updateComposer();
    }
  }
}
function assertAttachmentOnline() {
  if (!authenticated || !connected || !selected?.online || !replica?.available)
    throw new Error('执行电脑离线，附件草稿已保留；连接后请手动重试。');
  if (!workspace?.features?.includes(ATTACHMENTS_FEATURE))
    throw new Error('请更新执行电脑上的 Moor，以使用附件。');
}
async function attachmentOperation(
  work: (controller: AttachmentDraftController) => Promise<unknown>,
) {
  if (
    sending ||
    pending ||
    actionSending ||
    pendingAction ||
    attachmentWorking ||
    attachmentLoading
  )
    throw new Error('请先确认当前操作。');
  const controller = currentAttachments();
  if (!controller) throw new Error('附件草稿尚未就绪，请重新打开会话。');
  attachmentWorking = true;
  updateComposer();
  try {
    await work(controller);
  } finally {
    attachmentWorking = false;
    updateComposer();
  }
}
async function addAttachments(files: File[]) {
  await attachmentOperation((controller) => controller.add(files));
}
function previewAttachment(
  reference: AttachmentReference,
  data: string,
  source: 'host' | 'cache' | 'draft',
) {
  const generation = sessionGeneration,
    scope = currentAttachments()?.scope;
  cancelAttachmentSave();
  showAttachmentPreview({
    reference,
    data,
    source,
    onClose: () => {
      cancelAttachmentSave();
      showAttachmentPreview(undefined);
    },
    onDownload: () => {
      if (
        generation !== sessionGeneration ||
        !scope ||
        JSON.stringify(scope) !== JSON.stringify(currentAttachments()?.scope)
      )
        return;
      const desktop = desktopContent();
      if (desktop) {
        run(async () => {
          try {
            await desktop.saveAttachment({ scope, reference, data });
          } catch (cause) {
            if (
              generation === sessionGeneration &&
              JSON.stringify(scope) === JSON.stringify(currentAttachments()?.scope)
            )
              throw cause;
          }
        });
        return;
      }
      const bytes = attachmentBytes(data);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = reference.name;
      link.click();
      URL.revokeObjectURL(url);
    },
  });
}
async function openHistoryAttachment(reference: AttachmentReference) {
  const controller = currentAttachments(),
    generation = sessionGeneration;
  if (!controller || !sessionId) throw new Error('请先打开附件所属会话。');
  const result = await readAttachment(
    attachmentTarget(controller),
    reference,
    authenticated && connected && selected?.online === true,
    { read: cache.read, write: cache.write, request: api },
  );
  if (generation === sessionGeneration)
    previewAttachment(reference, result.result.data, result.source);
}
function renderAttachmentControls() {
  const controller = currentAttachments();
  const reason =
    attachmentLoadError ||
    (attachmentLoading
      ? '正在恢复附件草稿…'
      : !workspace?.features?.includes(ATTACHMENTS_FEATURE)
        ? '执行电脑需要更新 Moor 才能上传附件。'
        : !connected || !selected?.online
          ? '附件保留在本机，连接后请手动上传。'
          : undefined);
  showAttachmentControls({
    items: controller?.items ?? [],
    reason,
    itemReason: (reference) =>
      meta?.isArchived
        ? '请先恢复已归档会话，再上传附件。'
        : attachmentInputReason(reference, currentAgent()?.inputCapabilities),
    disabled:
      !controller ||
      !!interactionLoadError ||
      interactionLoading ||
      !!currentInteractions()?.busy ||
      !!currentInteractions()?.pending ||
      !!attachmentLoadError ||
      attachmentLoading ||
      attachmentWorking ||
      sending ||
      !!pending ||
      actionSending ||
      !!pendingAction,
    busyId: controller?.busyId,
    onFiles: (files) => run(() => addAttachments(files)),
    onUpload: (id) =>
      run(() =>
        attachmentOperation(async (current) => {
          assertAttachmentOnline();
          if (meta?.isArchived) throw new Error('请先恢复已归档会话，再上传附件。');
          const item = current.items.find((item) => item.reference.attachmentId === id);
          const why =
            item && attachmentInputReason(item.reference, currentAgent()?.inputCapabilities);
          if (why) throw new Error(why);
          await current.upload(id, attachmentTarget(current));
        }),
      ),
    onRetry: (id) =>
      run(() =>
        attachmentOperation(async (current) => {
          assertAttachmentOnline();
          await current.retry(id, attachmentTarget(current));
        }),
      ),
    onRemove: (id) =>
      run(() =>
        attachmentOperation(async (current) => {
          const item = current.items.find((item) => item.reference.attachmentId === id);
          if (item?.uploaded) assertAttachmentOnline();
          await current.remove(id, item?.uploaded ? attachmentTarget(current) : undefined);
        }),
      ),
    onPreview: (item) => previewAttachment(item.reference, item.data, 'draft'),
  });
}
function projectTarget(): ProjectContentTarget {
  if (
    !owner ||
    !selected ||
    !workspace ||
    !replica ||
    !activeWorkspace ||
    !sessionId ||
    meta?.id !== sessionId
  )
    throw new Error('请先打开一个已有会话，确认项目和执行电脑。');
  return {
    owner,
    deviceId: selected.id,
    workspaceId: workspace.id,
    localProjectId: replica.localProjectId,
    sessionId,
    catalogWorkspaceId: activeWorkspace.id,
    replicaId: replica.id,
  };
}
function projectOnline() {
  return authenticated && connected && selected?.online === true && replica?.available === true;
}
function projectTurns(): ProjectTurnChoice[] {
  const view = mirror(volatileSessionDoc ?? doc, sessionId);
  const turns = view
    .getState()
    .history.filter((turn) => turn.role === 'assistant')
    .map((turn, index) => {
      const reference = projectDiffReferenceSchema.safeParse(turn.fileDiff);
      return {
        id: turn.id,
        label: `第 ${index + 1} 回合 · ${new Date(turn.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
        ...(reference.success ? { reference: reference.data } : {}),
      };
    });
  view.dispose();
  return turns.reverse();
}
type SearchPanelState = {
  target: ProjectContentTarget;
  generation: number;
  title: string;
  sessions: SearchSession[];
  busy?: boolean;
  error?: string;
  result?: SessionSearchView;
};
let searchPanel: SearchPanelState | undefined;
let searchPanelGeneration = 0,
  searchReadGeneration = 0;
function closeSessionSearch() {
  searchPanelGeneration++;
  searchReadGeneration++;
  searchPanel = undefined;
  showSessionSearchPanel();
}
function searchPanelCurrent(panel: SearchPanelState) {
  if (!searchPanel || panel.generation !== searchPanelGeneration) return false;
  try {
    return projectContentKey(panel.target) === projectContentKey(projectTarget());
  } catch {
    return false;
  }
}
function renderSessionSearch() {
  const panel = searchPanel;
  if (!panel || !searchPanelCurrent(panel)) {
    closeSessionSearch();
    return;
  }
  showSessionSearchPanel({
    ...panel,
    online: projectOnline(),
    onClose: closeSessionSearch,
    onSearch: (query, scope) => run(() => runSessionSearch(panel, query, scope)),
    onOpen: (hit) => run(() => openSearchHit(panel, hit)),
  });
}
function openSessionSearch() {
  const target = projectTarget();
  if (projectOnline() && !workspace?.features?.includes(SESSION_SEARCH_FEATURE))
    throw new Error('执行电脑需要更新 Moor 才能搜索正文。');
  closeProjectContent();
  closeCurrentInteractionPanel();
  closeNavigation();
  const sessions = sessionList
    .filter((row) => row.replicaId === target.replicaId)
    .map((row) => ({ id: row.id, title: row.title || '会话' }));
  if (!sessions.some((row) => row.id === target.sessionId))
    sessions.unshift({ id: target.sessionId, title: meta?.title || '会话' });
  searchPanel = {
    target,
    generation: ++searchPanelGeneration,
    title: `${meta?.title ?? '会话'} · ${selected?.name ?? ''}`,
    sessions,
  };
  renderSessionSearch();
}
async function runSessionSearch(
  panel: SearchPanelState,
  query: string,
  scope: 'session' | 'project',
) {
  if (!searchPanelCurrent(panel)) return;
  const generation = ++searchReadGeneration;
  const current = () => searchPanelCurrent(panel) && generation === searchReadGeneration;
  const runtime = workspace!;
  const online = projectOnline();
  let cacheBytes = 0;
  searchPanel = { ...panel, busy: true, error: '', result: undefined };
  renderSessionSearch();
  try {
    const result = await searchSessionContent(
      panel.target,
      { query, scope },
      online,
      panel.sessions,
      {
        read: cache.read,
        write: cache.write,
        request: api,
        readHistory: async (target) => {
          const saved = await cache.read<any>(
            [target.owner, target.deviceId, target.workspaceId, target.sessionId, 'session'].join(
              '/',
            ),
          );
          if (
            !saved ||
            saved.meta?.id !== target.sessionId ||
            saved.meta?.userId !== runtime.userId ||
            saved.meta?.machineId !== runtime.machineId ||
            saved.meta?.project?.kind !== 'local' ||
            saved.meta?.project?.localProjectId !== target.localProjectId ||
            typeof saved.snapshot !== 'string'
          )
            return undefined;
          // Bound decoding too: cached CRDT snapshots may be much larger than the
          // visible text projection. Cache corruption never falls back to a live doc.
          cacheBytes += saved.snapshot.length;
          if (saved.snapshot.length > 24 * 1024 * 1024 || cacheBytes > 64 * 1024 * 1024)
            return undefined;
          const cachedDoc = new LoroDoc();
          cachedDoc.import(decode(saved.snapshot));
          const view = mirror(cachedDoc, target.sessionId);
          try {
            return structuredClone(view.getState().history);
          } finally {
            view.dispose();
            cachedDoc.free();
          }
        },
      },
    );
    if (current()) searchPanel = { ...searchPanel!, result };
  } catch (cause) {
    if (current())
      searchPanel = {
        ...searchPanel!,
        error: cause instanceof Error ? cause.message : String(cause),
      };
  } finally {
    if (current()) {
      searchPanel = { ...searchPanel!, busy: false };
      renderSessionSearch();
    }
  }
}
async function openSearchHit(panel: SearchPanelState, hit: SearchHit) {
  if (
    !searchPanelCurrent(panel) ||
    !panel.result?.hits.some((value) => JSON.stringify(value) === JSON.stringify(hit))
  )
    return;
  const target = panel.target;
  if (!sessionList.some((row) => row.id === hit.sessionId && row.replicaId === target.replicaId)) {
    if (projectOnline()) await loadSessions();
    if (!searchPanelCurrent(panel)) return;
    if (
      !sessionList.some((row) => row.id === hit.sessionId && row.replicaId === target.replicaId) &&
      hit.sessionId !== sessionId
    )
      throw new Error('搜索结果对应的会话不在当前可访问列表中，请刷新后重新搜索。');
  }
  closeSessionSearch();
  if (hit.sessionId !== sessionId) await openSession(hit.sessionId, target.replicaId);
  if (
    projectContentKey({ ...target, sessionId: hit.sessionId }) !==
    projectContentKey(projectTarget())
  )
    return;
  const article = [...document.querySelectorAll<HTMLElement>('#history [data-search-turn]')].find(
    (element) => element.dataset.searchTurn === hit.turnId,
  );
  if (!article) throw new Error('当前历史中没有这条结果，内容可能已更新或尚未缓存。');
  const item =
    [...article.querySelectorAll<HTMLElement>('[data-search-item]')].find(
      (element) => element.dataset.searchItem === String(hit.itemIndex),
    ) ?? article;
  item.querySelectorAll('details').forEach((details) => {
    details.open = true;
  });
  document
    .querySelectorAll('.search-located')
    .forEach((element) => element.classList.remove('search-located'));
  item.classList.add('search-located');
  item.tabIndex = -1;
  item.focus({ preventScroll: true });
  item.scrollIntoView({ block: 'center' });
  // Saved baseline hits use the same turn anchor as messages. Open a frozen
  // file only when that exact path exists in this turn's confirmed summary.
  if (hit.kind === 'diff' && hit.path && workspace?.features?.includes(PROJECT_DIFF_FEATURE)) {
    const view = mirror(volatileSessionDoc ?? doc, sessionId);
    const turn = view.getState().history.find((turn) => turn.id === hit.turnId);
    const ref = projectDiffReferenceSchema.safeParse(turn?.fileDiff);
    view.dispose();
    if (ref.success && ref.data.version) {
      await openProjectContent('changes', hit.turnId);
      const change = projectPanel?.diff?.result.changes.find((change) => change.path === hit.path);
      if (change) await openProjectDiffFile(change);
    }
  }
}
function closeProjectContent() {
  closeSessionSearch();
  projectPanelGeneration++;
  projectReadGeneration++;
  projectPanel = undefined;
  showProjectContentPanel();
}
function renderProjectControls() {
  showSessionSearchControl(
    sessionId && meta?.id === sessionId && replica
      ? {
          enabled:
            !projectOnline() || workspace?.features?.includes(SESSION_SEARCH_FEATURE) === true,
          onOpen: () => run(async () => openSessionSearch()),
        }
      : undefined,
  );
  if (searchPanel) renderSessionSearch();
  showProjectContentControls(
    sessionId && meta?.id === sessionId && replica
      ? {
          tree: workspace?.features?.includes(PROJECT_TREE_FEATURE) === true,
          changes: workspace?.features?.includes(PROJECT_DIFF_FEATURE) === true,
          onTree: () => run(() => openProjectContent('tree')),
          onChanges: () => run(() => openProjectContent('changes')),
        }
      : undefined,
  );
}
function renderProjectPanel() {
  if (!projectPanel) return;
  showProjectContentPanel({
    ...projectPanel,
    onClose: closeProjectContent,
    onMode: (mode) => run(() => openProjectContent(mode)),
    onTreeMore: () => run(() => loadProjectTree(true)),
    onFile: (path, size) => run(() => openCurrentProjectFile(path, size)),
    onTurn: (id) => run(() => loadProjectTurn(id)),
    onDiffFile: (change) => run(() => openProjectDiffFile(change)),
    onRefresh: () =>
      run(() =>
        projectPanel?.mode === 'tree'
          ? loadProjectTree(false)
          : loadProjectTurn(projectPanel?.turnId),
      ),
  });
}
async function projectRead(
  work: (panel: ProjectPanelState, online: boolean) => Promise<Partial<ProjectPanelState>>,
) {
  if (!projectPanel) return;
  const panel = projectPanel,
    requestGeneration = ++projectReadGeneration;
  const current = () => {
    if (
      !projectPanel ||
      panel.generation !== projectPanelGeneration ||
      panel.generation !== projectPanel.generation ||
      requestGeneration !== projectReadGeneration
    )
      return false;
    try {
      return projectContentKey(panel.target) === projectContentKey(projectTarget());
    } catch {
      return false;
    }
  };
  projectPanel = { ...panel, busy: true, error: '' };
  renderProjectPanel();
  try {
    const patch = await work(panel, projectOnline());
    if (current()) projectPanel = { ...projectPanel!, ...patch };
  } catch (cause) {
    if (current())
      projectPanel = {
        ...projectPanel!,
        error: cause instanceof Error ? cause.message : String(cause),
      };
  } finally {
    if (current()) {
      projectPanel = { ...projectPanel!, busy: false };
      renderProjectPanel();
    }
  }
}
async function openProjectContent(mode: 'tree' | 'changes', turnId?: string) {
  const feature = mode === 'tree' ? PROJECT_TREE_FEATURE : PROJECT_DIFF_FEATURE;
  if (!workspace?.features?.includes(feature))
    throw new Error('执行电脑需要更新 Moor 才能读取这类内容。');
  const target = projectTarget();
  closeNavigation();
  projectPanel = {
    target,
    generation: ++projectPanelGeneration,
    title: `${meta?.title ?? '会话'} · ${selected?.name ?? ''}`,
    mode,
    turns: projectTurns(),
    turnId,
  };
  renderProjectPanel();
  if (mode === 'tree') await loadProjectTree(false);
  else await loadProjectTurn(turnId ?? projectPanel.turns[0]?.id);
}
async function loadProjectTree(more: boolean) {
  if (!projectPanel) return;
  if (more && projectPanel.tree?.result.nextOffset === undefined) return;
  if (!more)
    projectPanel = {
      ...projectPanel,
      tree: undefined,
      currentFile: undefined,
      currentUnavailable: undefined,
    };
  await projectRead(async (panel, online) => {
    const old = more ? panel.tree : undefined;
    const tree = await readProjectTree(
      panel.target,
      old ? { offset: old.result.nextOffset, knownVersion: old.result.version } : {},
      online,
      { read: cache.read, write: cache.write, request: api },
    );
    if (old) {
      if (
        old.result.version !== tree.result.version ||
        old.result.total !== tree.result.total ||
        old.result.entries.some((item) =>
          tree.result.entries.some((entry) => entry.path === item.path),
        )
      )
        throw new Error('目录读取期间发生变化，请重新读取文件树。');
      return {
        tree: {
          ...tree,
          cacheSaved: old.cacheSaved && tree.cacheSaved,
          result: {
            ...tree.result,
            offset: 0,
            entries: [...old.result.entries, ...tree.result.entries],
          },
        },
      };
    }
    return { tree };
  });
}
async function openCurrentProjectFile(path: string, size: number) {
  if (!projectPanel) return;
  projectPanel = { ...projectPanel, currentFile: undefined, currentUnavailable: undefined };
  if (size > CONTENT_LIMITS.fileBytes) {
    projectReadGeneration++;
    projectPanel = {
      ...projectPanel,
      busy: false,
      error: '',
      currentUnavailable: { path, message: '文件超过 1 MiB，只显示目录信息，不提供文本预览。' },
    };
    renderProjectPanel();
    return;
  }
  await projectRead(async (panel, online) => ({
    currentFile: await readCurrentProjectFile(panel.target, path, online, {
      read: cache.read,
      write: cache.write,
      request: api,
    }),
  }));
}
async function loadProjectTurn(turnId?: string) {
  if (!projectPanel) return;
  projectPanel = {
    ...projectPanel,
    turns: projectTurns(),
    turnId,
    diff: undefined,
    diffFile: undefined,
  };
  if (!turnId) {
    projectReadGeneration++;
    projectPanel = { ...projectPanel, busy: false, error: '' };
    renderProjectPanel();
    return;
  }
  await projectRead(async (panel, online) => ({
    diff: await readProjectTurnDiff(
      panel.target,
      turnId,
      online,
      { read: cache.read, write: cache.write, request: api },
      panel.turns.find((turn) => turn.id === turnId)?.reference,
    ),
  }));
}
async function openProjectDiffFile(change: ProjectDiffChange) {
  if (!projectPanel?.diff?.result.reference) return;
  const reference = projectPanel.diff.result.reference;
  projectPanel = { ...projectPanel, diffFile: undefined };
  await projectRead(async (panel, online) => ({
    diffFile: await readProjectDiffFile(panel.target, reference, change, online, {
      read: cache.read,
      write: cache.write,
      request: api,
    }),
  }));
}
function run(fn: () => Promise<unknown>) {
  void fn().catch(error);
}
let authenticated = false,
  bootGeneration = 0;
async function api(path: string, body?: unknown) {
  if (!authenticated && !['/api/me', '/api/login', '/api/setup', '/api/logout'].includes(path))
    throw new ApiError('正在确认登录状态，可阅读本地历史。', 0);
  return request(path, body);
}
function resetWorkspace() {
  resetGitWorkspace();
  cancelAttachmentSave();
  notificationController = undefined;
  notificationPanelOpen = false;
  showNotificationPanel();
  closeProjectContent();
  resetInteractions();
  sessionPersistenceError = '';
  volatileSessionDoc = undefined;
  events?.close();
  events = null;
  connected = false;
  authenticated = false;
  sessionGeneration++;
  attachmentGeneration++;
  attachments = undefined;
  attachmentLoading = false;
  showAttachmentPreview(undefined);
  runOptionsGeneration++;
  owner = '';
  selected = undefined;
  workspace = undefined;
  activeWorkspace = undefined;
  replica = undefined;
  devices = [];
  catalog = [];
  sessionList = [];
  sessionId = '';
  newProjectId = newAgentId = '';
  newSessionControlsReady = false;
  pending = undefined;
  pendingAction = undefined;
  actionError = '';
  archived = listLoading = false;
  listError = '';
  listGeneration++;
  meta = null;
  restoredSelection = false;
  selectionLoading = 0;
  search = projectFilter = '';
  localOnly = false;
  doc = new LoroDoc();
  flock = new Flock();
}
async function restoreCachedWorkspace(cachedOwner: string, generation: number) {
  const [savedDevices, savedCatalog] = await Promise.all([
    cache.read<Device[]>(cachedOwner + '/devices').catch(() => undefined),
    cache.read<Workspace[]>(cachedOwner + '/workspaces').catch(() => undefined),
  ]);
  if (generation !== bootGeneration || owner !== cachedOwner) return;
  devices = (savedDevices ?? []).map((d) => ({ ...d, online: false }));
  catalog = (savedCatalog ?? []).map((w) => ({
    ...w,
    hosts: w.hosts.map((h) => ({ ...h, online: false })),
    replicas: w.replicas.map((r) => ({ ...r, available: false })),
  }));
  renderDevices();
  await restoreSelection();
}
export async function boot(
  identity: Promise<Identity | null> = request('/api/me').catch(() => null),
  cachedOwner: Promise<string | undefined> = cache
    .read<string>('last-owner')
    .catch(() => undefined),
) {
  const generation = ++bootGeneration;
  resetWorkspace();
  const source = await firstStartupSource(identity, cachedOwner);
  if (generation !== bootGeneration) return;
  if (source.kind === 'identity' && source.identity && !source.identity.owner) {
    void cache.write('last-owner', undefined).catch(() => {});
    void reconcileNotificationAccount().catch(() => {});
    takeNotificationQuery();
    showLogin(source.identity.needsSetup);
    return;
  }
  owner =
    source.kind === 'cache' ? source.owner : (source.identity?.owner ?? (await cachedOwner) ?? '');
  if (generation !== bootGeneration) return;
  if (!owner) {
    showLogin(false);
    return;
  }
  shell();
  error(new ApiError('正在连接，可阅读本地历史。', 0));
  const restoring = restoreCachedWorkspace(owner, generation).catch((cause) => {
    if (generation === bootGeneration) error(cause);
  });
  const me = await identity;
  if (generation !== bootGeneration) return;
  if (me && me.owner !== owner) {
    // Invalidate pending cache reads immediately. An old account's history must
    // not survive a confirmed logout or be adopted by a different account.
    resetWorkspace();
    if (!me.owner) {
      bootGeneration++;
      void cache.write('last-owner', undefined).catch(() => {});
      void reconcileNotificationAccount().catch(() => {});
      takeNotificationQuery();
      showLogin(me.needsSetup);
    } else await boot(Promise.resolve(me), Promise.resolve(undefined));
    return;
  }
  await restoring;
  if (generation !== bootGeneration) return;
  if (!me) {
    error(new ApiError('当前离线，可阅读本机缓存的历史', 0));
    await openNotificationQuery();
    return;
  }
  authenticated = true;
  localOnly = me.localOnly === true;
  if (!localOnly) await reconcileNotificationAccount(owner).catch(error);
  if (generation !== bootGeneration) return;
  void cache.write('last-owner', owner).catch(error);
  renderNavigation();
  await openNotificationQuery();
  if (generation === bootGeneration) connect();
}
function showLogin(setup: boolean) {
  showAuth({
    setup,
    onSubmit: async (data) => {
      await api(setup ? '/api/setup' : '/api/login', data);
      await boot();
    },
  });
  window.dispatchEvent(new Event('moor:ready'));
}
function shell() {
  showShell({
    onSend: () => run(sendTurn),
    onDraft: (value) => {
      void cache.write(key('draft'), value).catch(error);
    },
    onCancel: cancelTurn,
    onFiles: (files) => run(() => addAttachments(files)),
  });
  window.dispatchEvent(new Event('moor:ready'));
  renderNavigation();
}
function pairComputer() {
  closeNavigation();
  run(async () => {
    const { code } = await api('/api/pair', { workspaceId: activeWorkspace?.id });
    $('#pair-code').textContent = code;
    $('#pair-command').textContent = location.origin;
    $<HTMLDialogElement>('#pair-dialog').showModal();
  });
}
function logout() {
  resetSessionFork();
  notificationAccountGeneration++;
  notificationController = undefined;
  notificationPanelOpen = false;
  showNotificationPanel();
  run(async () => {
    // Revoke the local worker binding even when server removal is uncertain.
    try {
      await clearLocalNotifications();
    } catch (cause) {
      error(cause);
    }
    await api('/api/logout', {});
    bootGeneration++;
    resetWorkspace();
    await cache.clear();
    showLogin(false);
  });
}
function newSession() {
  return run(async () => {
    archived = false;
    const copies = activeWorkspace?.replicas.filter((r) => r.projectId === projectFilter) ?? [];
    const currentHost = activeWorkspace?.hosts.find(
      (h) => h.deviceId === selected?.id && h.runtimeWorkspaceId === workspace?.id,
    );
    const copy =
      copies.find((r) => r.hostId === currentHost?.id) ??
      copies.find((r) => r.available) ??
      copies[0];
    const host = activeWorkspace?.hosts.find((h) => h.id === copy?.hostId);
    if (host && host.id !== currentHost?.id)
      await selectDevice(host.deviceId, {
        workspaceId: host.runtimeWorkspaceId,
        projectId: projectFilter,
        search,
        sessionId: '',
      });
    else await openSession('');
  });
}
function cancelTurn() {
  return run(async () => {
    const state = mirror(doc, sessionId),
      turn = state.getState().history.find((t) => t.role === 'assistant' && !t.finished);
    state.dispose();
    if (turn) {
      const result = await api(prefix() + '/cancel' + query(), { sessionId, turnId: turn.id });
      if (result.success === false) throw new Error(result.error ?? '停止未获确认');
    }
  });
}
function connect() {
  if (!authenticated || !owner) return;
  events?.close();
  const ws = new WebSocket(new URL('/events', location.href.replace(/^http/, 'ws')));
  events = ws;
  ws.onopen = () => {
    if (events !== ws) return;
    connected = true;
    clearRecoveredNotice();
    renderNavigation();
    renderTarget();
    watch();
    run(async () => {
      await loadDevices();
      await restoreSelection();
      if (activeWorkspace) {
        await loadSessions();
        if (sessionId) await loadSession();
      }
    });
  };
  ws.onclose = () => {
    if (events !== ws || !owner) return;
    connected = false;
    renderNavigation();
    renderTarget();
    updateComposer();
    setTimeout(() => {
      if (events === ws && owner) connect();
    }, 2000);
  };
  ws.onmessage = () => {
    if (!refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        run(async () => {
          await loadDevices();
          if (activeWorkspace) {
            await loadSessions();
            if (sessionId) await loadSession();
          }
        });
      }, 200);
  };
}
async function loadDevices() {
  if (!authenticated) return;
  const requestedOwner = owner;
  const [fresh, spaces]: [Device[], Workspace[]] = await Promise.all([
    api('/api/devices'),
    api('/api/workspaces'),
  ]);
  if (!owner || owner !== requestedOwner) return;
  devices = fresh.map((d) => ({
    ...d,
    workspaces: d.workspaces.length
      ? d.workspaces
      : (devices.find((old) => old.id === d.id)?.workspaces ?? []),
  }));
  catalog = spaces.map((w) => ({
    ...w,
    replicas: w.replicas.map((r) => ({
      ...r,
      rootPath:
        r.rootPath ??
        catalog.find((old) => old.id === w.id)?.replicas.find((old) => old.id === r.id)?.rootPath,
    })),
  }));
  if (activeWorkspace) activeWorkspace = catalog.find((w) => w.id === activeWorkspace!.id);
  if (replica) replica = activeWorkspace?.replicas.find((r) => r.id === replica!.id);
  await Promise.all([
    cache.write(owner + '/devices', devices),
    cache.write(owner + '/workspaces', catalog),
  ]);
  if (selected) {
    selected = devices.find((d) => d.id === selected!.id);
    workspace = selected?.workspaces.find((w) => w.id === workspace?.id);
    if (
      !selected ||
      !activeWorkspace?.hosts.some(
        (h) => h.deviceId === selected!.id && h.runtimeWorkspaceId === workspace?.id,
      )
    ) {
      resetGitWorkspace();
      cancelAttachmentSave();
      showAttachmentPreview(undefined);
      selected = undefined;
      workspace = undefined;
      replica = undefined;
      sessionGeneration++;
      sessionId = '';
      doc = new LoroDoc();
      meta = null;
      pending = undefined;
      sessionList = [];
      $('#history').textContent = '执行目标已移出工作区或授权已撤销，请重新选择。';
      renderSessions();
      $<HTMLFormElement>('#composer').hidden = true;
    }
  }
  renderDevices();
  renderNavigation();
  clearRecoveredNotice();
  if (
    selected &&
    !workspace &&
    activeWorkspace?.hosts.some((h) => h.deviceId === selected!.id) &&
    !selectionLoading
  )
    await selectDevice(selected.id);
  updateComposer();
}
function watch() {
  if (events?.readyState !== WebSocket.OPEN) return;
  if (!sessionId || !replica || !selected || !workspace) {
    events.send(JSON.stringify({ type: 'unwatch' }));
    return;
  }
  if (selected && workspace)
    events.send(
      JSON.stringify({
        type: 'watch',
        deviceId: selected.id,
        workspaceId: workspace.id,
        sessionId,
        catalogWorkspaceId: activeWorkspace?.id,
        replicaId: replica?.id,
      }),
    );
}
function renderDevices() {
  renderNavigation();
  renderTarget();
}

function selectReplica(expectedProjectId?: string) {
  const localProjectId = expectedProjectId ?? newProjectId;
  const host = activeWorkspace?.hosts.find(
    (h) => h.deviceId === selected?.id && h.runtimeWorkspaceId === workspace?.id,
  );
  replica = activeWorkspace?.replicas.find(
    (r) => r.hostId === host?.id && r.localProjectId === localProjectId,
  );
  renderTarget();
  void persistSelection().catch(error);
  updateComposer();
}
function renderNewSessionControls() {
  if (sessionId || !workspace || !newSessionControlsReady) {
    showNewSessionControls(null);
    return;
  }
  const generation = sessionGeneration;
  const host = activeWorkspace?.hosts.find(
    (h) => h.deviceId === selected?.id && h.runtimeWorkspaceId === workspace?.id,
  );
  const change = (field: 'project' | 'agent', value: string) => {
    if (
      generation !== sessionGeneration ||
      sessionId ||
      sending ||
      pending ||
      attachmentWorking ||
      gitLoading ||
      currentGitWorkspace()?.busy ||
      currentGitWorkspace()?.pending ||
      currentAttachments()?.busyId ||
      !workspace
    )
      return;
    if (field === 'project') {
      if (value === newProjectId || !workspace.projects.some((p) => p.id === value)) return;
      newProjectId = value;
    } else {
      if (value === newAgentId || !workspace.agents.some((a) => a.id === value)) return;
      newAgentId = value;
    }
    selectReplica();
    if (field === 'project') void loadAttachmentDraft().catch(error);
    if (field === 'agent') void restoreRunOptions().catch(error);
    void cache.write(key('options'), { project: newProjectId, agent: newAgentId }).catch(error);
  };
  showNewSessionControls({
    projects: workspace.projects.map((p) => {
      const copy = activeWorkspace?.replicas.find(
        (r) => r.localProjectId === p.id && r.hostId === host?.id,
      );
      const project = activeWorkspace?.projects.find((logical) => logical.id === copy?.projectId);
      return { id: p.id, name: project?.name ?? p.name };
    }),
    agents: workspace.agents.map(({ id, name }) => ({ id, name })),
    projectId: newProjectId,
    agentId: newAgentId,
    disabled:
      sending ||
      !!pending ||
      attachmentWorking ||
      gitLoading ||
      !!currentGitWorkspace()?.busy ||
      !!currentGitWorkspace()?.pending ||
      !!currentAttachments()?.busyId,
    onProject: (value) => change('project', value),
    onAgent: (value) => change('agent', value),
  });
}
function renderTarget() {
  renderProjectControls();
  renderGitWorkspace();
  const project = activeWorkspace?.projects.find((p) => p.id === replica?.projectId);
  const row = sessionList.find((s) => s.id === sessionId && s.replicaId === replica?.id);
  showTarget({
    project: project?.name || activeWorkspace?.name,
    title: meta?.title || row?.title || (sessionId ? '会话' : '新会话'),
    host: selected?.name,
    path: replica?.rootPath,
    connected,
    online: !!selected?.online,
  });
}

function projectLabel(space: Workspace, projectId: string) {
  const project = space.projects.find((p) => p.id === projectId);
  if (!project) return '项目';
  if (space.projects.filter((p) => p.name === project.name).length < 2) return project.name;
  const names = [
    ...new Set(
      space.replicas
        .filter((r) => r.projectId === projectId)
        .map((r) => space.hosts.find((h) => h.id === r.hostId)?.name)
        .filter(Boolean),
    ),
  ];
  return `${project.name} · ${names.join(' / ') || '未分配副本'}`;
}
function showWorkspaceManager() {
  closeNavigation();
  const dialog = $<HTMLDialogElement>('#workspace-dialog');
  const space = activeWorkspace;
  dialog.innerHTML = `<h2>管理工作区</h2><form id="create-workspace"><label>新工作区名称<input name="name" required maxlength="100"></label><button>创建工作区</button></form>${
    space
      ? `
    <form id="rename-workspace"><label>当前工作区名称<input name="name" value="${esc(space.name)}" required maxlength="100"></label><button>保存名称</button></form>
    <h3>执行电脑</h3><p>更改归属会将这台电脑的本地工作区及其项目副本一起归入目标工作区。会话仍在原电脑执行。</p>
    ${space.hosts.map((h) => `<form data-move-host="${esc(h.id)}"><label>${esc(h.name)}<select name="workspaceId">${catalog.map((w) => `<option value="${esc(w.id)}" ${w.id === space.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></label><button>更改归属</button>${localOnly ? '' : `<button type="button" data-revoke="${esc(h.deviceId)}">撤销授权</button>`}</form>`).join('') || '<p>尚未连接电脑。</p>'}
    <h3>项目与本地副本</h3><p>把不同电脑上的副本归入同一项目后，会话列表可以按该项目统一筛选。文件保留在各电脑原目录。</p>
    <form id="create-project"><label>新项目名称<input name="name" required maxlength="200"></label><button>创建项目</button></form>
    ${space.replicas.map((r) => `<form data-assign-replica="${esc(r.id)}"><label>${esc(space.hosts.find((h) => h.id === r.hostId)?.name ?? '')}<small>${esc(r.rootPath ?? '离线副本')}</small><select name="projectId" aria-label="副本所属项目">${space.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === r.projectId ? 'selected' : ''}>${esc(projectLabel(space, p.id))}</option>`).join('')}</select></label><button>保存归组</button></form>`).join('')}
    `
      : ''
  }<p id="manager-notice" role="status"></p><button id="close-workspace-dialog">完成</button>`;
  const submitForm = (
    selector: string,
    action: (data: Record<string, FormDataEntryValue>, form: HTMLFormElement) => Promise<void>,
  ) => {
    dialog.querySelectorAll<HTMLFormElement>(selector).forEach(
      (form) =>
        (form.onsubmit = (event) => {
          event.preventDefault();
          const fields = Object.fromEntries(new FormData(form));
          form.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = true));
          void action(fields, form)
            .catch((e) => {
              $('#manager-notice').textContent = e instanceof Error ? e.message : String(e);
            })
            .finally(() =>
              form
                .querySelectorAll<HTMLButtonElement>('button')
                .forEach((b) => (b.disabled = false)),
            );
        }),
    );
  };
  submitForm('#create-workspace', async (data) => {
    const created = await api('/api/workspaces', data);
    await loadDevices();
    await selectWorkspace(created.id);
    showWorkspaceManager();
  });
  const refresh = async () => {
    await loadDevices();
    await loadSessions();
    showWorkspaceManager();
  };
  submitForm('#rename-workspace', async (data) => {
    await api(`/api/workspaces/${space!.id}/rename`, data);
    await refresh();
  });
  submitForm('#create-project', async (data) => {
    await api(`/api/workspaces/${space!.id}/projects`, data);
    await refresh();
  });
  submitForm('[data-assign-replica]', async (data, form) => {
    await api(`/api/workspaces/${space!.id}/replicas/${form.dataset.assignReplica}/assign`, data);
    await refresh();
  });
  submitForm('[data-move-host]', async (data, form) => {
    await api(`/api/workspaces/${space!.id}/hosts/${form.dataset.moveHost}/move`, data);
    await refresh();
  });
  dialog.querySelectorAll<HTMLElement>('[data-revoke]').forEach(
    (button) =>
      (button.onclick = () =>
        run(async () => {
          if (!confirm('撤销这台电脑的远程访问授权？本地执行组件可继续使用。')) return;
          await api(`/api/devices/${button.dataset.revoke}/revoke`, {});
          await refresh();
        })),
  );
  $('#close-workspace-dialog').onclick = () => dialog.close();
  if (!dialog.open) dialog.showModal();
}
async function selectWorkspace(id: string, saved?: Partial<Selection>) {
  resetGitWorkspace();
  cancelAttachmentSave();
  const target = catalog.find((w) => w.id === id);
  if (!target) return;
  activeWorkspace = target;
  search = saved?.search ?? '';
  projectFilter = target.projects.some((p) => p.id === saved?.projectId) ? saved!.projectId! : '';
  selected = undefined;
  workspace = undefined;
  replica = undefined;
  sessionId = '';
  newProjectId = newAgentId = '';
  newSessionControlsReady = false;
  pending = undefined;
  pendingAction = undefined;
  actionError = '';
  archived = false;
  sessionGeneration++;
  renderNewSessionControls();
  renderDevices();
  renderNavigation();
  watch();
  const exactHost = target.hosts.find(
    (h) => h.deviceId === saved?.deviceId && h.runtimeWorkspaceId === saved?.workspaceId,
  );
  const host = exactHost ?? target.hosts[0];
  if (host)
    await selectDevice(host.deviceId, {
      ...(exactHost ? saved : {}),
      workspaceId: host.runtimeWorkspaceId,
      search,
      projectId: projectFilter,
    });
  else {
    sessionList = [];
    $('#composer').hidden = true;
    renderTarget();
    $('#history').textContent = '添加电脑后，可在这个工作区开始会话。';
    renderSessions();
    await persistSelection();
  }
}
async function persistSelection() {
  if (!activeWorkspace) return;
  const state: Selection = {
    deviceId: selected?.id ?? '',
    workspaceId: workspace?.id ?? '',
    sessionId,
    search,
    projectId: projectFilter,
    catalogWorkspaceId: activeWorkspace.id,
    replicaId: replica?.id,
  };
  await Promise.all([
    cache.write(owner + '/view', state),
    cache.write(owner + '/' + (selected?.id ?? activeWorkspace.id) + '/view', state),
  ]);
}
async function restoreSelection() {
  if (restoredSelection) return;
  restoredSelection = true;
  const generation = sessionGeneration;
  const saved = await cache.read<Selection>(owner + '/view');
  if (generation !== sessionGeneration) return;
  const space =
    catalog.find((w) => w.id === saved?.catalogWorkspaceId) ??
    catalog.find((w) =>
      w.hosts.some(
        (h) => h.deviceId === saved?.deviceId && h.runtimeWorkspaceId === saved?.workspaceId,
      ),
    ) ??
    catalog[0];
  if (space) await selectWorkspace(space.id, saved);
  else restoredSelection = false;
}
async function selectDevice(id: string, explicit?: Partial<Selection>) {
  resetGitWorkspace();
  cancelAttachmentSave();
  closeProjectContent();
  resetInteractions();
  sessionPersistenceError = '';
  volatileSessionDoc = undefined;
  restoredSelection = true;
  const generation = ++sessionGeneration;
  attachmentGeneration++;
  attachments = undefined;
  attachmentLoading = false;
  showAttachmentPreview(undefined);
  selectionLoading = generation;
  try {
    selected = devices.find((d) => d.id === id);
    workspace = undefined;
    replica = undefined;
    sessionId = '';
    newProjectId = newAgentId = '';
    newSessionControlsReady = false;
    renderNewSessionControls();
    watch();
    sessionList = [];
    meta = null;
    pending = undefined;
    doc = new LoroDoc();
    $('#composer').hidden = true;
    renderDevices();
    renderSessions();
    const saved = explicit ?? (await cache.read<Selection>(owner + '/' + id + '/view'));
    if (generation !== sessionGeneration) return;
    const binding =
      activeWorkspace?.hosts.find(
        (h) =>
          h.deviceId === id && (!saved?.workspaceId || h.runtimeWorkspaceId === saved.workspaceId),
      ) ?? activeWorkspace?.hosts.find((h) => h.deviceId === id);
    const target =
      binding &&
      resolveSelection(devices, {
        ...saved,
        deviceId: id,
        workspaceId: binding.runtimeWorkspaceId,
      });
    if (!target || target.workspace.id !== binding?.runtimeWorkspaceId) {
      renderNavigation();
      renderTarget();
      $('#history').textContent = '等待电脑上的执行组件启动并同步工作区…';
      await loadSessions();
      return;
    }
    selected = target.device;
    workspace = target.workspace;
    search = saved?.search ?? '';
    projectFilter = activeWorkspace?.projects.some((p) => p.id === saved?.projectId)
      ? saved!.projectId!
      : '';
    renderDevices();
    renderNavigation();
    await loadSessions(false);
    if (generation !== sessionGeneration) return;
    await openSession(target.sessionId, saved?.replicaId);
    if (authenticated) run(loadSessions);
  } finally {
    if (selectionLoading === generation) selectionLoading = 0;
  }
}
function currentActionScope() {
  if (!owner || !selected || !workspace || !replica || !sessionId) return undefined;
  return {
    owner,
    deviceId: selected.id,
    workspaceId: workspace.id,
    localProjectId: replica.localProjectId,
    sessionId,
  };
}
function canManageSession(row: SessionSummary) {
  const copy = activeWorkspace?.replicas.find((r) => r.id === row.replicaId);
  const host = activeWorkspace?.hosts.find((h) => h.id === copy?.hostId);
  const runtime = devices
    .find((d) => d.id === host?.deviceId)
    ?.workspaces.find((w) => w.id === host?.runtimeWorkspaceId);
  return !!(
    authenticated &&
    connected &&
    copy?.available &&
    host?.online &&
    runtime?.features?.includes('session-actions') &&
    !actionSending &&
    !pendingAction &&
    !sending &&
    !pending
  );
}
async function manageSession(row: SessionSummary, action: SessionAction['action'], title?: string) {
  actionError = '';
  try {
    if (!canManageSession(row)) throw new Error('请先连接支持会话管理的主机，并确认上一次操作。');
    if (sessionId !== row.id || replica?.id !== row.replicaId)
      await openSession(row.id, row.replicaId, action === 'rename');
    if (sessionId !== row.id || replica?.id !== row.replicaId) return;
    if (!canManageSession(row)) throw new Error('请先确认这段会话的上一次操作。');
    const scope = currentActionScope();
    if (!scope || !activeWorkspace || !replica) return;
    const base = {
      operationId: crypto.randomUUID(),
      workspaceId: scope.workspaceId,
      localProjectId: scope.localProjectId,
      sessionId: row.id,
      expectedRevision: row.metadataRevision ?? 0,
    };
    await submitSessionAction({
      owner,
      deviceId: scope.deviceId,
      catalogWorkspaceId: activeWorkspace.id,
      replicaId: replica.id,
      request: action === 'rename' ? { ...base, action, title: title ?? '' } : { ...base, action },
    });
  } catch (e) {
    actionError = e instanceof Error ? e.message : String(e);
    renderNavigation();
    throw e;
  }
}
async function submitSessionAction(operation: PendingSessionAction) {
  if (actionSending) return;
  if (!connected || !authenticated || !selected?.online)
    throw new Error('执行电脑离线，会话操作仍待手动确认。');
  const scope = currentActionScope();
  const operationKey = sessionActionKey(actionScope(operation));
  if (!scope || sessionActionKey(scope) !== operationKey)
    throw new Error('请打开原会话，再重试确认这次操作。');
  if (!activeWorkspace || !replica || !replica.available)
    throw new Error('原会话的项目副本不可达，请恢复连接后手动重试。');
  const routed = routeSessionAction(operation, {
    ...scope,
    catalogWorkspaceId: activeWorkspace.id,
    replicaId: replica.id,
  });
  const isCurrent = () => {
    const current = currentActionScope();
    return current && sessionActionKey(current) === operationKey;
  };
  const requestedOwner = owner;
  actionSending = true;
  actionError = '';
  renderNavigation();
  updateComposer();
  try {
    const confirmed = await deliverSessionAction(routed, {
      write: cache.write,
      request: api,
      onPending: (value) => {
        if (isCurrent()) pendingAction = value;
      },
    });
    if (owner !== requestedOwner) return;
    listGeneration++;
    const summary = confirmed as SessionSummary;
    sessionList = sessionList.map((row) =>
      row.id === summary.id &&
      row.replicaId === routed.replicaId &&
      (row.metadataRevision ?? 0) <= summary.metadataRevision!
        ? { ...row, ...summary }
        : row,
    );
    if (isCurrent()) {
      if ((meta?.metadataRevision ?? 0) <= summary.metadataRevision!)
        meta = { ...meta, ...confirmed };
      await loadSession().catch(error);
      if (isCurrent() && ['archive', 'restore'].includes(operation.request.action))
        archived = meta?.isArchived === true;
    }
    await loadSessions();
  } catch (e) {
    if (isCurrent()) {
      actionError = e instanceof Error ? e.message : String(e);
      // A rejected revision must be refreshed before a new manual decision.
      if (e instanceof ApiError && e.rejected) {
        await loadSession().catch(error);
        await loadSessions();
      }
    }
    throw e;
  } finally {
    actionSending = false;
    renderSessions();
    updateComposer();
  }
}
function renderSessionActionState() {
  const container = document.querySelector<HTMLElement>('#session-action-state');
  if (!container) return;
  const names = {
    rename: '重命名',
    archive: '归档',
    restore: '恢复',
    pin: '置顶',
    unpin: '取消置顶',
  };
  const message = actionSending
    ? '正在等待主机确认会话操作…'
    : pendingAction
      ? `${names[pendingAction.request.action]}结果待确认，请手动重试。`
      : meta?.isArchived
        ? '会话已归档。恢复后可继续，原草稿保留。'
        : '';
  container.hidden = !message;
  const actionButton =
    !actionSending && pendingAction
      ? '<button type="button" data-retry-session-action>重试确认</button>'
      : !actionSending && meta?.isArchived
        ? '<button type="button" data-restore-session>恢复会话</button>'
        : '';
  renderInto('#session-action-state', `<span>${esc(message)}</span>${actionButton}`);
  const retry = container.querySelector<HTMLButtonElement>('[data-retry-session-action]');
  if (retry) {
    retry.disabled = !authenticated || !connected || !selected?.online;
    retry.onclick = () => run(() => submitSessionAction(pendingAction!));
  }
  const restore = container.querySelector<HTMLButtonElement>('[data-restore-session]');
  if (restore) {
    const row = sessionList.find((r) => r.id === sessionId && r.replicaId === replica?.id);
    restore.disabled = !row || !canManageSession(row);
    restore.onclick = () => row && run(() => manageSession(row, 'restore'));
  }
}
function renderNavigation() {
  showNavigation({
    catalog,
    space: activeWorkspace,
    projectLabels: Object.fromEntries(
      activeWorkspace?.projects.map((p) => [p.id, projectLabel(activeWorkspace!, p.id)]) ?? [],
    ),
    list: filterCatalogSessions(sessionList, activeWorkspace, search, projectFilter, archived),
    archived,
    onArchived: (value) => {
      archived = value;
      renderNavigation();
    },
    listLoading,
    listError,
    actionPending: actionSending,
    actionError,
    actionSession: sessionList.find((row) => row.id === sessionId && row.replicaId === replica?.id),
    canManage: canManageSession,
    onAction: (row, action, title) => run(() => manageSession(row, action, title)),
    projectFilter,
    search,
    selectedSession: sessionId,
    selectedReplica: replica?.id,
    deviceId: selected?.id,
    runtimeWorkspaceId: workspace?.id,
    connected,
    localOnly,
    canCreate: !!workspace,
    onWorkspace: (id) => run(() => selectWorkspace(id)),
    onHost: (id) =>
      run(async () => {
        const host = activeWorkspace?.hosts.find((h) => h.id === id);
        if (host)
          await selectDevice(host.deviceId, {
            workspaceId: host.runtimeWorkspaceId,
            sessionId: '',
            search,
            projectId: projectFilter,
          });
      }),
    onSearch: (value) => {
      search = value;
      renderNavigation();
      run(persistSelection);
    },
    onProject: (value) => {
      projectFilter = value;
      renderNavigation();
      run(persistSelection);
    },
    onSession: (id, copy) => run(() => openSession(id, copy)),
    onNew: newSession,
    onManage: showWorkspaceManager,
    onPair: pairComputer,
    onLogout: logout,
    onNotifications: openNotifications,
  });
}

async function loadSessions(refresh = true) {
  if (!activeWorkspace) return;
  const space = activeWorkspace,
    generation = sessionGeneration,
    requestedOwner = owner,
    requestGeneration = ++listGeneration;
  listLoading = true;
  listError = '';
  renderNavigation();
  let unavailable = 0;
  // Bound concurrency; every host returns its own index, which stays in browser cache.
  const rows: SessionSummary[][] = [];
  for (let i = 0; i < space.hosts.length; i += 4) {
    rows.push(
      ...(await Promise.all(
        space.hosts.slice(i, i + 4).map(async (host) => {
          const listKey = [requestedOwner, host.deviceId, host.runtimeWorkspaceId, 'list'].join(
            '/',
          );
          let list: SessionSummary[];
          try {
            if (!refresh || !authenticated || !host.online) throw new Error('offline');
            list = await api(`/api/workspaces/${space.id}/hosts/${host.id}/sessions`);
            await cache.write(listKey, list);
          } catch {
            unavailable++;
            list = (await cache.read<SessionSummary[]>(listKey).catch(() => undefined)) ?? [];
          }
          return catalogSessionList(list, space, host.id);
        }),
      )),
    );
  }
  if (
    activeWorkspace !== space ||
    generation !== sessionGeneration ||
    owner !== requestedOwner ||
    requestGeneration !== listGeneration
  )
    return;
  listLoading = false;
  listError = unavailable ? '部分电脑不可达，显示本机已缓存的会话。' : '';
  sessionList = rows.flat();
  renderSessions();
}
function renderSessions() {
  renderNavigation();
  renderTarget();
}

async function openSession(id: string, replicaId?: string, keepNavigation = false) {
  resetGitWorkspace();
  cancelAttachmentSave();
  showAttachmentPreview(undefined);
  closeProjectContent();
  resetInteractions();
  sessionPersistenceError = '';
  volatileSessionDoc = undefined;
  const row = sessionList.find(
    (s) =>
      s.id === id &&
      (replicaId
        ? s.replicaId === replicaId
        : activeWorkspace?.replicas.find((r) => r.id === s.replicaId)?.hostId ===
          activeWorkspace?.hosts.find(
            (h) => h.deviceId === selected?.id && h.runtimeWorkspaceId === workspace?.id,
          )?.id),
  );
  const target = activeWorkspace?.replicas.find(
    (r) => r.id === (replicaId || row?.replicaId || (id ? replica?.id : undefined)),
  );
  if (id && !target) throw new Error('该会话的项目副本不可用，请从会话列表重新选择。');
  if (id && target) {
    const host = activeWorkspace!.hosts.find((h) => h.id === target.hostId)!;
    selected = devices.find((d) => d.id === host.deviceId);
    workspace = selected?.workspaces.find((w) => w.id === host.runtimeWorkspaceId);
    replica = target;
  }
  if (!workspace) return;
  if (!id) replica = undefined;
  renderDevices();
  rendered.delete($('#history'));
  const generation = ++sessionGeneration;
  runOptionsReady = false;
  runOptionsGeneration++;
  sessionId = id;
  newProjectId = newAgentId = '';
  newSessionControlsReady = false;
  renderNewSessionControls();
  if (!keepNavigation) closeNavigation();
  void persistSelection().catch(error);
  doc = new LoroDoc();
  flock = new Flock();
  meta = null;
  pendingAction = undefined;
  actionError = '';
  const restored = await cache.read<Mutation>(key('pending'));
  if (generation !== sessionGeneration) return;
  pending = restored;
  const scope = currentActionScope();
  if (scope) {
    const saved = await cache.read<PendingSessionAction>(sessionActionKey(scope));
    if (generation !== sessionGeneration) return;
    if (saved) {
      const parsed = pendingSessionActionSchema.parse(saved);
      if (sessionActionKey(actionScope(parsed)) !== sessionActionKey(scope))
        throw new Error('待确认操作的会话范围不匹配，请重新打开原会话。');
      pendingAction = parsed;
    }
  }
  renderSessions();
  renderTarget();
  $<HTMLFormElement>('#composer').hidden = false;
  const draft = await cache.read<string>(key('draft'));
  if (generation !== sessionGeneration) return;
  $<HTMLTextAreaElement>('#prompt').value = draft ?? '';
  resizeComposer();
  let pendingProject: string | undefined;
  if (!id) {
    const options = await cache.read<{ project: string; agent: string }>(key('options'));
    if (generation !== sessionGeneration) return;
    const filtered = activeWorkspace?.replicas.find(
      (r) =>
        r.projectId === projectFilter &&
        activeWorkspace?.hosts.some(
          (h) =>
            h.id === r.hostId &&
            h.deviceId === selected?.id &&
            h.runtimeWorkspaceId === workspace?.id,
        ),
    );
    const pendingMeta = new Flock();
    if (pending?.metaBundle) pendingMeta.importJson(pending.metaBundle as never);
    const pendingAgent = pending
      ? metas(pendingMeta)['session-' + pending.sessionId]?.agentConfigId
      : undefined;
    pendingProject = pending
      ? (metas(pendingMeta)['session-' + pending.sessionId]?.project as any)?.localProjectId
      : undefined;
    const project = pendingProject || filtered?.localProjectId || options?.project;
    newProjectId = workspace.projects.some((p) => p.id === project)
      ? project!
      : (workspace.projects[0]?.id ?? '');
    const agentId = pendingAgent || options?.agent;
    newAgentId = workspace.agents.some((a) => a.id === agentId)
      ? String(agentId)
      : (workspace.agents[0]?.id ?? '');
    newSessionControlsReady = true;
  }
  if (!id) selectReplica(pendingProject);
  watch();
  if (id) {
    const saved = await cache.read<any>(key('session'));
    if (generation !== sessionGeneration) return;
    if (saved) {
      doc.import(decode(saved.snapshot));
      flock.importJson(saved.metaBundle);
      meta = saved.meta;
      if (meta?.isArchived && !keepNavigation) archived = true;
      renderHistory();
    } else
      $('#history').textContent =
        authenticated && selected?.online
          ? '正在读取会话…'
          : '当前设备尚未缓存这段会话，连接执行电脑后可读取。';
    try {
      await loadSession();
    } catch (e) {
      if (generation !== sessionGeneration) return;
      if (!saved) $('#history').textContent = '执行电脑不可达，当前设备尚未缓存这段会话。';
      error(e);
    }
  } else
    $('#history').innerHTML =
      '<div class="welcome compact"><h1>今天，我们从哪里开始？</h1><p>选择项目和 Agent，让想法继续向前。</p></div>';
  if (generation !== sessionGeneration) return;
  if (id && meta?.isArchived) {
    archived = true;
    renderNavigation();
  }
  await restoreRunOptions();
  if (generation !== sessionGeneration) return;
  await loadAttachmentDraft();
  if (generation !== sessionGeneration) return;
  await loadInteractionDraft();
  updateComposer();
}
async function loadSession() {
  const generation = sessionGeneration,
    id = sessionId,
    readGeneration = ++sessionReadGeneration,
    fullRead = volatileSessionDoc !== undefined;
  if (!id || !authenticated || !selected?.online) return;
  const data = await api(
    prefix() +
      '/sessions/' +
      id +
      query() +
      (fullRead ? '' : '&version=' + encodeURIComponent(vv(doc))),
  );
  if (
    generation !== sessionGeneration ||
    readGeneration !== sessionReadGeneration ||
    (!fullRead && (data.meta?.metadataRevision ?? 0) < (meta?.metadataRevision ?? 0))
  )
    return;
  const persisted = data.persisted !== false && !data.persistenceError;
  if (persisted) {
    // Following a volatile read, the host may have restarted at its last durable
    // state. CRDT merge cannot remove abandoned operations: replace both stores
    // from the explicitly requested full response instead.
    if (fullRead) {
      doc = new LoroDoc();
      flock = new Flock();
    }
    if (data.update) doc.import(decode(data.update));
    flock.importJson(data.metaBundle);
    volatileSessionDoc = undefined;
  } else {
    const display = new LoroDoc();
    if (!fullRead) display.import(doc.export({ mode: 'snapshot' }));
    if (data.update) display.import(decode(data.update));
    volatileSessionDoc = display;
  }
  meta = data.meta;
  renderTarget();
  sessionPersistenceError = persisted
    ? ''
    : '执行电脑尚未保存本次输出。当前内容只在主机内存中，请保留执行组件并检查磁盘或数据库状态；暂不能发送新指令。';
  if (persisted)
    await cache.write(key('session'), {
      snapshot: encode(doc.export({ mode: 'snapshot' })),
      metaBundle: flock.exportJson(),
      meta,
    });
  if (generation !== sessionGeneration) return;
  if (!data.synced && persisted)
    $('#history').textContent = '执行电脑不可达；本机尚未缓存这段历史。';
  else renderHistory();
  updateComposer();
}
function renderHistory() {
  const view = mirror(volatileSessionDoc ?? doc, sessionId),
    state = view.getState();
  const container = $('#history'),
    atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  const html =
    state.history
      .map(
        (turn) =>
          `<article class="turn ${turn.role}" data-search-turn="${esc(turn.id)}"><div class="turn-label">${turn.role === 'user' ? '你' : esc(meta?.agentType ?? 'Agent')} <time>${new Date(turn.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>${(
            turn.items ?? []
          )
            .map(
              (item: any, index: number) =>
                `<div data-search-item="${index}">${renderInteractionItem(item, `${turn.id}/${index}`) ?? renderItem(item, !!turn.finished, `${turn.id}/${index}`)}</div>`,
            )
            .join(
              '',
            )}${renderFileChanges(turn.fileDiff, turn.id + '/files')}${turn.role === 'assistant' && workspace?.features?.includes(PROJECT_DIFF_FEATURE) ? `<button type="button" class="project-turn-open" data-project-turn="${esc(turn.id)}">查看回合文件变更</button>` : ''}${turn.role === 'assistant' && turn.finished && workspace?.features?.includes(SESSION_FORK_FEATURE) ? `<button type="button" class="project-turn-open" data-fork-turn="${esc(turn.id)}">从此回合创建副本</button>` : ''}${turn.role === 'assistant' && !turn.finished ? '<span class="working">Agent 正在处理</span>' : ''}</article>`,
      )
      .join('') || '<p class="empty">会话已建立，等待第一条消息。</p>';
  const expanded = new Map(
    Array.from(container.querySelectorAll<HTMLDetailsElement>('details[data-detail]')).map((el) => [
      el.dataset.detail,
      el.open,
    ]),
  );
  renderInto('#history', html);
  container.querySelectorAll<HTMLDetailsElement>('details[data-detail]').forEach((el) => {
    if (expanded.has(el.dataset.detail)) el.open = expanded.get(el.dataset.detail)!;
  });
  container.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((button) => {
    button.onclick = () =>
      run(async () => {
        const text = button.closest('.code-block')?.querySelector('code')?.textContent ?? '';
        await navigator.clipboard.writeText(text);
        button.textContent = '已复制';
      });
  });
  container.querySelectorAll<HTMLButtonElement>('[data-project-turn]').forEach((button) => {
    button.onclick = () => run(() => openProjectContent('changes', button.dataset.projectTurn));
  });
  container.querySelectorAll<HTMLButtonElement>('[data-fork-turn]').forEach((button) => {
    const generation = sessionGeneration;
    button.onclick = () =>
      run(async () => {
        if (generation === sessionGeneration) await openSessionFork(button.dataset.forkTurn);
      });
  });
  container.querySelectorAll<HTMLButtonElement>('[data-open-question]').forEach((button) => {
    const item = interactionSnapshot().questions.find(
      (item) => questionDraftKey(item.request) === button.dataset.openQuestion,
    );
    button.disabled = !item;
    button.onclick = () => {
      if (item) openQuestion(item);
    };
  });
  const references: AttachmentReference[] = [];
  for (const turn of state.history)
    for (const item of turn.items ?? []) {
      const value = item as any;
      for (const candidate of [
        value.attachment,
        ...(Array.isArray(value.content)
          ? value.content.map((entry: any) => entry.attachment ?? entry.content?.attachment)
          : []),
      ]) {
        const parsed = attachmentReferenceSchema.safeParse(candidate);
        if (parsed.success) references.push(parsed.data);
      }
    }
  container.querySelectorAll<HTMLButtonElement>('[data-open-attachment]').forEach((button) => {
    const reference = references.find(
      (value) => value.attachmentId === button.dataset.openAttachment,
    );
    button.disabled = !reference;
    button.onclick = () => reference && run(() => openHistoryAttachment(reference));
  });
  view.dispose();
  document.querySelectorAll<HTMLElement>('[data-permission]').forEach((el) => {
    el.toggleAttribute('disabled', sending || !!pending || !connected || !selected?.online);
    el.onclick = () => run(() => respondPermission(el.dataset.permission!, el.dataset.option!));
  });
  if (atBottom) container.scrollTop = container.scrollHeight;
}
let runSelection: RunSelection = {},
  runOptionsLoading = false,
  runOptionsReady = false;
let runOptionsGeneration = 0;
let runSelectionTouched = false;
const capabilityAttempts = new Set<string>();
function currentAgent() {
  return workspace?.agents.find((a) => a.id === (meta?.agentConfigId ?? newAgentId));
}
function runOptionsKey() {
  return key('run-options') + '/' + currentAgent()?.id;
}
function currentRunInput() {
  const candidate = new LoroDoc();
  candidate.import(doc.export({ mode: 'snapshot' }));
  if (pending?.kind === 'turn') candidate.import(decode(pending.update));
  const view = mirror(candidate, pending?.sessionId || sessionId || 'new');
  const state = view.getState();
  const latest = state.history.findLast((t) => t.role === 'user');
  const input = latest?.inputConfig as
    | { modelId?: string; modeId?: string; configOptionValues?: unknown }
    | undefined;
  const result = { base: latest?.id ?? '', input: structuredClone(input) };
  view.dispose();
  return result;
}
async function restoreRunOptions() {
  const generation = ++runOptionsGeneration,
    session = sessionGeneration;
  runOptionsReady = false;
  runOptionsLoading = false;
  updateComposer();
  const current = currentRunInput();
  const saved = await cache.read<{ base: string; selection: RunSelection }>(runOptionsKey());
  if (generation !== runOptionsGeneration || session !== sessionGeneration) return;
  runSelectionTouched = !pending && saved?.base === current.base;
  runSelection =
    !pending && saved?.base === current.base
      ? saved.selection
      : selectionFromInput(current.input, currentAgent()?.runConfig);
  runOptionsReady = true;
  updateComposer();
  const attempt = [owner, selected?.id, workspace?.id, currentAgent()?.id].join('/');
  if (
    !currentAgent()?.runConfig &&
    currentAgent() &&
    connected &&
    selected?.online &&
    replica?.available &&
    !pending &&
    !capabilityAttempts.has(attempt)
  ) {
    capabilityAttempts.add(attempt);
    void refreshRunOptions().catch(error);
  }
}
async function refreshRunOptions() {
  const agent = currentAgent();
  if (!agent || runOptionsLoading || pending || sending) return;
  const generation = runOptionsGeneration,
    session = sessionGeneration;
  runOptionsLoading = true;
  updateComposer();
  try {
    const updated = agentSchema.parse(
      await api(prefix() + '/agent-options', { agentId: agent.id }),
    );
    if (
      generation !== runOptionsGeneration ||
      session !== sessionGeneration ||
      currentAgent()?.id !== agent.id
    )
      return;
    Object.assign(currentAgent()!, updated);
    // Recover an effort field from the saved native turn when capabilities were initially unavailable.
    if (!runSelectionTouched && !pending && !runSelection.reasoningEffort) {
      const inherited = selectionFromInput(currentRunInput().input, updated.runConfig);
      if (inherited.modelId === runSelection.modelId)
        runSelection.reasoningEffort = inherited.reasoningEffort;
    }
  } finally {
    if (generation === runOptionsGeneration && session === sessionGeneration) {
      runOptionsLoading = false;
      updateComposer();
    }
  }
}
function renderRunOptions() {
  const capabilities = currentAgent()?.runConfig;
  let validation = '';
  try {
    resolveRunSelection(runSelection, capabilities);
  } catch (e) {
    validation = (e as Error).message;
  }
  showRunControls({
    capabilities,
    selection: runSelection,
    agentType: currentAgent()?.agentType,
    disabled: sending || !!pending || attachmentWorking || runOptionsLoading || !runOptionsReady,
    loading: runOptionsLoading,
    canRefresh: connected && !!selected?.online && !!replica?.available,
    validation,
    existing: !!sessionId,
    onChange: (property, value) => {
      runSelectionTouched = true;
      runSelection = { ...runSelection, [property]: value || undefined };
      if (
        property === 'modelId' &&
        !capabilities?.models
          .find((m) => m.id === runSelection.modelId)
          ?.efforts.includes(runSelection.reasoningEffort ?? '')
      )
        runSelection.reasoningEffort = undefined;
      void cache
        .write(runOptionsKey(), { base: currentRunInput().base, selection: { ...runSelection } })
        .catch(error);
      updateComposer();
    },
    onRefresh: () => run(refreshRunOptions),
  });
  return !!validation;
}

function updateComposer() {
  renderGitWorkspace();
  renderSessionFork();
  const persistenceState = document.querySelector('#session-persistence-state');
  if (persistenceState) {
    persistenceState.textContent = sessionPersistenceError;
    persistenceState.toggleAttribute('hidden', !sessionPersistenceError);
  }
  renderAttachmentControls();
  renderInteractions();
  renderSessionActionState();
  const invalidRunOptions = renderRunOptions();
  renderNewSessionControls();
  document
    .querySelectorAll<HTMLButtonElement>('[data-permission]')
    .forEach((b) => (b.disabled = sending || !!pending || !connected || !selected?.online));
  const create = document.querySelector<HTMLButtonElement>('#new');
  if (create) create.disabled = !workspace;
  const send = document.querySelector<HTMLButtonElement>('#send');
  if (!send) return;
  send.disabled =
    sending ||
    gitBlocksComposer() ||
    forkBlocksComposer() ||
    (!!sessionPersistenceError && !pending) ||
    !!interactionLoadError ||
    interactionLoading ||
    !!currentInteractions()?.busy ||
    !!currentInteractions()?.pending ||
    !!attachmentLoadError ||
    attachmentLoading ||
    attachmentWorking ||
    !!currentAttachments()?.busyId ||
    currentAttachments()?.items.some((item) => !!item.pending) === true ||
    currentAttachments()?.items.some(
      (item) => !!attachmentInputReason(item.reference, currentAgent()?.inputCapabilities),
    ) === true ||
    actionSending ||
    !!pendingAction ||
    (!!meta?.isArchived && !pending) ||
    !connected ||
    !selected?.online ||
    !replica?.available ||
    (!pending &&
      (!runOptionsReady ||
        runOptionsLoading ||
        invalidRunOptions ||
        !currentAgent() ||
        (!sessionId && !workspace?.projects.length)));
  sendIcon(sending ? 'sending' : pending ? 'pending' : 'ready');
  send.setAttribute('aria-label', sending ? '提交中' : pending ? '重试确认' : '发送指令');
  send.classList.toggle('pending', !!pending);
  $<HTMLTextAreaElement>('#prompt').readOnly = sending || !!pending || attachmentWorking;
  const state = document.querySelector('#draft-state');
  if (state)
    state.textContent = forkBlocksComposer()
      ? '请先在会话副本中确认原 Fork 操作'
      : gitBlocksComposer()
        ? currentGitWorkspace()?.execution?.status === 'removed'
          ? currentGitWorkspace()?.execution?.disposition === 'detached'
            ? '此会话已脱离共享目录，请创建另一份新会话'
            : '工作目录已清理，请创建另一份新会话'
          : '请先在 Git 与工作目录中确认原操作'
        : pending
          ? '提交结果待确认，重试会使用同一编号'
          : !connected || !selected?.online
            ? '执行电脑离线 · 输入保留为草稿'
            : '';
  if (state) state.toggleAttribute('hidden', !state.textContent);
  let active = false;
  if (sessionId) {
    const v = mirror(volatileSessionDoc ?? doc, sessionId);
    active = v.getState().history.some((t) => t.role === 'assistant' && !t.finished);
    v.dispose();
  }
  if (active && !pending) send.disabled = true;
  if (active && state && !pending && selected?.online && connected) {
    state.textContent = 'Agent 正在处理 · 下一条指令保留为草稿';
    state.removeAttribute('hidden');
  }
  $<HTMLButtonElement>('#cancel').hidden = !active;
  $<HTMLButtonElement>('#cancel').disabled = !connected || !selected?.online;
}
async function submit(m: Mutation) {
  if (sending) return;
  const generation = sessionGeneration,
    pendingKey = key('pending'),
    draftKey = key('draft'),
    endpoint = prefix() + '/mutations' + query();
  const attachmentController = currentAttachments();
  const creatingSession = !sessionId;
  pending = m;
  sending = true;
  updateComposer();
  let durable = false;
  try {
    await cache.write(pendingKey, m);
    durable = true;
    const confirmation = await api(endpoint, m);
    if (
      confirmation?.accepted !== true ||
      confirmation.delivered !== true ||
      confirmation.operationId !== m.operationId
    )
      throw new Error('指令尚未获得有效的主机确认，请使用原请求手动重试。');
    if (m.kind === 'turn' && attachmentController?.scope.sessionId === m.sessionId) {
      await attachmentController.forget(
        attachmentController.items.map((item) => item.reference.attachmentId),
      );
      if (creatingSession) {
        const savedKey = draftAttachmentSessionKey(attachmentController.scope);
        if ((await cache.read(savedKey)) === m.sessionId) await cache.write(savedKey, undefined);
      }
    }
    await cache.write(pendingKey, undefined);
    if (m.kind === 'turn') await cache.write(draftKey, '');
    if (generation !== sessionGeneration) return;
    pending = undefined;
    if (m.kind === 'turn') $<HTMLTextAreaElement>('#prompt').value = '';
    await openSession(m.sessionId);
    await loadSessions();
  } catch (e) {
    // Only an explicit rejection from the host proves this operation was never staged.
    // Relay offline/timeout errors cannot invalidate the original operation id.
    if (!durable || (e instanceof ApiError && e.rejected)) {
      await cache.write(pendingKey, undefined);
      if (generation === sessionGeneration) pending = undefined;
    }
    throw e;
  } finally {
    sending = false;
    updateComposer();
  }
}
async function sendTurn() {
  if (forkBlocksComposer()) throw new Error('请先在会话副本中确认原 Fork 操作。');
  if (gitBlocksComposer())
    throw new Error(gitLoadError || '请先在 Git 与工作目录中确认当前目录状态。');
  if (attachmentLoadError) throw new Error(attachmentLoadError);
  if (attachmentLoading || attachmentWorking || currentAttachments()?.busyId)
    throw new Error('请等待附件操作完成。');
  if (actionSending || pendingAction) throw new Error('请先确认会话管理操作。');
  if (pending) {
    await submit(pending);
    return;
  }
  if (sessionPersistenceError) throw new Error(sessionPersistenceError);
  if (interactionLoadError) throw new Error(interactionLoadError);
  if (interactionLoading || currentInteractions()?.busy || currentInteractions()?.pending)
    throw new Error('请先确认或关闭原交互记录。');
  if (meta?.isArchived) throw new Error('请先恢复会话，再发送新的指令。');
  if (!workspace || !selected?.online || !connected) throw new Error('执行电脑离线，草稿已保留');
  const prompt = $<HTMLTextAreaElement>('#prompt').value.trim();
  const attachmentController = currentAttachments();
  if (!prompt && !attachmentController?.items.length) return;
  const generation = sessionGeneration;
  if (!sessionId)
    await cache.write(key('options'), {
      project: newProjectId,
      agent: newAgentId,
    });
  if (generation !== sessionGeneration) return;
  const id = sessionId || attachmentController?.scope.sessionId || crypto.randomUUID(),
    agent = currentAgent();
  if (!agent) throw new Error('这台电脑还没有可用的 Agent 配置');
  if (!runOptionsReady || runOptionsLoading) throw new Error('正在读取运行设置，请稍后发送');
  const selectedConfig = resolveRunSelection(runSelection, agent.runConfig);
  if (attachmentController?.items.length) {
    if (attachmentController.items.some((item) => item.pending))
      throw new Error('附件结果待确认，请先手动重试。');
    assertAttachmentOnline();
    for (const item of attachmentController.items) {
      const why = attachmentInputReason(item.reference, agent.inputCapabilities);
      if (why) throw new Error(why);
    }
    attachmentWorking = true;
    updateComposer();
    try {
      for (const item of attachmentController.items)
        if (!item.uploaded) {
          if (generation !== sessionGeneration) return;
          await attachmentController.upload(
            item.reference.attachmentId,
            attachmentTarget(attachmentController),
          );
        }
    } finally {
      attachmentWorking = false;
      updateComposer();
    }
    if (generation !== sessionGeneration) return;
  }
  const attached = attachmentController?.references() ?? [];
  const candidate = new LoroDoc();
  candidate.import(doc.export({ mode: 'snapshot' }));
  const localFlock = Flock.fromJson(
    flock.exportJson(),
    crypto.randomUUID().replaceAll('-', '').slice(0, 16),
  );
  const before = vv(candidate),
    metaVersion = localFlock.version(),
    view = mirror(candidate, id),
    turnId = crypto.randomUUID(),
    now = new Date().toISOString();
  const inputConfig = {
    ...selectedConfig,
    prompt,
    cliType: agent.cliType,
    agentType: agent.agentType,
    mcpServerIds: [],
    taskToolsEnabled: false,
    ...(attached.length ? { attachments: attached } : {}),
  };
  view.setState((s: any) => {
    s.history.push({
      id: turnId,
      role: 'user',
      userId: workspace!.userId,
      timestamp: now,
      status: 'pending',
      finished: true,
      inputConfig,
      items: [
        { type: 'text', text: prompt },
        ...attached.map((attachment) => ({ type: 'attachment', attachment })),
      ],
      fileDiff: null,
    });
  });
  view.dispose();
  candidate.commit();
  const fields = meta
    ? { latestUserMsgId: turnId, lastMessageAt: Date.now() }
    : {
        id,
        machineId: workspace.machineId,
        userId: workspace.userId,
        createdAt: now,
        title: prompt.slice(0, 60) || attached[0]?.name || '新会话',
        titleSource: 'user',
        cliType: agent.cliType,
        agentType: agent.agentType,
        agentConfigId: agent.id,
        status: { type: 'idle' },
        isArchived: false,
        project: { kind: 'local', localProjectId: newProjectId },
        latestUserMsgId: turnId,
        lastMessageAt: Date.now(),
      };
  putMeta(localFlock, 'session-' + id, fields);
  await submit({
    operationId: crypto.randomUUID(),
    workspaceId: workspace.id,
    sessionId: id,
    kind: 'turn',
    expectedTurnId: meta?.latestUserMsgId ?? null,
    update: delta(candidate, before),
    metaBundle: localFlock.exportJson(metaVersion),
  });
}
async function respondPermission(requestId: string, optionId: string) {
  if (sending || pending) throw new Error('请先确认上一次提交结果');
  if (!connected || !selected?.online) throw new Error('执行电脑离线，无法提交审批');
  const candidate = new LoroDoc();
  candidate.import(doc.export({ mode: 'snapshot' }));
  const before = vv(candidate),
    view = mirror(candidate, sessionId);
  view.setState((s: any) => {
    for (const t of s.history)
      for (const item of t.items ?? [])
        if (item.permissionRequest?.requestId === requestId)
          item.permissionRequest.outcome = optionId
            ? { outcome: 'selected', optionId }
            : { outcome: 'cancelled' };
  });
  view.dispose();
  candidate.commit();
  await submit({
    operationId: crypto.randomUUID(),
    workspaceId: workspace!.id,
    sessionId,
    kind: 'permission',
    expectedTurnId: meta.latestUserMsgId ?? null,
    requestId,
    update: delta(candidate, before),
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && owner) {
    if (!authenticated) {
      run(() => boot());
      return;
    }
    if (!events || events.readyState > WebSocket.OPEN) connect();
    else
      run(async () => {
        await loadDevices();
        if (sessionId) await loadSession();
      });
  }
});
window.addEventListener('online', () => {
  if (owner) {
    if (authenticated) connect();
    else run(() => boot());
  }
});
