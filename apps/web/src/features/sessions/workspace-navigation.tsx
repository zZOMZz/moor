import { useEffect, useMemo, useRef, useState } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import { Dialog } from '@base-ui/react/dialog';
import {
  Folder,
  ChevronRight,
  Pin,
  PinOff,
  Archive,
  ArchiveRestore,
  SquarePen,
  Ellipsis,
  RefreshCw,
} from 'lucide-react';
import type { WorkspaceController, WorkspaceClientState } from '../workspace/workspace-controller';
import type { DesktopWorkspaceSource } from '@moor/client/workspace-protocol';
import type { SessionMetadata } from '@moor/protocol/session-responses';
import type { SessionAction } from '@moor/protocol/protocol';
import { productCanonicalJson as canonical } from '@moor/client/encrypted-product';

export type NavigationProject = NonNullable<WorkspaceClientState['project']> & {
  source: DesktopWorkspaceSource;
};
export const projectKey = (entry: NavigationProject) => canonical([entry.source, entry.target]);
export const workspaceKey = (entry: NavigationProject) =>
  canonical([
    entry.source,
    entry.target.serverKey,
    entry.target.owner,
    entry.target.catalogWorkspaceId,
  ]);
export function navigationProjects(state: WorkspaceClientState): NavigationProject[] {
  return (['local', 'remote'] as const).flatMap((source) =>
    (state.catalogs[source]?.targets ?? []).map((entry) => ({ ...entry, source })),
  );
}
export function useNavigationSessions(
  controller: WorkspaceController,
  state: WorkspaceClientState,
) {
  type Entry = {
    connection: string;
    revision: number;
    sessions: SessionMetadata[];
    unavailable: boolean;
    online: boolean;
  };
  const [result, setResult] = useState<Record<string, Entry>>({});
  const reads = navigationProjects(state).map((project) => ({
    project,
    key: projectKey(project),
    connection: canonical([
      state.catalogs[project.source]?.connectionId,
      state.catalogs[project.source]?.actor ?? null,
    ]),
    revision:
      controller.projectRevision?.(project.source, project.target) ??
      controller.navigationRevision ??
      0,
  }));
  const signature = canonical(reads.map(({ project, ...read }) => [read, project.online]));
  const reader = useMemo(
    () => ({
      active: true,
      running: false,
      desired: [] as typeof reads,
      cache: {} as Record<string, Entry>,
      inFlight: new Set<string>(),
    }),
    [controller],
  );
  useEffect(() => {
    reader.active = true;
    return () => {
      reader.active = false;
    };
  }, [reader]);
  useEffect(() => {
    reader.desired = reads;
    const keys = new Set(reads.map((read) => read.key));
    for (const key of Object.keys(reader.cache)) if (!keys.has(key)) delete reader.cache[key];
    const needed = (read: (typeof reads)[number]) => {
      const previous = reader.cache[read.key];
      return (
        !previous ||
        previous.connection !== read.connection ||
        previous.revision !== read.revision ||
        previous.online !== read.project.online
      );
    };
    const publish = () => {
      if (reader.active) setResult({ ...reader.cache });
    };
    const start = () => {
      if (!reader.active || reader.running) return;
      reader.running = true;
      async function worker() {
        while (reader.active) {
          const read = reader.desired.find(
            (entry) => !reader.inFlight.has(entry.key) && needed(entry),
          );
          if (!read) return;
          reader.inFlight.add(read.key);
          const { project, key, connection, revision } = read;
          let sessions: SessionMetadata[] = [],
            unavailable = false;
          try {
            sessions = await controller.listProjectSessions(project.source, project.target);
          } catch {
            unavailable = true;
            if (reader.cache[key]?.connection === connection)
              sessions = reader.cache[key]!.sessions;
          } finally {
            reader.inFlight.delete(key);
          }
          if (
            reader.desired.some((entry) => entry.key === key && entry.connection === connection)
          ) {
            reader.cache[key] = {
              connection,
              revision,
              online: project.online,
              sessions,
              unavailable,
            };
            publish();
          }
        }
      }
      // Keep four workers across invalidations. A burst only replaces the desired revision;
      // it cannot restart another batch while older network reads are still pending.
      void Promise.all(Array.from({ length: 4 }, worker)).finally(() => {
        reader.running = false;
        if (reader.desired.some(needed)) start();
      });
    };
    publish();
    start();
  }, [controller, reader, signature]);
  const sessions: Record<string, SessionMetadata[]> = {},
    unavailable: string[] = [];
  for (const read of reads) {
    const entry = result[read.key];
    if (entry?.connection === read.connection) {
      sessions[read.key] = entry.sessions;
      if (entry.unavailable) unavailable.push(read.key);
    }
  }
  if (state.project && state.scope)
    sessions[projectKey({ ...state.project, source: state.scope.source })] = state.sessions;
  return { sessions, unavailable };
}

