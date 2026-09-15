import { useEffect, useRef, useState } from 'react';
import type { AttachmentReference } from '@moor/protocol/content-protocol';
import type { WorkspaceController } from '../workspace/workspace-controller';
import type { WorkspaceScope } from '../workspace/workspace-store';
import { attachmentPreviewUrl, attachmentText, formatAttachmentSize } from './attachments';
import { productCanonicalJson as canonical } from '@moor/client/encrypted-product';

export function WorkspaceAttachmentView({
  controller,
  scope,
  sessionId,
  reference,
  busy,
  run,
}: {
  controller: WorkspaceController;
  scope: WorkspaceScope;
  sessionId: string;
  reference: AttachmentReference;
  busy: boolean;
  run(task: () => Promise<unknown>): void;
}) {
  const [value, setValue] = useState<Awaited<
    ReturnType<WorkspaceController['readAttachment']>
  > | null>(null);
  const [notice, setNotice] = useState('');
  const epoch = useRef(0),
    saving = useRef(false);
  const saver = (
    window as unknown as {
      moorDesktop?: {
        version: number;
        saveAttachment(input: unknown): Promise<{ status: string }>;
        cancelAttachmentSave(): Promise<void>;
      };
    }
  ).moorDesktop;
  const identity = canonical([scope, sessionId, reference]);
  useEffect(() => {
    epoch.current++;
    setValue(null);
    setNotice('');
    return () => {
      epoch.current++;
      if (saving.current) void saver?.cancelAttachmentSave().catch(() => {});
    };
  }, [identity]);
  const image = value && attachmentPreviewUrl(reference, value.data);
  const text = value && attachmentText(reference, value.data);
  return (
    <div className="workspace-attachments">
      <article>
        <strong>{reference.name}</strong> · {formatAttachmentSize(reference.content.byteLength)}
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const version = epoch.current;
              const read = await controller.readAttachment(reference);
              if (version === epoch.current) {
                setValue(read);
                setNotice('');
              }
            })
          }
        >
          查看附件
        </button>
        {value && (
          <>
            <small>
              {value.source === 'cache'
                ? '本机缓存'
                : value.cacheSaved
                  ? '来自执行电脑，已缓存'
                  : '来自执行电脑，本机缓存未保存'}
            </small>
            {image && <img src={image} alt={reference.name} />}
            {text !== null && text !== undefined && <pre>{text}</pre>}
            {!image && text === undefined && <p>此类型可保存后查看。</p>}
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  if (
                    saver?.version !== 1 ||
                    typeof saver.saveAttachment !== 'function' ||
                    typeof saver.cancelAttachmentSave !== 'function'
                  )
                    throw Error('原生附件保存接口不可用，请重新打开桌面窗口。');
                  const version = epoch.current,
                    target = scope.target;
                  saving.current = true;
                  try {
                    const result = await saver.saveAttachment({
                      scope: {
                        owner: target.owner,
                        deviceId: target.deviceId,
                        workspaceId: target.workspaceId,
                        localProjectId: target.localProjectId,
                        sessionId,
                      },
                      reference,
                      data: value.data,
                    });
                    if (version !== epoch.current) return;
                    if (!['saved', 'cancelled'].includes(result.status))
                      throw Error('附件保存结果尚未确认。');
                    setNotice(result.status === 'saved' ? '附件已保存。' : '已取消保存。');
                  } finally {
                    saving.current = false;
                  }
                })
              }
            >
              保存附件
            </button>
          </>
        )}
        {notice && <p role="status">{notice}</p>}
      </article>
    </div>
  );
}
