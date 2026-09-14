import { createPortal } from 'react-dom';
import { WorkspaceToolMenu } from './workspace-layout';
import {
  SessionTimeline,
  SessionInformation,
  hasTurnFileChanges,
  turnFileChanges,
} from './session-timeline';
import { GitFork } from 'lucide-react';
import { SESSION_FORK_FEATURE } from '../fork-protocol';
import { PROJECT_DIFF_FEATURE } from '../project-content-protocol';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleStart } from './google-login';
import { RunControls } from './ui';
import { resolveRunSelection } from '../run-config';
import { AGENT_MODEL_OPTIONS_FEATURE } from '../protocol';
import {
  SecureWorkspaceController,
  type SecureWorkspaceState,
  type SecurePermissionReview,
} from './secure-controller';
import type {
  DesktopSecureRequest,
  DesktopSecureStatus,
} from '../security/desktop-client-protocol';
import type { RootPublicJwk } from '../security/e2ee-trust';
import { productCanonicalJson } from '../security/encrypted-product-catalog';
import { PERMISSION_REVIEW_FEATURE } from '../permission-review';
import { ATTACHMENTS_FEATURE } from '../attachment-protocol';
import { ATTACHMENT_OPERATIONS_FEATURE } from '../session-control-protocol';
import { SKILLS_FEATURE } from '../skills-protocol';
import { MCP_FEATURE } from '../mcp-protocol';
import { SECURE_TURN_AUTHORITY_FEATURE } from '../task-protocol';
import { SecureSkillsUI, type SecureSkillsUiHandle } from './secure-skills-ui';
import { SecureMcpUI, SecureMcpDraftCard, type SecureMcpUiHandle } from './secure-mcp-ui';
import { SecureGithubUI, type SecureGithubUiHandle } from './secure-github-ui';
import { SecureGitUI, type SecureGitUiHandle } from './secure-git-ui';
import { SecureForkUI, type SecureForkUiHandle } from './secure-fork-ui';
import { sameSecureRuntime } from './secure-scoped-storage';
import {
  SecurePreviewUI,
  SecurePreviewDraftCards,
  type SecurePreviewUiHandle,
} from './secure-preview-ui';
import type { AttachmentReference } from '../content-protocol';
import type { SecureCliTarget } from '../cli/secure-operation';
import type { SecureAttachmentDraft } from './secure-attachments';
import {
  SecureContentUI,
  SecureAttachmentCard,
  SecureAttachmentControls,
  secureAttachmentInputReason,
  type SecureContentUiHandle,
} from './secure-content-ui';

