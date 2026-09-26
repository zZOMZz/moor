import { useEffect, useId, useRef, useState } from 'react';
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
  LoaderCircle,
  MessageSquare,
  ShieldQuestion,
  Search,
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
  navigationSessionQuery,
  type NavigationProject,
} from './workspace-navigation-pages';
export {
  useNavigationSessions,
  navigationProjects,
  projectKey,
  workspaceKey,
  logicalProjectGroups,
  navigationSessionQuery,
  type NavigationProject,
} from './workspace-navigation-pages';

type RowAction = (
  session: SessionMetadata,
  action: SessionAction['action'],
  title?: string,
  done?: () => void,
  failed?: (message: string) => void,
) => void;
type NavigationAttention = 'approval';

export function NavigationSessionRow({
  session,
  selected,
  disabled,
  online,
  title,
  context,
  attention,
  onOpen,
  onAction,
}: {
  session: SessionMetadata;
  selected?: boolean;
  disabled: boolean;
  online: boolean;
  title?: string;
  context?: string;
  attention?: NavigationAttention;
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
  const activity = session.isArchived
    ? '已归档'
    : attention === 'approval'
      ? '等待审批'
      : working
        ? online
          ? '进行中'
          : '进行中（上次同步）'
        : '';
  const StatusIcon = session.isArchived
    ? Archive
    : attention === 'approval'
      ? ShieldQuestion
      : working
        ? LoaderCircle
        : MessageSquare;
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
          data-activity={
            session.isArchived ? undefined : (attention ?? (working ? 'working' : undefined))
          }
          data-offline={!online || undefined}
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
            title={[title ?? label, session.agentType, activity].filter(Boolean).join(' · ')}
            aria-label={[label, context, activity].filter(Boolean).join('，')}
            aria-keyshortcuts="Shift+F10"
            onClick={onOpen}
          >
            <StatusIcon size={14} className="workspace-session-status" aria-hidden="true" />
            <span className="workspace-session-title">{label}</span>
            {context && <span className="workspace-session-context">{context}</span>}
          </button>
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
  query = '',
  selectedAttention,
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
  query?: string;
  selectedAttention?: NavigationAttention;
}) {
  return (
    <section
      className={'workspace-navigation-section workspace-' + kind}
      aria-label={kind === 'pinned' ? '置顶会话' : '最近会话'}
      aria-busy={loading || undefined}
    >
      <h2 className="workspace-navigation-heading">
        <span>{kind === 'pinned' ? '置顶' : '最近'}</span>
        {!!entries.length && (
          <span
            className="workspace-navigation-count"
            title={`已加载 ${entries.length} 项${more ? '，还有更多会话' : ''}`}
          >
            {entries.length}
            {more ? '+' : ''}
          </span>
        )}
      </h2>
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
              title={
                (session.title || '未命名会话') +
                ' · ' +
                project.projectName +
                ' · ' +
                project.hostName
              }
              context={project.hostName}
              attention={selected === key ? selectedAttention : undefined}
              onOpen={() => onOpen(project, session)}
              onAction={(...args) => onAction(project, ...args)}
            />
          );
        })}
      </ul>
      {loading && !entries.length && (
        <p className="workspace-navigation-empty" role="status">
          <LoaderCircle className="workspace-navigation-loading" size={14} aria-hidden="true" />
          正在读取会话…
        </p>
      )}
      {!entries.length && !loading && !error && (
        <p className="workspace-navigation-empty">
          {query.trim() ? (
            <Search size={14} aria-hidden="true" />
          ) : kind === 'pinned' ? (
            <Pin size={14} aria-hidden="true" />
          ) : (
            <MessageSquare size={14} aria-hidden="true" />
          )}
          <span>
            {query.trim()
              ? `没有匹配的${kind === 'pinned' ? '置顶' : '最近'}会话`
              : kind === 'pinned'
                ? '置顶常用会话，方便继续'
                : '新建对话，开始第一项任务'}
          </span>
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
  grouped = false,
  selectedAttention,
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
  onRefresh(project: NavigationProject): void | Promise<void>;
  controller?: WorkspaceController;
  revision?: number;
  grouped?: boolean;
  selectedAttention?: NavigationAttention;
}) {
  const [expanded, setExpanded] = useState(false),
    [all, setAll] = useState(false),
    [archived, setArchived] = useState(false);
  const [searchExpansion, setSearchExpansion] = useState<{ query: string; open: boolean }>();
  const listId = useId();
  const paged = typeof controller?.listProjectSessionPage === 'function';
  const effectiveQuery = navigationSessionQuery(project, query);
  const searchQuery = query.trim();
  const open = searchQuery
    ? searchExpansion?.query === searchQuery
      ? searchExpansion.open
      : true
    : expanded;
  const setOpen = (value: boolean) => {
    if (searchQuery) setSearchExpansion({ query: searchQuery, open: value });
    else setExpanded(value);
  };
  const pageScope = canonical([projectKey(project), effectiveQuery, archived]);
  const [loaded, setLoaded] = useState<{
    controller: WorkspaceController;
    scope: string;
    page: WorkspaceSessionPage;
  }>();
  const page =
    loaded?.controller === controller && loaded?.scope === pageScope ? loaded.page : undefined;
  const [pageError, setPageError] = useState<string>();
  const [pageLoading, setPageLoading] = useState(false);
  const [manualLoading, setManualLoading] = useState(false);
  const visibleLoading = pageLoading || manualLoading;
  const readVersion = useRef(0);
  const pageIdentity = canonical([
    projectKey(project),
    project.online,
    revision,
    effectiveQuery,
    archived,
  ]);
  const loadPage = async (more = false, fresh = false, background = false) => {
    if (!paged || !controller || (more && !page?.nextCursor)) return;
    const serial = ++readVersion.current,
      previous = page;
    // Metadata notifications refresh the same list without removing its rows
    // or announcing a new load. A different query/project has no reusable page.
    const quiet = background && !!previous;
    setPageLoading(!quiet);
    if (!quiet) setPageError(undefined);
    try {
      const next = await controller.listProjectSessionPage(project.source, project.target, {
        archived: archived ? 'archived' : 'active',
        pinned: archived ? 'all' : 'unpinned',
        query: effectiveQuery,
        limit: 30,
        ...(more ? { cursor: previous!.nextCursor! } : {}),
        fresh: fresh || more,
      });
      if (readVersion.current === serial) {
        setLoaded({
          controller,
          scope: pageScope,
          page: more ? appendNavigationPage(previous!, next) : next,
        });
        setPageError(undefined);
      }
    } catch (error) {
      if (readVersion.current === serial) {
        const cached = more && previous && isWorkspaceListOfflineFailure(error);
        setLoaded(
          cached
            ? {
                controller,
                scope: pageScope,
                page: { ...previous, source: 'cache', partial: true },
              }
            : undefined,
        );
        setPageError(cached ? '下一页尚未缓存，请连接后再读取。' : sessionPageError(error));
      }
    } finally {
      if (readVersion.current === serial) setPageLoading(false);
    }
  };
  const refreshProject = async () => {
    const serial = readVersion.current;
    setManualLoading(true);
    try {
      await onRefresh(project);
    } catch (error) {
      if (readVersion.current === serial) setPageError(sessionPageError(error));
    } finally {
      setManualLoading(false);
    }
  };
  useEffect(() => {
    if (open && paged) void loadPage(false, true, true);
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
            ((session.title || '未命名会话')
              .toLocaleLowerCase()
              .includes(effectiveQuery.toLocaleLowerCase()) ||
              session.id.toLocaleLowerCase().includes(effectiveQuery.toLocaleLowerCase())),
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
          aria-controls={listId}
          title={`${project.projectName} · ${project.hostName}${project.online ? '' : ' · 离线'}`}
          onClick={() => setOpen(!open)}
        >
          <span className="workspace-project-marker">
            <Folder size={15} />
            <ChevronRight size={15} data-expanded={open} />
          </span>
          <span className="workspace-project-name">
            {grouped ? project.hostName : project.projectName}
            <small>
              {grouped
                ? (project.runtime.projects.find(
                    (entry) => entry.id === project.target.localProjectId,
                  )?.rootPath ?? project.projectName)
                : project.hostName}
              {project.source === 'local' ? ' · 本机' : ''}
              {project.online ? '' : ' · 离线'}
            </small>
          </span>
        </button>
        {open && (paged ? page : sessions) && !!shown.length && (
          <span
            className="workspace-navigation-count workspace-project-count"
            title={`已加载 ${shown.length} 项${page?.nextCursor ? '，还有更多会话' : ''}`}
          >
            {shown.length}
            {page?.nextCursor ? '+' : ''}
          </span>
        )}
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
                      setOpen(true);
                    }}
                  >
                    <Archive />
                    {archived ? '查看最近会话' : '查看已归档'}
                  </Menu.Item>
                  <Menu.Item
                    className="menu-item"
                    disabled={disabled}
                    onClick={() => void refreshProject()}
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
      <div
        className="workspace-session-list"
        id={listId}
        hidden={!open}
        aria-busy={visibleLoading || undefined}
      >
        {open && (
          <>
            {archived && (
              <div className="workspace-archived-label">
                已归档<button onClick={() => setArchived(false)}>返回最近</button>
              </div>
            )}
            {(paged ? pageError : unavailable) && (
              <p className="workspace-muted" role="status">
                {pageError ?? '暂时无法同步'}
                <button disabled={disabled || visibleLoading} onClick={() => void refreshProject()}>
                  重新读取
                </button>
              </p>
            )}
            {(paged ? (pageLoading && !page) || manualLoading : !sessions && !unavailable) && (
              <p className="workspace-navigation-empty" role="status">
                <LoaderCircle
                  className="workspace-navigation-loading"
                  size={14}
                  aria-hidden="true"
                />
                正在读取会话…
              </p>
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
                  attention={
                    selected && selectedSession === session.id ? selectedAttention : undefined
                  }
                  onOpen={() => onOpen(project, session)}
                  onAction={(...args) => onAction(project, ...args)}
                />
              ))}
            </ul>
            {(paged ? page : sessions) && !shown.length && (
              <p className="workspace-navigation-empty">
                {page?.source === 'cache'
                  ? '当前缓存没有匹配的会话'
                  : query
                    ? '没有匹配的会话'
                    : archived
                      ? '还没有归档会话'
                      : '从新建对话开始'}
              </p>
            )}
            {paged && page?.nextCursor && (
              <button
                className="workspace-show-more"
                disabled={disabled || visibleLoading}
                onClick={() => void loadPage(true)}
              >
                {visibleLoading ? '正在读取…' : '加载更多会话'}
              </button>
            )}
            {(!paged || page?.legacy) && !query && !archived && shown.length > 5 && (
              <button className="workspace-show-more" onClick={() => setAll(!all)}>
                {all ? '收起' : '展开显示'}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