type RowAction = (
  session: SessionMetadata,
  action: SessionAction['action'],
  title?: string,
  done?: () => void,
  failed?: (message: string) => void,
) => void;
export function NavigationSessionRow({
  session,
  selected,
  disabled,
  online,
  title,
  onOpen,
  onAction,
}: {
  session: SessionMetadata;
  selected?: boolean;
  disabled: boolean;
  online: boolean;
  title?: string;
  onOpen(): void;
  onAction: RowAction;
}) {
  const [rename, setRename] = useState<{ reviewed: SessionMetadata; title: string }>();
  const [renameError, setRenameError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false),
    [keyboardMenu, setKeyboardMenu] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = session.title || '未命名会话';
  const working = session.status?.type === 'working';
  const manageDisabled = disabled || !online;
  const pin = session.isPinned ? '取消置顶' : '置顶';
  const archive = session.isArchived ? '恢复会话' : '归档';
  const doPin = () => onAction(session, session.isPinned ? 'unpin' : 'pin');
  const doArchive = () => onAction(session, session.isArchived ? 'restore' : 'archive');
  return (
    <li>
      <ContextMenu.Root
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (!open) setKeyboardMenu(false);
        }}
      >
        <ContextMenu.Trigger
          className="workspace-session-row"
          data-selected={selected || undefined}
          onKeyDown={(event) => {
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault();
              event.stopPropagation();
              setKeyboardMenu(true);
              setMenuOpen(true);
            }
          }}
        >
          <button
            ref={trigger}
            className="workspace-session-open"
            disabled={disabled}
            aria-current={selected ? 'page' : undefined}
            title={title ?? label}
            aria-keyshortcuts="Shift+F10"
            onClick={onOpen}
          >
            <span className="workspace-session-title">{label}</span>
            <small>{session.isArchived ? '已归档' : working ? '进行中' : session.agentType}</small>
          </button>
          {working && <span className="session-working" aria-label="进行中" title="进行中" />}
          <div className="workspace-row-actions">
            {!session.isArchived && (
              <button
                aria-label={`${pin}：${label}`}
                title={pin}
                disabled={manageDisabled}
                onClick={doPin}
              >
                {session.isPinned ? <PinOff size={14} /> : <Pin size={14} />}
              </button>
            )}
            <button
              aria-label={`${archive}：${label}`}
              title={working && !session.isArchived ? '运行中，暂不可归档' : archive}
              disabled={manageDisabled || (!session.isArchived && working)}
              onClick={doArchive}
            >
              {session.isArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            </button>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner
            className="popup-positioner"
            anchor={keyboardMenu ? trigger : undefined}
          >
            <ContextMenu.Popup className="menu-popup" finalFocus={trigger}>
              <ContextMenu.Item
                className="menu-item"
                disabled={manageDisabled}
                onClick={() => {
                  setRenameError('');
                  setRename({ reviewed: structuredClone(session), title: session.title ?? '' });
                }}
              >
                <SquarePen />
                重命名
              </ContextMenu.Item>
              {!session.isArchived && (
                <ContextMenu.Item className="menu-item" disabled={manageDisabled} onClick={doPin}>
                  {session.isPinned ? <PinOff /> : <Pin />}
                  {pin}
                </ContextMenu.Item>
              )}
              <ContextMenu.Item
                className="menu-item"
                disabled={manageDisabled || (!session.isArchived && working)}
                onClick={doArchive}
              >
                <Archive />
                {working && !session.isArchived ? '运行中，暂不可归档' : archive}
              </ContextMenu.Item>
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <Dialog.Root open={!!rename} onOpenChange={(open) => !open && setRename(undefined)}>
        <Dialog.Portal>
          <Dialog.Backdrop className="session-dialog-backdrop" />
          <Dialog.Popup className="session-dialog" finalFocus={trigger}>
            <Dialog.Title>重命名会话</Dialog.Title>
            <Dialog.Description>为这段会话设置一个容易找到的标题。</Dialog.Description>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (rename?.title.trim() && !manageDisabled) {
                  setRenameError('');
                  onAction(
                    rename.reviewed,
                    'rename',
                    rename.title.trim(),
                    () => setRename(undefined),
                    setRenameError,
                  );
                }
              }}
            >
              <input
                aria-label="会话名称"
                autoFocus
                value={rename?.title ?? ''}
                maxLength={200}
                onChange={(event) =>
                  setRename((value) => value && { ...value, title: event.target.value })
                }
              />
              {renameError && <p role="alert">{renameError}</p>}
              <div className="dialog-actions">
                <Dialog.Close>取消</Dialog.Close>
                <button type="submit" disabled={manageDisabled || !rename?.title.trim()}>
                  保存
                </button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </li>
  );
}