export type Account = {
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
  | 'refreshAgentOptions'
  | 'createSession'
  | 'send'
  | 'respondPermission'
  | 'contentContext'
  | 'contentRequest'
  | 'readAttachment'
  | 'addAttachments'
  | 'removeAttachment'
  | 'stop'
  | 'metadata'
  | 'recover'
  | 'refreshOperations'
  | 'saveDraft'
  | 'appendInstruction'
  | 'readMcpCatalog'
  | 'applyMcp'
  | 'extensionStorage'
  | 'previewAnnotations'
  | 'scopedRequest'
  | 'beforeExtensionWrite'
  | 'beforeWorkspaceWrite'
  | 'workspaceResourceRequest'
  | 'beforeWorkspaceResourceWrite'
  | 'openForkChild'
  | 'openForkSource'
  | 'refreshExtensionRecords'
  | 'updatePreviewAnnotations'
  | 'addPreviewImage'
  | 'removePreviewSelection'
  | 'close'
  | 'invalidate'
> &
  Partial<Pick<SecureWorkspaceController, 'saveRunSelection'>>;
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
  abandoned: '主机已确认封存',
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
function sessionOperations(state: SecureWorkspaceState) {
  const session = state.session;
  const device = state.status?.device;
  const replica = state.catalog?.products.replicas.find((entry) => entry.id === state.replicaId);
  if (!session || !device || !('deviceId' in device)) return [];
  return state.operations.filter(
    (operation) =>
      operation.target.origin === device.pin.serverOrigin &&
      operation.target.owner === device.pin.accountId &&
      operation.target.rootKeyId === device.pin.rootKeyId &&
      operation.target.clientDeviceId === device.deviceId &&
      operation.target.hostDeviceId === state.hostId &&
      operation.target.workspaceId === replica?.runtimeWorkspaceId &&
      operation.target.userId === session.meta.userId &&
      operation.target.sessionId === session.meta.id &&
      operation.target.machineId === session.meta.machineId &&
      operation.target.localProjectId === session.meta.project.localProjectId,
  );
}
function attachmentRecoverySupported(state: SecureWorkspaceState, target: SecureCliTarget) {
  const workspace = state.catalog?.workspaces.find((entry) => entry.id === target.workspaceId);
  return (
    state.hostId === target.hostDeviceId &&
    !!workspace?.features?.includes(ATTACHMENTS_FEATURE) &&
    workspace.features.includes(ATTACHMENT_OPERATIONS_FEATURE)
  );
}
function mcpRecoverySupported(state: SecureWorkspaceState, target: SecureCliTarget) {
  const features = state.catalog?.workspaces.find(
    (entry) => entry.id === target.workspaceId,
  )?.features;
  return (
    state.hostId === target.hostDeviceId &&
    !!features?.includes(MCP_FEATURE) &&
    features.includes(SECURE_TURN_AUTHORITY_FEATURE)
  );
}

function pendingForSession(state: SecureWorkspaceState): boolean {
  return sessionOperations(state).some((operation) =>
    ['pending', 'ending'].includes(operation.state),
  );
}
function freezeReview(value: SecurePermissionReview): SecurePermissionReview {
  const copy = structuredClone(value);
  Object.freeze(copy.target.product);
  Object.freeze(copy.target);
  Object.freeze(copy.request.scope);
  for (const option of copy.request.options) Object.freeze(option);
  Object.freeze(copy.request.options);
  Object.freeze(copy.request);
  return Object.freeze(copy);
}
function publicOutcome(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  if (!request.outcome) return null;
  const outcome = request.outcome as Record<string, unknown>;
  if (outcome.outcome === 'cancelled' && Object.keys(outcome).length === 1)
    return '主机记录：已取消审批请求';
  if (
    outcome.outcome === 'selected' &&
    typeof outcome.optionId === 'string' &&
    Object.keys(outcome).length === 2 &&
    Array.isArray(request.options)
  ) {
    const choices = request.options.filter(
      (option) => option && typeof option === 'object' && option.optionId === outcome.optionId,
    );
    if (choices.length === 1 && typeof choices[0].name === 'string')
      return `主机记录：已选择「${choices[0].name}」`;
  }
  return '主机审批结果无法核对，请刷新会话。';
}
const permissionOptionLabels = {
  allow_once: '仅本次允许',
  allow_always: '持续允许',
  reject_once: '仅本次拒绝',
  reject_always: '持续拒绝',
} as const;
function PermissionCard({
  currentReview,
  state,
  busy,
  finished,
  request,
  controller,
  run,
}: {
  currentReview: SecurePermissionReview | null;
  state: SecureWorkspaceState;
  busy: boolean;
  finished: boolean;
  request: unknown;
  controller: SecureUiController;
  run: Run;
}) {
  const [review, setReview] = useState(() => (currentReview ? freezeReview(currentReview) : null));
  const outcome = publicOutcome(request);
  const changed =
    !!review &&
    (!currentReview || productCanonicalJson(review) !== productCanonicalJson(currentReview));
  const session = state.session;
  const replica = state.catalog?.products.replicas.find((entry) => entry.id === state.replicaId);
  const supported = !!state.catalog?.workspaces
    .find((entry) => entry.id === replica?.runtimeWorkspaceId)
    ?.features?.includes(PERMISSION_REVIEW_FEATURE);
  const blocked = pendingForSession(state);
  const accepted =
    !!review &&
    sessionOperations(state).some((operation) => {
      if (operation.kind !== 'permission' || operation.state !== 'accepted') return false;
      try {
        const command = JSON.parse(operation.body);
        return (
          command.method === 'mutate' &&
          command.params?.kind === 'permission' &&
          command.params.requestId === review.request.requestId &&
          command.params.expectedTurnId === review.request.expectedUserTurnId
        );
      } catch {
        return false;
      }
    });
  const inactive =
    accepted ||
    finished ||
    !!outcome ||
    !session ||
    session.meta.isArchived ||
    session.persisted === false ||
    !!session.persistenceError;
  const unavailable =
    !supported ||
    busy ||
    !state.status?.connection ||
    inactive ||
    blocked ||
    changed ||
    !review ||
    !currentReview;
  let details: string | null = null;
  try {
    if (review) details = JSON.stringify(JSON.parse(review.request.itemJson), null, 2);
  } catch {
    /* A damaged review never enables a decision. */
  }
  if (outcome)
    return (
      <p className="secure-permission-result" role="status">
        {outcome}
      </p>
    );
  if (finished) return <p className="secure-muted">此回合已结束，审批请求已失效。</p>;
  if (!supported)
    return (
      <p className="secure-warning" role="status">
        执行主机尚不支持精确审批校验，请升级主机后重新核对目录。
      </p>
    );
  return (
    <section className="secure-permission" aria-label="审批请求">
      <h3>需要你的审批决定</h3>
      {review && details ? (
        <>
          <p className="secure-muted">核对原操作与选项后，明确选择一次决定。</p>
          <details open className="secure-permission-details">
            <summary>原操作详情</summary>
            <pre>{details}</pre>
          </details>
          <dl className="secure-facts">
            <dt>活动回合</dt>
            <dd>{review.request.assistantTurnId}</dd>
            <dt>请求</dt>
            <dd>{review.request.requestId}</dd>
          </dl>
          <div className="secure-permission-options">
            {review.request.options.map((option) => (
              <div className="secure-permission-option" key={option.optionId}>
                <button
                  type="button"
                  aria-label={option.name + '（' + permissionOptionLabels[option.kind] + '）'}
                  disabled={unavailable || !details}
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
                <small>{permissionOptionLabels[option.kind]}</small>
              </div>
            ))}
          </div>
          <button
            type="button"
            disabled={unavailable || !details}
            onClick={() =>
              run(() => controller.respondPermission(review, { outcome: 'cancelled' }))
            }
          >
            取消审批请求
          </button>
          <p className="secure-muted">
            取消会向主机提交取消决定；封存待确认原操作不会取消主机正在等待的审批。
          </p>
        </>
      ) : (
        <p className="secure-warning">审批请求无法唯一核对，未提供决定按钮。请刷新会话。</p>
      )}
      {changed && (
        <p className="secure-warning" role="status">
          审批内容已改变，原决定按钮已停用。请重新核对当前请求。
        </p>
      )}
      {(changed || !review) && currentReview && (
        <button
          type="button"
          disabled={busy || !state.status?.connection || inactive || blocked}
          onClick={() => setReview(freezeReview(currentReview))}
        >
          重新核对审批
        </button>
      )}
      {accepted && (
        <p className="secure-permission-result" role="status">
          主机已接受此审批决定。请刷新会话读取结果。
        </p>
      )}
      {blocked ? (
        <p className="secure-warning" role="status">
          此会话还有结果待确认的原操作。请先手动核查或封存；封存不会代替取消审批请求。
        </p>
      ) : !state.status?.connection ? (
        <p className="secure-muted">执行主机连接未确认，暂时不能提交审批决定。</p>
      ) : session?.persisted === false || session?.persistenceError ? (
        <p className="secure-warning">执行电脑尚未确认会话已保存，暂时不能提交审批决定。</p>
      ) : !currentReview && review ? (
        <p className="secure-warning">此审批已失效或无法唯一核对，请刷新会话。</p>
      ) : null}
    </section>
  );
}
function HistoryItem({
  value,
  finished,
  turnId,
  state,
  busy,
  controller,
  run,
  onAttachment,
}: {
  value: unknown;
  onAttachment(reference: AttachmentReference): void;
  finished: boolean;
  turnId: string;
  state: SecureWorkspaceState;
  busy: boolean;
  controller: SecureUiController;
  run: Run;
}) {
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
    const permission = item.permissionRequest;
    const requestId =
      permission && typeof permission === 'object'
        ? (permission as Record<string, unknown>).requestId
        : undefined;
    const matches = state.permissionReviews.filter(
      (review) =>
        review.request.assistantTurnId === turnId && review.request.requestId === requestId,
    );
    const turns = state.session?.history ?? [];
    const requestMatches = turns
      .flatMap((turn) => turn.items ?? [])
      .filter(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          (entry as any).permissionRequest?.requestId === requestId,
      );
    const currentReview =
      matches.length === 1 &&
      typeof requestId === 'string' &&
      requestMatches.length === 1 &&
      typeof item.toolCallId === 'string' &&
      item.toolCallId.length > 0
        ? matches[0]
        : null;
    return (
      <div className="secure-tool">
        <details>
          <summary>
            {displayText(item.title ?? item.kind ?? '工具调用')} · {displayText(item.status)}
          </summary>
          <pre>{displayText(item.content ?? item.rawOutput ?? item.rawInput)}</pre>
        </details>
        {Array.isArray(item.content) &&
          item.content
            .filter((entry) => entry && typeof entry === 'object' && entry.type === 'attachment')
            .map((entry, index) => (
              <SecureAttachmentCard
                key={index}
                value={entry.attachment}
                disabled={busy}
                onOpen={onAttachment}
              />
            ))}
        {permission !== undefined && (
          <PermissionCard
            currentReview={currentReview}
            state={state}
            busy={busy}
            finished={finished}
            request={permission}
            controller={controller}
            run={run}
          />
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
    return <SecureAttachmentCard value={item.attachment} disabled={busy} onOpen={onAttachment} />;
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
  onPreview,
  onSkills,
  onMcp,
  onGithub,
  onProjectPreview,
  onGit,
  onFork,
  toolContainer,
}: {
  state: SecureWorkspaceState;
  toolContainer?: HTMLElement | null;
  controller: SecureUiController;
  run: Run;
  onDirty: (value: boolean) => void;
  onPreview(item: SecureAttachmentDraft): void;
  onSkills(target: SecureCliTarget): Promise<void>;
  onMcp(target: SecureCliTarget): Promise<void>;
  onGithub(target: SecureCliTarget): Promise<void>;
  onProjectPreview(target: SecureCliTarget): Promise<void>;
  onGit(target: SecureCliTarget): Promise<void>;
  onFork(target: SecureCliTarget): Promise<void>;
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
  const blocked = pendingForSession(state);
  const replica = state.catalog?.products.replicas.find((entry) => entry.id === state.replicaId);
  const workspace = state.catalog?.workspaces.find(
    (entry) => entry.id === replica?.runtimeWorkspaceId,
  );
  const contentContext = controller.contentContext;
  const candidateTarget = contentContext.target;
  const device = state.status?.device;
  const shownTarget =
    candidateTarget &&
    replica &&
    device &&
    'deviceId' in device &&
    candidateTarget.origin === device.pin.serverOrigin &&
    candidateTarget.owner === device.pin.accountId &&
    candidateTarget.rootKeyId === device.pin.rootKeyId &&
    candidateTarget.clientDeviceId === device.deviceId &&
    candidateTarget.hostDeviceId === state.hostId &&
    candidateTarget.sessionId === session.meta.id &&
    candidateTarget.workspaceId === replica.runtimeWorkspaceId &&
    candidateTarget.localProjectId === replica.localProjectId &&
    candidateTarget.userId === session.meta.userId &&
    candidateTarget.machineId === session.meta.machineId &&
    candidateTarget.product?.replicaId === replica.id &&
    candidateTarget.product.revision === replica.revision
      ? structuredClone(candidateTarget)
      : null;
  const attachmentAction = (action: () => Promise<void>) =>
    run(async () => {
      if (
        !shownTarget ||
        productCanonicalJson(shownTarget) !==
          productCanonicalJson(controller.contentContext.target) ||
        controller.contentContext.generation !== contentContext.generation
      )
        throw Error('附件显示目标已改变，请重新打开会话。');
      await action();
    });

  const attachmentRemoteSupported =
    !!workspace?.features?.includes(ATTACHMENTS_FEATURE) &&
    !!workspace.features.includes(ATTACHMENT_OPERATIONS_FEATURE);
  const attachmentUnsupported =
    state.attachmentDraft.length > 0 &&
    (!attachmentRemoteSupported ||
      state.attachmentDraft.some(
        (item) =>
          item.status === 'pending' ||
          !!secureAttachmentInputReason(item.reference, session.agent?.inputCapabilities),
      ));
  const runSelection = state.runOptions?.selection ?? {};
  let modelValidation = '';
  try {
    resolveRunSelection(runSelection, session.agent?.runConfig);
  } catch (error) {
    modelValidation = failure(error);
  }
  const unavailable =
    !!modelValidation ||
    !!state.modelOptionsError ||
    !shownTarget ||
    !state.status?.connection ||
    state.busy ||
    running ||
    session.meta.isArchived ||
    session.persisted === false ||
    !!session.persistenceError ||
    blocked ||
    !!state.extensionBlock ||
    attachmentUnsupported ||
    (!!state.mcpDraft?.review?.servers.length &&
      (!workspace?.features?.includes(MCP_FEATURE) ||
        !workspace.features.includes(SECURE_TURN_AUTHORITY_FEATURE)));
  function submit(event: FormEvent) {
    event.preventDefault();
    if (
      unavailable ||
      (!text.trim() &&
        state.attachmentDraft.length === 0 &&
        !state.previewAnnotations.some((item) => item.selectionId))
    )
      return;
    if (
      !shownTarget ||
      productCanonicalJson(shownTarget) !==
        productCanonicalJson(controller.contentContext.target) ||
      controller.contentContext.generation !== contentContext.generation
    )
      return;
    const review = {
      target: structuredClone(shownTarget),
      ...(state.runOptions ? { runOptions: structuredClone(state.runOptions) } : {}),
      attachments: structuredClone(state.attachmentDraft),
      mcpDraft: structuredClone(state.mcpDraft),
      previewAnnotations: structuredClone(
        state.previewAnnotations.filter((item) => item.selectionId),
      ),
    };
    run(async () => {
      await controller.saveDraft(text);
      await controller.send(text, review);
    });
  }
  const composerTools = (
    <div className="secure-actions">
      <button
        type="button"
        disabled={
          !shownTarget ||
          state.busy ||
          !contentContext.online ||
          !workspace?.features?.includes(SKILLS_FEATURE)
        }
        onClick={() => {
          if (!shownTarget) return;
          const target = structuredClone(shownTarget);
          run(async () => {
            if (
              productCanonicalJson(target) !==
                productCanonicalJson(controller.contentContext.target) ||
              controller.contentContext.generation !== contentContext.generation
            )
              throw Error('Skills 所属会话已改变，请重新打开。');
            await controller.saveDraft(text);
            await onSkills(target);
          });
        }}
      >
        Skills
      </button>
      <button
        type="button"
        disabled={!shownTarget || state.busy || !state.mcpDraft}
        onClick={() => shownTarget && run(() => onMcp(structuredClone(shownTarget)))}
      >
        额外 MCP
      </button>
      <button
        type="button"
        disabled={!shownTarget || state.busy}
        onClick={() => {
          if (!shownTarget) return;
          const target = structuredClone(shownTarget);
          run(async () => {
            if (
              productCanonicalJson(target) !==
                productCanonicalJson(controller.contentContext.target) ||
              controller.contentContext.generation !== contentContext.generation
            )
              throw Error('GitHub 所属会话已改变，请重新打开。');
            await controller.saveDraft(text);
            await onGithub(target);
          });
        }}
      >
        GitHub
      </button>
      <button
        type="button"
        disabled={!shownTarget || state.busy}
        onClick={() => shownTarget && run(() => onProjectPreview(structuredClone(shownTarget)))}
      >
        网页预览
      </button>
      <button
        type="button"
        disabled={!shownTarget || state.busy}
        onClick={() => {
          if (!shownTarget) return;
          const target = structuredClone(shownTarget);
          run(async () => {
            if (
              productCanonicalJson(target) !==
                productCanonicalJson(controller.contentContext.target) ||
              controller.contentContext.generation !== contentContext.generation
            )
              throw Error('Git 所属会话已改变，请重新打开。');
            await controller.saveDraft(text);
            await onGit(target);
          });
        }}
      >
        Git 工作目录
      </button>
      <button
        type="button"
        disabled={!shownTarget || state.busy}
        onClick={() => {
          if (!shownTarget) return;
          const target = structuredClone(shownTarget);
          run(async () => {
            if (
              productCanonicalJson(target) !==
                productCanonicalJson(controller.contentContext.target) ||
              controller.contentContext.generation !== contentContext.generation
            )
              throw Error('Fork 所属会话已改变，请重新打开。');
            await controller.saveDraft(text);
            await onFork(target);
          });
        }}
      >
        Fork 会话
      </button>
    </div>
  );
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
          onPaste={(event) => {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (files.length) {
              event.preventDefault();
              if (!state.busy) attachmentAction(() => controller.addAttachments(files));
            }
          }}
          disabled={state.busy}
        />
      </label>
      {toolContainer ? (
        createPortal(composerTools, toolContainer)
      ) : (
        <WorkspaceToolMenu>{composerTools}</WorkspaceToolMenu>
      )}
      {state.extensionBlock && <p className="secure-warning">{state.extensionBlock}</p>}
      <SecurePreviewDraftCards
        items={state.previewAnnotations}
        disabled={!shownTarget || state.busy}
        onOpen={() => shownTarget && run(() => onProjectPreview(structuredClone(shownTarget)))}
        onRemove={(item) =>
          shownTarget &&
          run(() => controller.removePreviewSelection(structuredClone(shownTarget), item))
        }
      />
      {state.mcpDraft && (
        <SecureMcpDraftCard
          draft={state.mcpDraft}
          onOpen={() => shownTarget && run(() => onMcp(structuredClone(shownTarget)))}
        />
      )}
      {!!state.mcpDraft?.review?.servers.length &&
        (!workspace?.features?.includes(MCP_FEATURE) ||
          !workspace.features.includes(SECURE_TURN_AUTHORITY_FEATURE)) && (
          <p className="secure-warning">
            执行主机尚不支持完整的加密回合授权。MCP 选择保留，升级主机并重新核对目录后才能发送。
          </p>
        )}
      <div className="secure-actions">
        <button
          type="button"
          disabled={!shownTarget || !state.status?.connection || state.busy || running}
          onClick={() => {
            if (!shownTarget) return;
            const reviewedTarget = structuredClone(shownTarget);
            run(() => controller.refreshAgentOptions(reviewedTarget));
          }}
        >
          刷新模型与附件能力
        </button>
        <span className="secure-muted">只检查此会话固定 Agent 的能力，不发送指令。</span>
      </div>
      <RunControls
        idPrefix="secure-"
        capabilities={session.agent?.runConfig}
        selection={runSelection}
        agentType={session.agent?.agentType}
        disabled={
          !shownTarget ||
          !state.runOptions ||
          !controller.saveRunSelection ||
          state.busy ||
          running ||
          blocked
        }
        loading={false}
        canRefresh={!!shownTarget && !!state.status?.connection && !running && !blocked}
        validation={modelValidation}
        status={state.modelOptionsError}
        existing={true}
        onChange={(property, value) => {
          if (!shownTarget || !controller.saveRunSelection) return;
          const target = structuredClone(shownTarget);
          const selection = {
            ...runSelection,
            [property]: value || undefined,
            ...(property === 'modelId' ? { reasoningEffort: undefined } : {}),
          };
          run(async () => {
            await controller.saveRunSelection!(target, selection);
            if (
              property === 'modelId' &&
              state.status?.connection &&
              workspace?.features?.includes(AGENT_MODEL_OPTIONS_FEATURE)
            )
              await controller.refreshAgentOptions(target);
          });
        }}
        onRefresh={() =>
          shownTarget && run(() => controller.refreshAgentOptions(structuredClone(shownTarget)))
        }
        onOpenModels={() => {
          if (
            shownTarget &&
            state.status?.connection &&
            workspace?.features?.includes(AGENT_MODEL_OPTIONS_FEATURE)
          )
            run(() => controller.refreshAgentOptions(structuredClone(shownTarget)));
        }}
      />
      <SecureAttachmentControls
        items={state.attachmentDraft}
        busy={state.busy}
        disabled={!shownTarget}
        online={!!state.status?.connection}
        remoteSupported={attachmentRemoteSupported}
        canRetry={(id) =>
          state.operations.some(
            (operation) => operation.operationId === id && operation.state === 'pending',
          )
        }
        capabilities={session.agent?.inputCapabilities}
        onFiles={(files) => attachmentAction(() => controller.addAttachments(files))}
        onRemove={(id) => attachmentAction(() => controller.removeAttachment(id))}
        onRetry={(operationId) => attachmentAction(() => controller.recover(operationId, 'retry'))}
        onPreview={onPreview}
      />
      {state.attachmentDraft.length > 0 && !attachmentRemoteSupported && (
        <p className="secure-warning">
          执行主机尚不支持可恢复的附件操作，请升级主机后重新核对目录。附件草稿保留在本机。
        </p>
      )}
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
          <button
            className="secure-primary"
            type="submit"
            disabled={
              unavailable ||
              (!text.trim() &&
                state.attachmentDraft.length === 0 &&
                !state.previewAnnotations.some((item) => item.selectionId))
            }
          >
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
  layout = 'standalone',
  onNavigationBlocked,
}: {
  controller: SecureUiController;
  accountApi: SecureAccountApi;
  onAccountVerified?: (value: Account | null) => void;
  layout?: 'standalone' | 'session' | 'connections';
  onNavigationBlocked?: (blocked: boolean) => void;
}) {
  const [state, setState] = useState(controller.state);
  const contentUi = useRef<SecureContentUiHandle>(null);
  const skillsUi = useRef<SecureSkillsUiHandle>(null);
  const mcpUi = useRef<SecureMcpUiHandle>(null);
  const githubUi = useRef<SecureGithubUiHandle>(null);
  const previewUi = useRef<SecurePreviewUiHandle>(null);
  const gitUi = useRef<SecureGitUiHandle>(null);
  const forkUi = useRef<SecureForkUiHandle>(null);
  const executionViews = useRef(new Map<string, string>());
  const forkResource = useRef<{
    parentTarget: SecureCliTarget;
    sourceTarget: SecureCliTarget;
    childSessionId: string;
  } | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [accountLoading, setAccountLoading] = useState(true);
  const [localBusy, setLocalBusy] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    onNavigationBlocked?.(dirty || localBusy || state.busy);
  }, [dirty, localBusy, state.busy, onNavigationBlocked]);
  const [agentId, setAgentId] = useState('');
  const [composerTools, setComposerTools] = useState<HTMLDivElement | null>(null);
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
    void (async () => action())()
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
  const sessionContext = structuredClone(controller.contentContext);
  const sessionTarget =
    sessionContext.target?.sessionId === session?.meta.id ? sessionContext.target : null;
  const checkedSessionTarget = () => {
    if (
      !sessionTarget ||
      productCanonicalJson(sessionContext) !== productCanonicalJson(controller.contentContext)
    )
      throw Error('会话入口的原执行范围已改变，请重新读取。');
    return structuredClone(sessionTarget);
  };

  const scopeKey = JSON.stringify([
    state.hostId,
    state.replicaId,
    replica?.revision,
    session?.meta.id,
  ]);
  const project = catalog?.products.projects.find((entry) => entry.id === replica?.projectId);
  const openGit = async (target: SecureCliTarget) => {
    if (productCanonicalJson(target) !== productCanonicalJson(controller.contentContext.target))
      throw Error('工作目录所属会话已改变。');
    forkResource.current = null;
    await gitUi.current?.open(target, { newSession: session?.history.length === 0 });
  };
  const openFork = async (target: SecureCliTarget, turnId?: string) => {
    if (productCanonicalJson(target) !== productCanonicalJson(controller.contentContext.target))
      throw Error('Fork 所属会话已改变。');
    await forkUi.current?.open(target, {
      sourceTitle: session?.meta.title || '未命名会话',
      turnId,
    });
  };
  return (
    <div className={'secure-app' + (layout === 'standalone' ? '' : ' secure-app-embedded')}>
      <header className="secure-topbar" hidden={layout === 'session'}>
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
        <div
          className={'secure-layout' + (layout === 'standalone' ? '' : ' secure-layout-embedded')}
        >
          <aside className="secure-sidebar" aria-label="设备和会话" hidden={layout === 'session'}>
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
                        {host.deviceId === state.hostId && catalog?.deviceMetadata
                          ? `${catalog.deviceMetadata.name} · ${host.deviceId}`
                          : host.deviceId}
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
                  <p className="secure-confirmed">
                    已核对执行主机目录
                    {catalog.deviceMetadata ? ` · ${catalog.deviceMetadata.name}` : ''}
                  </p>
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
            <section className="secure-card" hidden={layout === 'connections'}>
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
          <main className="secure-workspace" hidden={layout === 'connections'}>
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
                    <WorkspaceToolMenu>
                      <div ref={setComposerTools} className="secure-composer-tool-slot" />
                      <button
                        disabled={busy || !controller.contentContext.target}
                        onClick={() =>
                          run(() => contentUi.current?.openProject('tree') ?? Promise.resolve())
                        }
                      >
                        项目文件
                      </button>
                      <button
                        disabled={busy || !controller.contentContext.target}
                        onClick={() =>
                          run(() => contentUi.current?.openProject('changes') ?? Promise.resolve())
                        }
                      >
                        会话变更
                      </button>
                    </WorkspaceToolMenu>
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
                  <SessionInformation
                    key={scopeKey}
                    history={session.history}
                    disabled={busy || dirty || !controller.contentContext.target}
                    onCommand={(command) =>
                      run(() =>
                        controller.appendInstruction(checkedSessionTarget(), command, () => {
                          checkedSessionTarget();
                        }),
                      )
                    }
                    onFiles={
                      runtime?.features?.includes(PROJECT_DIFF_FEATURE)
                        ? (turnId) => {
                            run(
                              () =>
                                contentUi.current?.openProject('changes', turnId) ??
                                Promise.resolve(),
                            );
                          }
                        : undefined
                    }
                  />
                </header>
                {session.meta.forkOrigin && (
                  <section className="secure-card" aria-label="Fork 来源">
                    <p>
                      Fork 自{' '}
                      {session.meta.forkOrigin.sourceTitle ||
                        session.meta.forkOrigin.sourceSessionId}{' '}
                      ·
                      {session.meta.forkOrigin.directory === 'worktree'
                        ? '独立工作目录'
                        : '共享目录'}
                    </p>
                    <p>
                      {session.meta.forkOrigin.cutoff.kind === 'turn'
                        ? `截止回合 ${session.meta.forkOrigin.cutoff.turnId}`
                        : '创建时的原生上下文'}
                    </p>
                    {session.meta.forkOrigin.branch && <p>分支 {session.meta.forkOrigin.branch}</p>}
                    <button
                      disabled={busy || dirty || !connection}
                      onClick={() =>
                        run(() =>
                          controller.openForkSource(
                            checkedSessionTarget(),
                            session.meta.forkOrigin!.sourceSessionId,
                          ),
                        )
                      }
                    >
                      打开源会话
                    </button>
                  </section>
                )}
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
                <SessionTimeline
                  history={session.history}
                  variant="secure"
                  renderItem={(item, turn, index) => (
                    <HistoryItem
                      key={scopeKey + ':' + turn.id + ':' + index}
                      value={item}
                      onAttachment={(reference) =>
                        run(() => contentUi.current?.openAttachment(reference) ?? Promise.resolve())
                      }
                      finished={turn.finished}
                      turnId={turn.id}
                      state={state}
                      busy={busy}
                      controller={controller}
                      run={run}
                    />
                  )}
                  actions={(turn) => (
                    <>
                      {hasTurnFileChanges(turn) &&
                        runtime?.features?.includes(PROJECT_DIFF_FEATURE) && (
                          <button
                            type="button"
                            disabled={busy || dirty}
                            onClick={() =>
                              run(
                                () =>
                                  contentUi.current?.openProject('changes', turn.id) ??
                                  Promise.resolve(),
                              )
                            }
                          >
                            查看回合文件变更 · {turnFileChanges(turn)!.changeCount}
                          </button>
                        )}
                      {turn.finished && runtime?.features?.includes(SESSION_FORK_FEATURE) && (
                        <button
                          type="button"
                          className="session-fork-action"
                          aria-label="从此回合创建副本"
                          title="从此回合创建副本"
                          disabled={busy || dirty || !controller.contentContext.target}
                          onClick={() => run(() => openFork(checkedSessionTarget(), turn.id))}
                        >
                          <GitFork size={15} />
                        </button>
                      )}
                    </>
                  )}
                />
                <Composer
                  key={scopeKey}
                  state={state}
                  controller={controller}
                  run={run}
                  onDirty={setDirty}
                  onSkills={(target) => skillsUi.current?.open(target) ?? Promise.resolve()}
                  onMcp={(target) => mcpUi.current?.open(target) ?? Promise.resolve()}
                  onGithub={(target) => githubUi.current?.open(target) ?? Promise.resolve()}
                  onGit={openGit}
                  onFork={(target) => openFork(target)}
                  toolContainer={composerTools}
                  onProjectPreview={(target) =>
                    previewUi.current?.open(target) ?? Promise.resolve()
                  }
                  onPreview={(item) =>
                    run(async () => {
                      contentUi.current?.openDraft(item);
                    })
                  }
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
                网络中断不会自动重发。核查、重试和封存均使用记录中的原操作与原执行范围。
              </p>
              <button disabled={busy} onClick={() => run(() => controller.refreshOperations())}>
                刷新本机记录
              </button>
              <ul>
                {state.operations.map((operation) => (
                  <li key={operation.operationId}>
                    {operation.kind.startsWith('attachment-') && (
                      <p className="secure-muted">
                        附件结果未知时，可核查、重试或封存原操作。封存需主机确认，未确认前仍保留草稿并阻止发送。
                        {!attachmentRecoverySupported(state, operation.target) &&
                          ' 请先选择原执行主机并重新核对目录；主机需要支持可恢复的附件操作。'}
                      </p>
                    )}
                    {!!operation.mcpReview?.servers.length && (
                      <p className="secure-muted">
                        原指令已固定 MCP：
                        {operation.mcpReview.servers.map((server) => server.name).join('、')}。
                        核查和重试使用原授权；后续草稿不会替换它。
                        {!mcpRecoverySupported(state, operation.target) &&
                          ' 请先选择原主机，并核对其加密回合授权能力。'}
                      </p>
                    )}
                    {operation.kind === 'permission' && (
                      <p className="secure-muted">
                        审批决定的原操作。封存仅结束此记录的投递，不会取消主机等待的审批请求。
                      </p>
                    )}
                    <div className="secure-section-title">
                      <strong>
                        {operation.kind === 'attachment-upload'
                          ? '上传附件'
                          : operation.kind === 'attachment-remove'
                            ? '移除附件'
                            : operation.kind === 'permission'
                              ? '审批决定'
                              : operation.kind === 'turn'
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
                          disabled={
                            busy ||
                            !connection ||
                            (operation.kind.startsWith('attachment-') &&
                              !attachmentRecoverySupported(state, operation.target)) ||
                            (!!operation.mcpReview?.servers.length &&
                              !mcpRecoverySupported(state, operation.target))
                          }
                          onClick={() =>
                            run(() => controller.recover(operation.operationId, 'inspect'))
                          }
                        >
                          核查原操作
                        </button>
                        <button
                          disabled={
                            busy ||
                            !connection ||
                            operation.state === 'ending' ||
                            (operation.kind.startsWith('attachment-') &&
                              !attachmentRecoverySupported(state, operation.target)) ||
                            (!!operation.mcpReview?.servers.length &&
                              !mcpRecoverySupported(state, operation.target))
                          }
                          onClick={() =>
                            run(() => controller.recover(operation.operationId, 'retry'))
                          }
                        >
                          重试原操作
                        </button>
                        <button
                          disabled={
                            busy ||
                            !connection ||
                            (operation.kind.startsWith('attachment-') &&
                              !attachmentRecoverySupported(state, operation.target)) ||
                            (!!operation.mcpReview?.servers.length &&
                              !mcpRecoverySupported(state, operation.target))
                          }
                          onClick={() =>
                            run(() => controller.recover(operation.operationId, 'abandon'))
                          }
                        >
                          封存原操作
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
            <SecureContentUI ref={contentUi} controller={controller} state={state} />
            <SecureSkillsUI
              ref={skillsUi}
              context={() => controller.contentContext}
              request={(target, method, params) =>
                controller.contentRequest(target, method, params)
              }
              appendInstruction={(target, instruction, current) =>
                controller.appendInstruction(target, instruction, current)
              }
            />
            <SecureMcpUI
              ref={mcpUi}
              context={() => controller.contentContext}
              draft={() => state.mcpDraft}
              readCatalog={(target) => controller.readMcpCatalog(target)}
              apply={(target, expected, servers, catalog, current) =>
                controller.applyMcp(target, expected, servers, catalog, current)
              }
            />
            <SecureGithubUI
              ref={githubUi}
              context={() => controller.contentContext}
              storage={controller.extensionStorage}
              request={(...args) => controller.scopedRequest(...args)}
              appendInstruction={(...args) => controller.appendInstruction(...args)}
              beforeWrite={(...args) => controller.beforeExtensionWrite(...args)}
              changed={(...args) => controller.refreshExtensionRecords(...args)}
            />
            <SecureGitUI
              ref={gitUi}
              context={() => controller.contentContext}
              storage={controller.extensionStorage}
              busy={busy || dirty}
              request={(...args) => controller.scopedRequest(...args)}
              resourceRequest={(...args) => controller.workspaceResourceRequest(...args)}
              beforeWrite={(target, current) =>
                controller.beforeWorkspaceWrite(target, 'git', current)
              }
              beforeResourceWrite={(...args) => controller.beforeWorkspaceResourceWrite(...args)}
              changed={(...args) => controller.refreshExtensionRecords(...args)}
              onWrite={async (target, current) => {
                current();
                gitUi.current?.close();
                await githubUi.current?.open(target, 'write');
              }}
              onNewSession={async (_target, current) => {
                current();
                await controller.createSession(selectedAgent);
              }}
              onRefresh={async (target, result, current) => {
                current();
                const key = productCanonicalJson(target),
                  execution = productCanonicalJson(result.execution);
                const prior = executionViews.current.get(key);
                executionViews.current.set(key, execution);
                if (
                  prior &&
                  prior !== execution &&
                  productCanonicalJson(controller.contentContext.target) === key
                ) {
                  contentUi.current?.close();
                  skillsUi.current?.close();
                  mcpUi.current?.close();
                  githubUi.current?.close();
                  await previewUi.current?.close();
                  current();
                }
                const resource = forkResource.current;
                if (
                  resource &&
                  result.execution.status === 'removed' &&
                  target.sessionId === resource.childSessionId &&
                  productCanonicalJson({
                    ...target,
                    sessionId: resource.parentTarget.sessionId,
                  }) === productCanonicalJson(resource.parentTarget)
                ) {
                  current();
                  await forkUi.current?.confirmResourceCleanup(
                    resource.sourceTarget,
                    resource.childSessionId,
                    result,
                    current,
                  );
                }
              }}
            />
            <SecureForkUI
              ref={forkUi}
              context={() => controller.contentContext}
              storage={controller.extensionStorage}
              busy={busy || dirty}
              request={(...args) => controller.scopedRequest(...args)}
              beforeWrite={(target, current) =>
                controller.beforeWorkspaceWrite(target, 'fork', current)
              }
              changed={(...args) => controller.refreshExtensionRecords(...args)}
              openChild={(...args) => controller.openForkChild(...args)}
              openWorkspace={async (sourceTarget, childSessionId, current) => {
                current();
                const parentTarget = controller.contentContext.target;
                if (!parentTarget || !sameSecureRuntime(parentTarget, sourceTarget))
                  throw Error('Fork 保留目录所属项目已改变。');
                const resource = structuredClone({ parentTarget, sourceTarget, childSessionId });
                forkResource.current = resource;
                await gitUi.current?.open(
                  { ...resource.parentTarget, sessionId: childSessionId },
                  { newSession: false, resource },
                );
              }}
            />
            <SecurePreviewUI
              ref={previewUi}
              context={() => controller.contentContext}
              storage={controller.extensionStorage}
              annotations={controller.previewAnnotations}
              busy={state.busy}
              request={(...args) => controller.scopedRequest(...args)}
              addImage={(...args) => controller.addPreviewImage(...args)}
              changedAnnotations={(...args) => controller.updatePreviewAnnotations(...args)}
            />
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
