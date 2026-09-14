import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Search, Ellipsis } from 'lucide-react';
import { SessionSearchPanel } from './session-search-ui';
import type { SessionSearchView } from './session-search';
import type { SessionMetadata } from '../session-responses';
import type { SessionAction } from '../protocol';
import type { WorkspaceController, WorkspaceClientState } from './workspace-controller';

export function WorkspaceSessionTools({
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
  const [searching, setSearching] = useState(false),
    [result, setResult] = useState<SessionSearchView>();
  const [error, setError] = useState('');
  const search = useRef<ReturnType<WorkspaceController['openSearch']> | null>(null);
  const [metadata, setMetadata] = useState<SessionMetadata>(),
    [title, setTitle] = useState('');
  const closeSearch = () => {
    search.current?.close();
    search.current = null;
    setSearching(false);
    setResult(undefined);
    setError('');
  };
  useEffect(
    () => () => {
      search.current?.close();
      search.current = null;
    },
    [controller, controller.contextRevision],
  );
  const action = (kind: SessionAction['action']) =>
    run(async () => {
      await controller.metadata(kind, kind === 'rename' ? title : undefined, metadata);
      setMetadata(undefined);
    });
  return (
    <>
      <button
        type="button"
        aria-label="正文搜索"
        title="正文搜索"
        disabled={busy}
        onClick={() => {
          closeSearch();
          search.current = controller.openSearch();
          setSearching(true);
        }}
      >
        <Search size={16} />
      </button>
      <button
        type="button"
        aria-label="整理会话"
        title="整理会话"
        disabled={busy || !state.session}
        onClick={() => {
          setMetadata(structuredClone(state.session!.meta));
          setTitle(state.session!.meta.title ?? '');
        }}
      >
        <Ellipsis size={16} />
      </button>
      {searching && search.current && (
        <SessionSearchPanel
          title={state.session?.meta.title ?? ''}
          online={!state.offline}
          sessions={state.sessions.map((item) => ({
            id: item.id,
            title: item.title ?? '未命名会话',
          }))}
          busy={busy}
          error={error}
          result={result}
          onClose={closeSearch}
          onSearch={(query, scope) =>
            run(async () => {
              const current = search.current!;
              setError('');
              setResult(undefined);
              try {
                const value = await current.search(query, scope);
                if (search.current === current) setResult(value);
              } catch (cause) {
                if (search.current === current)
                  setError(cause instanceof Error ? cause.message : String(cause));
              }
            })
          }
          onOpen={(hit) =>
            run(async () => {
              await search.current!.openHit(hit);
              closeSearch();
            })
          }
        />
      )}
      {metadata && (
        <Dialog.Root open onOpenChange={(open) => !open && setMetadata(undefined)}>
          <Dialog.Portal>
            <Dialog.Backdrop className="session-dialog-backdrop" />
            <Dialog.Popup className="session-dialog workspace-metadata-panel">
              <Dialog.Title>整理会话</Dialog.Title>
              <Dialog.Description>
                更改由原执行电脑保存，未知结果可在原操作中核查。
              </Dialog.Description>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!busy && !state.offline) action('rename');
                }}
              >
                <label>
                  会话名称
                  <input
                    aria-label="会话名称"
                    value={title}
                    maxLength={200}
                    required
                    disabled={busy || state.offline}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>
                <button type="submit" disabled={busy || state.offline || !title.trim()}>
                  保存名称
                </button>
              </form>
              <button
                disabled={busy || state.offline}
                onClick={() => action(metadata.isPinned ? 'unpin' : 'pin')}
              >
                {metadata.isPinned ? '取消置顶' : '置顶会话'}
              </button>
              <button
                disabled={busy || state.offline}
                onClick={() => action(metadata.isArchived ? 'restore' : 'archive')}
              >
                {metadata.isArchived ? '恢复会话' : '归档会话'}
              </button>
              {state.offline && <p role="status">执行电脑离线；连接后请手动操作。</p>}
              <button onClick={() => setMetadata(undefined)}>关闭会话整理</button>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </>
  );
}