type ProjectAction = (project: NavigationProject, ...args: Parameters<RowAction>) => void;
export function NavigationSessions({
  entries,
  selected,
  disabled,
  onOpen,
  onAction,
  kind,
}: {
  entries: { project: NavigationProject; session: SessionMetadata }[];
  selected?: string;
  disabled: boolean;
  onOpen(project: NavigationProject, session: SessionMetadata): void;
  onAction: ProjectAction;
  kind: 'pinned' | 'recent';
}) {
  return (
    <section
      className={'workspace-navigation-section workspace-' + kind}
      aria-label={kind === 'pinned' ? '置顶会话' : '最近会话'}
    >
      <h2>{kind === 'pinned' ? '置顶' : '最近'}</h2>
      <ul>
        {entries.map(({ project, session }) => {
          const key = canonical([projectKey(project), session.id]);
          return (
            <NavigationSessionRow
              key={key}
              session={session}
              selected={selected === key}
              disabled={disabled}
              online={project.online}
              title={session.title + ' · ' + project.projectName + ' · ' + project.hostName}
              onOpen={() => onOpen(project, session)}
              onAction={(...args) => onAction(project, ...args)}
            />
          );
        })}
      </ul>
      {!entries.length && (
        <p className="workspace-muted">
          {kind === 'pinned' ? '置顶的会话会显示在这里' : '还没有最近会话'}
        </p>
      )}
    </section>
  );
}

export function NavigationProjectGroup({
  project,
  sessions,
  selected,
  selectedSession,
  disabled,
  query,
  unavailable,
  onOpen,
  onAction,
  onCreate,
  onRefresh,
}: {
  project: NavigationProject;
  sessions?: SessionMetadata[];
  selected: boolean;
  selectedSession?: string;
  disabled: boolean;
  query: string;
  unavailable: boolean;
  onOpen(project: NavigationProject, session: SessionMetadata): void;
  onAction: ProjectAction;
  onCreate(project: NavigationProject): void;
  onRefresh(project: NavigationProject): void;
}) {
  const [expanded, setExpanded] = useState(false),
    [all, setAll] = useState(false),
    [archived, setArchived] = useState(false);
  const shown = (sessions ?? [])
    .filter(
      (session) =>
        Boolean(session.isArchived) === archived &&
        (archived || !session.isPinned) &&
        (session.title || '未命名会话').toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    )
    .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  const visible = all || query || archived ? shown : shown.slice(0, 5);
  return (
    <section className="workspace-project-group" aria-label={project.projectName}>
      <div className="workspace-project-heading" data-selected={selected || undefined}>
        <button
          className="workspace-project"
          aria-expanded={expanded}
          title={`${project.projectName} · ${project.hostName}${project.online ? '' : ' · 离线'}`}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="workspace-project-marker">
            <Folder size={15} />
            <ChevronRight size={15} data-expanded={expanded} />
          </span>
          <span>
            {project.projectName}
            <small>
              {project.hostName}
              {project.source === 'local' ? ' · 本机' : ''}
              {project.online ? '' : ' · 离线'}
            </small>
          </span>
        </button>
        <div className="workspace-row-actions">
          <Menu.Root>
            <Menu.Trigger aria-label={`项目菜单：${project.projectName}`} title="项目菜单">
              <Ellipsis size={15} />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner className="popup-positioner" sideOffset={4} align="end">
                <Menu.Popup className="menu-popup">
                  <Menu.Item
                    className="menu-item"
                    onClick={() => {
                      setArchived(!archived);
                      setExpanded(true);
                    }}
                  >
                    <Archive />
                    {archived ? '查看最近会话' : '查看已归档'}
                  </Menu.Item>
                  <Menu.Item
                    className="menu-item"
                    disabled={disabled}
                    onClick={() => onRefresh(project)}
                  >
                    <RefreshCw />
                    重新同步
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
          <button
            aria-label={`在 ${project.projectName} 中新建对话`}
            title="新建对话"
            disabled={disabled || !project.online || !project.runtime.agents.length}
            onClick={() => onCreate(project)}
          >
            <SquarePen size={15} />
          </button>
        </div>
      </div>
      {expanded && (
        <div className="workspace-session-list">
          {archived && (
            <div className="workspace-archived-label">
              已归档<button onClick={() => setArchived(false)}>返回最近</button>
            </div>
          )}
          {unavailable && (
            <p className="workspace-muted" role="status">
              暂时无法同步
              <button disabled={disabled} onClick={() => onRefresh(project)}>
                重试
              </button>
            </p>
          )}
          {!sessions && !unavailable && <p className="workspace-muted">正在读取会话…</p>}
          <ul>
            {visible.map((session) => (
              <NavigationSessionRow
                key={session.id}
                session={session}
                selected={selected && selectedSession === session.id}
                disabled={disabled}
                online={project.online}
                onOpen={() => onOpen(project, session)}
                onAction={(...args) => onAction(project, ...args)}
              />
            ))}
          </ul>
          {sessions && !shown.length && (
            <p className="workspace-muted">
              {query ? '没有匹配的会话' : archived ? '还没有归档会话' : '还没有会话'}
            </p>
          )}
          {!query && !archived && shown.length > 5 && (
            <button className="workspace-show-more" onClick={() => setAll(!all)}>
              {all ? '收起' : '展开显示'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
