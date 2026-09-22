import { useEffect, useRef, useState } from 'react';
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
import {
  isWorkspaceListOfflineFailure,
  type WorkspaceController,
  type WorkspaceSessionPage,
} from '../workspace/workspace-controller';
import type { SessionMetadata } from '@moor/protocol/session-responses';
import type { SessionAction } from '@moor/protocol/protocol';
import { productCanonicalJson as canonical } from '@moor/protocol/canonical-json';

import {
  projectKey,
  appendNavigationPage,
  sessionPageError,
  type NavigationProject,
} from './workspace-navigation-pages';
export {
  useNavigationSessions,
  navigationProjects,
  projectKey,
  workspaceKey,
  type NavigationProject,
} from './workspace-navigation-pages';

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
  more = false,
  loading = false,
  cached = false,
  legacy = false,
  error = false,
  onLoadMore,
  onRefresh,
}: {
  entries: { project: NavigationProject; session: SessionMetadata }[];
  selected?: string;
  disabled: boolean;
  onOpen(project: NavigationProject, session: SessionMetadata): void;
  onAction: ProjectAction;
  kind: 'pinned' | 'recent';
  more?: boolean;
  loading?: boolean;
  cached?: boolean;
  legacy?: boolean;
  error?: boolean;
  onLoadMore?(): void;
  onRefresh?(): void;
}) {
  return (
    <section
      className={'workspace-navigation-section workspace-' + kind}
      aria-label={kind === 'pinned' ? '置顶会话' : '最近会话'}
    >
      <h2>{kind === 'pinned' ? '置顶' : '最近'}</h2>
      {cached && (
        <p className="workspace-muted" role="status">
          仅显示本机已缓存的会话
        </p>
      )}
      {legacy && <p className="workspace-muted">含旧主机兼容目录</p>}
      {error && (
        <p className="workspace-muted" role="status">
          部分列表尚未确认 <button onClick={onRefresh}>重新读取</button>
        </p>
      )}
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
      {more && (
        <button className="workspace-show-more" disabled={loading || disabled} onClick={onLoadMore}>
          {loading ? '正在读取…' : `加载更多${kind === 'pinned' ? '置顶' : '最近'}会话`}
        </button>
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
  controller,
  revision = 0,
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
  controller?: WorkspaceController;
  revision?: number;
}) {
  const [expanded, setExpanded] = useState(false),
    [all, setAll] = useState(false),
    [archived, setArchived] = useState(false);
  const paged = typeof controller?.listProjectSessionPage === 'function';
  const open = expanded;
  const [page, setPage] = useState<WorkspaceSessionPage>();
  const [pageError, setPageError] = useState<string>();
  const [pageLoading, setPageLoading] = useState(false);
  const readVersion = useRef(0);
  const pageIdentity = canonical([
    projectKey(project),
    project.online,
    revision,
    query.trim(),
    archived,
  ]);
  const loadPage = async (more = false, fresh = false) => {
    if (!paged || !controller || (more && !page?.nextCursor)) return;
    const serial = ++readVersion.current,
      previous = page;
    setPageLoading(true);
    setPageError(undefined);
    if (!more) setPage(undefined);
    try {
      const next = await controller.listProjectSessionPage(project.source, project.target, {
        archived: archived ? 'archived' : 'active',
        pinned: archived ? 'all' : 'unpinned',
        query: query.trim(),
        limit: 30,
        ...(more ? { cursor: previous!.nextCursor! } : {}),
        fresh: fresh || more,
      });
      if (readVersion.current === serial)
        setPage(more ? appendNavigationPage(previous!, next) : next);
    } catch (error) {
      if (readVersion.current === serial) {
        const cached = more && previous && isWorkspaceListOfflineFailure(error);
        setPage(cached ? { ...previous, source: 'cache', partial: true } : undefined);
        setPageError(cached ? '下一页尚未缓存，请连接后再读取。' : sessionPageError(error));
      }
    } finally {
      if (readVersion.current === serial) setPageLoading(false);
    }
  };
  useEffect(() => {
    if (open && paged) void loadPage(false, true);
    return () => {
      readVersion.current++;
    };
  }, [controller, open, pageIdentity]);
  const shown = paged
    ? (page?.items ?? [])
    : (sessions ?? [])
        .filter(
          (session) =>
            Boolean(session.isArchived) === archived &&
            (archived || !session.isPinned) &&
            (session.title || '未命名会话').toLocaleLowerCase().includes(query.toLocaleLowerCase()),
        )
        .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  const visible =
    paged && !page?.legacy ? shown : all || query || archived ? shown : shown.slice(0, 5);
  const listOnline = project.online && !unavailable && !pageError && page?.source !== 'cache';
  return (
    <section className="workspace-project-group" aria-label={project.projectName}>
      <div className="workspace-project-heading" data-selected={selected || undefined}>
        <button
          className="workspace-project"
          aria-expanded={open}
          title={`${project.projectName} · ${project.hostName}${project.online ? '' : ' · 离线'}`}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="workspace-project-marker">
            <Folder size={15} />
            <ChevronRight size={15} data-expanded={open} />
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
            disabled={disabled || !listOnline || !project.runtime.agents.length}
            onClick={() => onCreate(project)}
          >
            <SquarePen size={15} />
          </button>
        </div>
      </div>
      {open && (
        <div className="workspace-session-list">
          {archived && (
            <div className="workspace-archived-label">
              已归档<button onClick={() => setArchived(false)}>返回最近</button>
            </div>
          )}
          {(paged ? pageError : unavailable) && (
            <p className="workspace-muted" role="status">
              {pageError ?? '暂时无法同步'}
              <button disabled={disabled || pageLoading} onClick={() => onRefresh(project)}>
                重新读取
              </button>
            </p>
          )}
          {(paged ? pageLoading && !page : !sessions && !unavailable) && (
            <p className="workspace-muted">正在读取会话…</p>
          )}
          {page?.source === 'cache' && (
            <p className="workspace-muted" role="status">
              仅显示本机已缓存的 {shown.length} 项；未缓存页面不可读取。
            </p>
          )}
          {page?.legacy && <p className="workspace-muted">旧主机兼容目录</p>}
          <ul>
            {visible.map((session) => (
              <NavigationSessionRow
                key={session.id}
                session={session}
                selected={selected && selectedSession === session.id}
                disabled={disabled}
                online={listOnline}
                onOpen={() => onOpen(project, session)}
                onAction={(...args) => onAction(project, ...args)}
              />
            ))}
          </ul>
          {(paged ? page : sessions) && !shown.length && (
            <p className="workspace-muted">
              {page?.source === 'cache'
                ? '当前缓存没有匹配的会话'
                : query
                  ? '没有匹配的会话'
                  : archived
                    ? '还没有归档会话'
                    : '还没有会话'}
            </p>
          )}
          {paged && page?.nextCursor && (
            <button
              className="workspace-show-more"
              disabled={disabled || pageLoading}
              onClick={() => void loadPage(true)}
            >
              {pageLoading ? '正在读取…' : '加载更多会话'}
            </button>
          )}
          {paged && page && !page.legacy && (
            <p className="workspace-muted">
              已加载 {shown.length} 项{page.nextCursor ? '，还有更多会话' : ''}
            </p>
          )}
          {(!paged || page?.legacy) && !query && !archived && shown.length > 5 && (
            <button className="workspace-show-more" onClick={() => setAll(!all)}>
              {all ? '收起' : '展开显示'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
