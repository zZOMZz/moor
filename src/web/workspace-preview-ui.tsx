import { useEffect, useRef, useState } from 'react';
import { Monitor } from 'lucide-react';
import { ProjectPreviewPanel } from './project-preview-ui';
import { PREVIEW_FEATURE } from '../preview-protocol';
import type { WorkspaceController, WorkspaceClientState } from './workspace-controller';

export function WorkspacePreviewUI({
  controller,
  state,
  busy,
  run,
}: {
  controller: WorkspaceController;
  state: WorkspaceClientState;
  busy: boolean;
  run(task: () => Promise<unknown>): boolean;
}) {
  const [, render] = useState(0);
  type Panel = Awaited<ReturnType<WorkspaceController['openPreview']>>;
  const panel = useRef<Panel | null>(null);
  useEffect(
    () => () => {
      panel.current?.dispose();
      panel.current = null;
      render((n) => n + 1);
    },
    [controller, controller.contextRevision, state.offline],
  );
  const act = (task: (value: Panel) => Promise<unknown>) => {
    const value = panel.current;
    if (value) run(() => task(value));
  };
  const saved = state.ledger?.annotations?.[state.sessionId ?? ''];
  const reason = state.offline
    ? '执行电脑离线，重连后请手动连接预览。'
    : !state.project?.runtime.features?.includes(PREVIEW_FEATURE)
      ? '此执行电脑尚未提供项目预览能力。'
      : '';
  return (
    <>
      <button
        type="button"
        aria-label="项目预览"
        title="项目预览"
        disabled={busy}
        onClick={() =>
          run(async () => {
            panel.current?.dispose();
            panel.current = await controller.openPreview(() => render((n) => n + 1));
            render((n) => n + 1);
          })
        }
      >
        <Monitor size={16} />
        {saved?.annotations.length || ''}
      </button>
      {panel.current && (
        <ProjectPreviewPanel
          controller={panel.current.controller}
          annotations={panel.current.annotations}
          reason={reason}
          annotationLocked={busy}
          onDismiss={() =>
            act(async (value) => {
              try {
                await value.close();
              } finally {
                if (panel.current === value) panel.current = null;
                render((n) => n + 1);
              }
            })
          }
          onOptions={() => act((value) => value.controller.refreshOptions())}
          onConnect={(service, viewport) =>
            act((value) => value.controller.open(service, viewport))
          }
          onClose={() => act((value) => value.controller.close())}
          onCapture={() => act((value) => value.controller.capture())}
          onInspect={() => act((value) => value.controller.inspect())}
          onLocate={(x, y) => act((value) => value.controller.locate(x, y))}
          onInteract={(action) => act((value) => value.controller.interact(action))}
          onSave={(note, includeImage) =>
            new Promise<void>((resolve, reject) => {
              const value = panel.current;
              if (!value) {
                reject(Error('预览面板已关闭。'));
                return;
              }
              if (
                !run(async () => {
                  try {
                    await value.annotations.save(value.controller.annotation(note, includeImage));
                    resolve();
                  } catch (error) {
                    reject(error);
                  }
                })
              )
                reject(Error('另一项操作尚未结束。'));
            })
          }
          onSelect={(id, selected) => act((value) => value.annotations.select(id, selected))}
          onRemove={(id) => act((value) => value.annotations.remove(id))}
          onEdit={(id, note) =>
            act(async (value) => {
              const item = value.annotations.items.find((entry) => entry.id === id);
              if (!item) throw Error('原标注不存在。');
              await value.annotations.save({ ...item.snapshot, note }, id);
            })
          }
          onImage={(id) => act((value) => value.addImage(id))}
        />
      )}
    </>
  );
}
