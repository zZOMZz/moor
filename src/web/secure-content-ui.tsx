import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { File, Paperclip, X } from 'lucide-react';
import { attachmentReferenceSchema, type AttachmentReference } from '../content-protocol';
import {
  attachmentBase64Schema,
  MAX_TURN_ATTACHMENTS,
  type PromptInputCapabilities,
} from '../attachment-protocol';
import { projectDiffReferenceSchema } from '../project-content-protocol';
import { productCanonicalJson } from '../security/encrypted-product-catalog';
import type { SecureCliTarget } from '../cli/secure-operation';
import type { SecureWorkspaceController, SecureWorkspaceState } from './secure-controller';
import type { SecureAttachmentDraft } from './secure-attachments';
import { SecureProjectContentController } from './secure-project-content';
import { ProjectContentPanel } from './project-content-ui';

export function secureAttachmentSize(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.ceil(bytes / 1024)} KiB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
export function secureAttachmentInputReason(
  reference: AttachmentReference,
  capabilities?: PromptInputCapabilities,
) {
  if (!capabilities) return '等待 Agent 确认附件输入能力。';
  const type = reference.content.mediaType;
  if (type.startsWith('image/'))
    return capabilities.image ? undefined : '当前 Agent 不支持图片输入。';
  if (type.startsWith('audio/'))
    return capabilities.audio ? undefined : '当前 Agent 不支持音频输入。';
  return capabilities.embeddedContext ? undefined : '当前 Agent 不支持文件附件输入。';
}
function previewMedia(reference: AttachmentReference, data: string) {
  if (!attachmentBase64Schema.safeParse(data).success) return {};
  const type = reference.content.mediaType;
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type))
    return { image: `data:${type};base64,${data}` };
  if (
    [
      'audio/mpeg',
      'audio/mp4',
      'audio/wav',
      'audio/x-wav',
      'audio/ogg',
      'audio/webm',
      'audio/flac',
    ].includes(type)
  )
    return { audio: `data:${type};base64,${data}` };
  if (['text/plain', 'text/markdown'].includes(type)) {
    try {
      const bytes = Uint8Array.from(atob(data), (letter) => letter.charCodeAt(0));
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!text.includes('\0')) return { text };
    } catch {
      /* Malformed text stays a downloadable file. */
    }
  }
  return {};
}
export function SecureAttachmentCard({
  value,
  disabled,
  onOpen,
}: {
  value: unknown;
  disabled?: boolean;
  onOpen: (reference: AttachmentReference) => void;
}) {
  const reference = attachmentReferenceSchema.safeParse(value);
  if (!reference.success) return <p className="secure-muted">附件记录无法核对。</p>;
  return (
    <button
      type="button"
      className="secure-attachment-card"
      disabled={disabled}
      onClick={() => onOpen(reference.data)}
      aria-label={`读取附件：${reference.data.name}`}
    >
      <File aria-hidden="true" />
      <span>
        <strong>{reference.data.name}</strong>
        <small>
          {reference.data.content.mediaType} ·{' '}
          {secureAttachmentSize(reference.data.content.byteLength)}
        </small>
      </span>
    </button>
  );
}
export function SecureAttachmentControls({
  items,
  disabled,
  busy,
  online,
  remoteSupported,
  canRetry,
  capabilities,
  onFiles,
  onRemove,
  onRetry,
  onPreview,
}: {
  items: readonly SecureAttachmentDraft[];
  disabled?: boolean;
  busy?: boolean;
  online: boolean;
  remoteSupported: boolean;
  canRetry(operationId: string): boolean;
  capabilities?: PromptInputCapabilities;
  onFiles(files: globalThis.File[]): void;
  onRemove(attachmentId: string): void;
  onRetry(operationId: string): void;
  onPreview(item: SecureAttachmentDraft): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="secure-attachment-controls">
      <div className="secure-attachment-select">
        <button
          type="button"
          disabled={disabled || busy || items.length >= MAX_TURN_ATTACHMENTS}
          onClick={() => input.current?.click()}
        >
          <Paperclip aria-hidden="true" />
          添加附件
        </button>
        <span className="secure-muted">每个最多 8 MiB · 最多 8 个</span>
        <input
          ref={input}
          className="secure-attachment-input"
          type="file"
          multiple
          hidden
          disabled={disabled || busy || items.length >= MAX_TURN_ATTACHMENTS}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            if (files.length) onFiles(files);
          }}
        />
      </div>
      {!!items.length && (
        <>
          <p className="secure-muted">
            附件先保存在本机，点击发送后才上传。主机全部确认后才发送指令。
          </p>
          <ul className="secure-attachment-drafts" aria-label="本机附件草稿">
            {items.map((item) => {
              const pending = item.status === 'pending';
              const reason = secureAttachmentInputReason(item.reference, capabilities);
              const preview = previewMedia(item.reference, item.data);
              return (
                <li key={item.reference.attachmentId}>
                  <button
                    type="button"
                    className="secure-attachment-card"
                    disabled={disabled || busy}
                    onClick={() => onPreview(item)}
                    aria-label={`预览附件草稿：${item.reference.name}`}
                  >
                    {preview.image ? (
                      <img src={preview.image} alt="" />
                    ) : (
                      <File aria-hidden="true" />
                    )}
                    <span>
                      <strong>{item.reference.name}</strong>
                      <small>
                        {secureAttachmentSize(item.reference.content.byteLength)} ·{' '}
                        {pending
                          ? item.pendingAction === 'remove'
                            ? '移除结果待确认'
                            : '上传结果待确认'
                          : item.status === 'uploaded'
                            ? '主机已确认'
                            : '仅保存在本机'}
                      </small>
                    </span>
                  </button>
                  <div className="secure-actions">
                    {pending ? (
                      <button
                        type="button"
                        disabled={
                          disabled ||
                          busy ||
                          !online ||
                          !remoteSupported ||
                          !item.pendingOperationId ||
                          !canRetry(item.pendingOperationId)
                        }
                        onClick={() => {
                          if (item.pendingOperationId) onRetry(item.pendingOperationId);
                        }}
                      >
                        使用原操作重试确认
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={
                          disabled ||
                          busy ||
                          (item.status === 'uploaded' && (!online || !remoteSupported))
                        }
                        onClick={() => onRemove(item.reference.attachmentId)}
                        aria-label={`移除附件草稿：${item.reference.name}`}
                      >
                        移除
                      </button>
                    )}
                  </div>
                  {pending && (
                    <p className="secure-muted">
                      保留原操作 {item.pendingOperationId}
                      ；重连不会重传。可在下方“原操作记录”核查或封存；主机确认前不能重新上传或移除记录。
                    </p>
                  )}
                  {reason && <p className="secure-warning">{reason}</p>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
export type SecureAttachmentPreview = {
  target: SecureCliTarget;
  reference: AttachmentReference;
  data: string;
  source: 'host' | 'cache' | 'draft';
  cacheSaved?: boolean;
};
export function SecureAttachmentPreviewDialog({
  reference,
  value,
  busy,
  saving,
  error,
  message,
  onClose,
  onSave,
  onRetry,
}: {
  reference: AttachmentReference;
  value?: SecureAttachmentPreview;
  busy?: boolean;
  saving?: boolean;
  error?: string;
  message?: string;
  onClose(): void;
  onSave(): void;
  onRetry?(): void;
}) {
  const media = value ? previewMedia(reference, value.data) : {};
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [reference.attachmentId, reference.content.version]);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="session-dialog-backdrop" />
        <Dialog.Popup className="session-dialog secure-attachment-preview">
          <div className="secure-attachment-heading">
            <Dialog.Title>{reference.name}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="关闭加密附件预览">
              <X />
            </Dialog.Close>
          </div>
          <Dialog.Description>
            {secureAttachmentSize(reference.content.byteLength)} · {reference.content.mediaType}
            {value
              ? value.source === 'draft'
                ? ' · 本机草稿'
                : value.source === 'cache'
                  ? ' · 已核对的离线缓存'
                  : ' · 主机已确认'
              : ''}
          </Dialog.Description>
          {busy && <p role="status">正在读取并核对附件…</p>}
          {error && (
            <p className="secure-warning" role="alert">
              {error}
            </p>
          )}
          {message && <p role="status">{message}</p>}
          <div className="secure-attachment-preview-body">
            {media.image ? (
              <img src={media.image} alt={reference.name} />
            ) : media.audio ? (
              <audio controls preload="none" src={media.audio}>
                当前设备不支持此音频格式，可保存后查看。
              </audio>
            ) : media.text !== undefined ? (
              <>
                <pre>{expanded ? media.text : media.text.slice(0, 120000)}</pre>
                {!expanded && media.text.length > 120000 && (
                  <button type="button" onClick={() => setExpanded(true)}>
                    预览已截断，显示完整文本
                  </button>
                )}
              </>
            ) : value ? (
              <p>此格式不在页面中嵌入，可保存后查看。</p>
            ) : null}
          </div>
          {value?.source === 'host' && value.cacheSaved === false && (
            <p className="secure-muted">此附件未能保存到本机缓存；关闭后可能需要重新读取。</p>
          )}
          <div className="session-dialog-actions">
            {onRetry && (
              <button type="button" disabled={busy || saving} onClick={onRetry}>
                重新读取附件
              </button>
            )}
            <button type="button" disabled={!value || busy || saving} onClick={onSave}>
              {saving ? '正在保存…' : '保存附件'}
            </button>
            <Dialog.Close>关闭</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type ContentController = Pick<
  SecureWorkspaceController,
  'contentContext' | 'contentRequest' | 'readAttachment'
>;
export type SecureContentUiHandle = {
  openProject(mode: 'tree' | 'changes'): Promise<void>;
  openAttachment(reference: AttachmentReference): Promise<void>;
  openDraft(item: SecureAttachmentDraft): void;
  close(): void;
};
type PreviewState = {
  contextKey: string;
  reference: AttachmentReference;
  value?: SecureAttachmentPreview;
  busy?: boolean;
  saving?: boolean;
  error?: string;
  message?: string;
};
function nativeSaver() {
  const bridge = (
    window as unknown as {
      moorDesktop?: {
        version: number;
        saveAttachment(value: {
          scope: {
            owner: string;
            deviceId: string;
            workspaceId: string;
            localProjectId: string;
            sessionId: string;
          };
          reference: AttachmentReference;
          data: string;
        }): Promise<{ status: 'saved' | 'cancelled' }>;
        cancelAttachmentSave(): Promise<void>;
      };
    }
  ).moorDesktop;
  return bridge?.version === 1 &&
    typeof bridge.saveAttachment === 'function' &&
    typeof bridge.cancelAttachmentSave === 'function'
    ? bridge
    : undefined;
}
/** These view controllers only consume the verified desktop context and its finite read methods. */
export const SecureContentUI = forwardRef<
  SecureContentUiHandle,
  { controller: ContentController; state: SecureWorkspaceState }
>(function SecureContentUI({ controller, state }, ref) {
  const project = useMemo(
    () =>
      new SecureProjectContentController({
        context: () => controller.contentContext,
        request: (target, method, params) => controller.contentRequest(target, method, params),
      }),
    [controller],
  );
  const [, render] = useState(0);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const epoch = useRef(0);
  const saveLock = useRef(false);
  const [projectError, setProjectError] = useState<string>();
  const currentContext = controller.contentContext;
  const contextKey = productCanonicalJson(currentContext);
  const clearPreview = () => {
    epoch.current++;
    setPreview(null);
    void nativeSaver()
      ?.cancelAttachmentSave()
      .catch(() => {});
  };
  useEffect(() => project.subscribe(() => render((value) => value + 1)), [project]);
  useLayoutEffect(() => {
    project.sync();
    if (preview && preview.contextKey !== contextKey) clearPreview();
  }, [project, contextKey]);
  useEffect(
    () => () => {
      epoch.current++;
      project.close();
      void nativeSaver()
        ?.cancelAttachmentSave()
        .catch(() => {});
    },
    [project],
  );
  const current = (key: string, generation: number) =>
    epoch.current === generation && productCanonicalJson(controller.contentContext) === key;
  const openAttachment = async (raw: AttachmentReference) => {
    const reference = attachmentReferenceSchema.parse(structuredClone(raw));
    const context = currentContext;
    if (!context.target || contextKey !== productCanonicalJson(controller.contentContext))
      throw Error('内容显示范围已改变，请重新打开当前会话。');
    project.close();
    clearPreview();
    const generation = epoch.current;
    const key = productCanonicalJson(context);
    setPreview({ contextKey: key, reference, busy: true });
    try {
      const value = await controller.readAttachment(reference);
      if (!current(key, generation)) return;
      if (
        productCanonicalJson(value.target) !== productCanonicalJson(context.target) ||
        productCanonicalJson(value.reference) !== productCanonicalJson(reference)
      )
        throw Error('附件内容与所选原引用不匹配。');
      setPreview({ contextKey: key, reference, value });
    } catch (error) {
      if (current(key, generation))
        setPreview({
          contextKey: key,
          reference,
          error: error instanceof Error ? error.message : '附件读取未确认，请手动重试。',
        });
    }
  };
  const save = async () => {
    if (
      saveLock.current ||
      !preview?.value ||
      preview.busy ||
      preview.saving ||
      preview.contextKey !== productCanonicalJson(controller.contentContext)
    )
      return;
    const saver = nativeSaver();
    if (!saver) {
      setPreview({ ...preview, error: '原生保存接口不可用，请重新打开可信桌面窗口。' });
      return;
    }
    saveLock.current = true;
    const original = preview;
    const generation = epoch.current;
    const { target, reference, data } = preview.value;
    setPreview({ ...original, saving: true, error: undefined, message: undefined });
    try {
      const result = await saver.saveAttachment({
        scope: {
          owner: target.owner,
          deviceId: target.hostDeviceId,
          workspaceId: target.workspaceId,
          localProjectId: target.localProjectId,
          sessionId: target.sessionId,
        },
        reference,
        data,
      });
      if (!current(original.contextKey, generation)) return;
      if (!['saved', 'cancelled'].includes(result.status)) throw Error('附件保存结果未确认。');
      setPreview({
        ...original,
        message: result.status === 'saved' ? '附件已保存。' : '已取消保存。',
      });
    } catch (error) {
      if (current(original.contextKey, generation))
        setPreview({
          ...original,
          error: error instanceof Error ? error.message : '附件保存未确认，请重新核对。',
        });
    } finally {
      saveLock.current = false;
    }
  };
  useImperativeHandle(ref, () => ({
    async openProject(mode) {
      if (!currentContext.target || contextKey !== productCanonicalJson(controller.contentContext))
        throw Error('内容显示范围已改变，请重新打开当前会话。');
      clearPreview();
      setProjectError(undefined);
      const turns = (state.session?.history ?? [])
        .filter((turn) => turn.role === 'assistant')
        .map((turn, index) => {
          const parsed = projectDiffReferenceSchema.safeParse(turn.fileDiff);
          return {
            id: turn.id,
            label: `第 ${index + 1} 回合`,
            ...(parsed.success ? { reference: parsed.data } : {}),
          };
        })
        .reverse();
      await project.open(mode, turns, state.session?.meta.title ?? '项目内容');
    },
    openAttachment,
    openDraft(item) {
      const context = currentContext;
      if (!context.target || contextKey !== productCanonicalJson(controller.contentContext))
        throw Error('内容显示范围已改变，请重新打开当前会话。');
      project.close();
      clearPreview();
      const reference = attachmentReferenceSchema.parse(structuredClone(item.reference));
      setPreview({
        contextKey: productCanonicalJson(context),
        reference,
        value: { target: context.target, reference, data: item.data, source: 'draft' },
      });
    },
    close() {
      project.close();
      clearPreview();
    },
  }));
  const projectAction = (action: () => Promise<void>) => {
    const key = productCanonicalJson(controller.contentContext);
    setProjectError(undefined);
    void action().catch((error: unknown) => {
      if (productCanonicalJson(controller.contentContext) === key)
        setProjectError(error instanceof Error ? error.message : '文件读取未确认，请手动重试。');
    });
  };
  const panel = project.state;
  const shown = preview?.contextKey === contextKey ? preview : null;
  return (
    <>
      {panel && (
        <ProjectContentPanel
          {...panel}
          error={projectError ?? panel.error}
          onMode={(mode) => {
            projectAction(() => project.setMode(mode));
          }}
          onTreeMore={() => {
            projectAction(() => project.treeMore());
          }}
          onFile={(path, size) => {
            projectAction(() => project.file(path, size));
          }}
          onTurn={(turn) => {
            projectAction(() => project.turn(turn));
          }}
          onDiffFile={(change) => {
            projectAction(() => project.diffFile(change));
          }}
          onRefresh={() => {
            projectAction(() => project.refresh());
          }}
          onClose={() => project.close()}
        />
      )}
      {shown && (
        <SecureAttachmentPreviewDialog
          {...shown}
          onClose={clearPreview}
          onSave={() => {
            void save();
          }}
          onRetry={
            shown.value?.source === 'draft'
              ? undefined
              : () => {
                  void openAttachment(shown.reference);
                }
          }
        />
      )}
    </>
  );
});
