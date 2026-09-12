import { Login, type LoginProps } from './login';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Dialog } from '@base-ui/react/dialog';
import { Menu } from '@base-ui/react/menu';
import { Select } from '@base-ui/react/select';
import { Popover } from '@base-ui/react/popover';
import {
  ArrowUp,
  Bot,
  ChevronDown,
  Check,
  Cpu,
  Folder,
  LogOut,
  Monitor,
  MoreHorizontal,
  PanelLeft,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquarePen,
  X,
  RefreshCw,
} from 'lucide-react';
import type { Workspace } from '../catalog';
import type { RunCapabilities, RunSelection } from '../run-config';
import type { SessionSummary } from './navigation';

// React owns the chrome and controls. The existing protocol controller owns only
// the empty content slots, preserving the host-confirmed delivery state machine.
let applicationRoot: Root | undefined;
const views = new Map<string, ReactNode>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function Content({ name }: { name: string }) {
  return useSyncExternalStore(
    subscribe,
    () => views.get(name) ?? null,
    () => null,
  );
}
export function paint(selector: string, node: ReactNode) {
  if (selector === '#app') {
    applicationRoot ??= createRoot(document.querySelector('#app')!);
    flushSync(() => applicationRoot!.render(node));
  } else {
    flushSync(() => {
      views.set(selector, node);
      listeners.forEach((listener) => listener());
    });
  }
}
export function disposeUI() {
  if (applicationRoot) flushSync(() => applicationRoot!.unmount());
  applicationRoot = undefined;
  views.clear();
}
let closeDrawer = () => {};
export function closeNavigation() {
  flushSync(() => closeDrawer());
}

export function Shell({
  onSend,
  onDraft,
  onCancel,
}: {
  onSend: () => void;
  onDraft: (value: string) => void;
  onCancel: () => void;
}) {
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 760px)').matches);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    closeDrawer = () => setOpen(false);
    const media = matchMedia('(max-width: 760px)');
    const update = () => {
      setMobile(media.matches);
      setOpen(false);
    };
    media.addEventListener('change', update);
    return () => {
      media.removeEventListener('change', update);
      closeDrawer = () => {};
    };
  }, []);
  return (
    <div className="workspace-shell">
      <Dialog.Root
        open={!mobile || open}
        onOpenChange={(value) => {
          if (mobile) setOpen(value);
        }}
        modal={mobile}
      >
        <Dialog.Portal keepMounted>
          <Dialog.Backdrop className="nav-backdrop" />
          <Dialog.Popup
            className="sidebar"
            initialFocus={mobile}
            id="navigation"
            aria-label="工作区与会话"
          >
            <Dialog.Title className="sr-only">工作区与会话</Dialog.Title>
            <div className="sidebar-brand">
              <img className="moor-logo" src="/moor-logo.png" alt="Moor" width="108" height="36" />
              <Dialog.Close className="icon-button mobile-only" aria-label="关闭会话列表">
                <X />
              </Dialog.Close>
            </div>
            <div id="navigation-content">
              <Content name="#navigation-content" />
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
        <main className="workspace-main">
          <header className="session-toolbar">
            <Dialog.Trigger
              id="nav-toggle"
              className="icon-button mobile-only"
              aria-label="选择工作区和会话"
            >
              <PanelLeft />
            </Dialog.Trigger>
            <div id="target">
              <Content name="#target" />
            </div>
          </header>
          <div id="notice" role="alert" />
          <div id="history" aria-label="会话内容">
            <div className="welcome">
              <div className="welcome-mark">
                <Sparkles />
              </div>
              <h1>在这里，接着做下去。</h1>
              <p>选择一个项目，继续你的工作。</p>
            </div>
          </div>
          <form
            id="composer"
            hidden
            onSubmit={(e) => {
              e.preventDefault();
              onSend();
            }}
          >
            <div id="new-options">
              <Content name="#new-options" />
            </div>
            <div className="prompt-surface">
              <label className="sr-only" htmlFor="prompt">
                发送给 Agent 的指令
              </label>
              <textarea
                id="prompt"
                placeholder="描述接下来要做的事…"
                rows={1}
                onChange={(e) => {
                  resizeComposer(e.currentTarget);
                  onDraft(e.currentTarget.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    document.querySelector<HTMLButtonElement>('#send')?.click();
                  }
                }}
              />
              <div className="composer-actions">
                <button
                  type="button"
                  id="cancel"
                  className="icon-button stop-button"
                  hidden
                  onClick={onCancel}
                  aria-label="停止当前任务"
                >
                  <Square />
                </button>
                <button className="send-button" id="send" aria-label="发送指令">
                  <Content name="#send" />
                </button>
              </div>
            </div>
            <div id="run-options">
              <Content name="#run-options" />
            </div>
            <div id="draft-state" role="status" />
          </form>
        </main>
      </Dialog.Root>
      <dialog id="pair-dialog" aria-labelledby="pair-title">
        <h2 id="pair-title">连接一台电脑</h2>
        <p>在 Mac 上打开 Moor 的连接设置，填写服务地址和下面的配对码。</p>
        <code id="pair-code" />
        <p>配对码有效期 5 分钟，仅可使用一次。</p>
        <pre id="pair-command" />
        <button onClick={() => document.querySelector<HTMLDialogElement>('#pair-dialog')?.close()}>
          完成
        </button>
      </dialog>
      <dialog id="workspace-dialog" aria-label="管理工作区" />
    </div>
  );
}
export function resizeComposer(field = document.querySelector<HTMLTextAreaElement>('#prompt')) {
  if (!field) return;
  field.style.height = 'auto';
  field.style.height = `${Math.min(180, Math.max(46, field.scrollHeight))}px`;
}

function PopupMenu({
  trigger,
  label,
  children,
}: {
  trigger: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger className="menu-trigger" aria-label={label}>
        {trigger}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} className="popup-positioner">
          <Menu.Popup className="menu-popup">{children}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
export function Picker({
  id,
  label,
  icon,
  value,
  items,
  disabled,
  placeholder,
  onChange,
  allowEmpty = true,
  variant = 'compact',
}: {
  id: string;
  label: string;
  icon?: ReactNode;
  value?: string;
  items: { id: string; name: string }[];
  disabled?: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  allowEmpty?: boolean;
  variant?: 'compact' | 'context';
}) {
  const all = [
    ...(allowEmpty ? [{ id: '', name: placeholder }] : []),
    ...(value && !items.some((i) => i.id === value)
      ? [{ id: value, name: `${value}（不可用）`, disabled: true }]
      : []),
    ...items,
  ];
  return (
    <Select.Root
      value={allowEmpty ? (value ?? '') : value || null}
      onValueChange={(v) => {
        if (allowEmpty || v) onChange(v ?? '');
      }}
      items={all.map((i) => ({ value: i.id, label: i.name }))}
      disabled={disabled || (!allowEmpty && !items.length)}
    >
      <Select.Trigger
        id={id}
        className={`picker-trigger ${variant === 'context' ? 'context-picker' : ''}`}
        aria-label={label}
      >
        {icon}
        <span className="picker-label">{label}</span>
        <Select.Value className="picker-value" placeholder={placeholder} />
        <Select.Icon className="picker-chevron">
          <ChevronDown />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          sideOffset={8}
          align="start"
          alignItemWithTrigger={false}
          className="popup-positioner"
        >
          <Select.Popup className="menu-popup select-popup">
            <div className="select-heading" aria-hidden="true">
              {icon}
              <span>选择{label === 'Agent' ? ' Agent' : label}</span>
            </div>
            <Select.List className="select-list">
              {all.map((i) => (
                <Select.Item
                  key={i.id}
                  value={i.id}
                  disabled={'disabled' in i && i.disabled === true}
                  className="menu-item select-option"
                >
                  <Select.ItemText className="select-option-text">{i.name}</Select.ItemText>
                  <Select.ItemIndicator className="item-indicator select-check" keepMounted>
                    <Check />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

export type NewSessionControlsProps = {
  projects: { id: string; name: string }[];
  agents: { id: string; name: string }[];
  projectId: string;
  agentId: string;
  disabled: boolean;
  onProject: (value: string) => void;
  onAgent: (value: string) => void;
};
export function NewSessionControls(p: NewSessionControlsProps) {
  return (
    <>
      <Picker
        id="project"
        label="项目"
        icon={<Folder />}
        value={p.projectId}
        items={p.projects}
        placeholder={p.projects.length ? '选择项目' : '无可用项目'}
        disabled={p.disabled}
        allowEmpty={false}
        variant="context"
        onChange={p.onProject}
      />
      <Picker
        id="agent"
        label="Agent"
        icon={<Bot />}
        value={p.agentId}
        items={p.agents}
        placeholder={p.agents.length ? '选择 Agent' : '无可用 Agent'}
        disabled={p.disabled}
        allowEmpty={false}
        variant="context"
        onChange={p.onAgent}
      />
    </>
  );
}

type NavigationProps = {
  catalog: Workspace[];
  space?: Workspace;
  projectLabels: Record<string, string>;
  list: SessionSummary[];
  projectFilter: string;
  search: string;
  selectedSession: string;
  selectedReplica?: string;
  deviceId?: string;
  runtimeWorkspaceId?: string;
  connected: boolean;
  localOnly: boolean;
  canCreate: boolean;
  onWorkspace: (id: string) => void;
  onHost: (id: string) => void;
  onSearch: (value: string) => void;
  onProject: (value: string) => void;
  onSession: (id: string, replicaId?: string) => void;
  onNew: () => void;
  onManage: () => void;
  onPair: () => void;
  onLogout: () => void;
};
export function Navigation(p: NavigationProps) {
  const [appearance, setAppearance] = useState(() => {
    try {
      return localStorage.getItem('moor-appearance') || 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = appearance;
    try {
      localStorage.setItem('moor-appearance', appearance);
    } catch {
      /* Appearance is optional in restricted storage. */
    }
  }, [appearance]);
  const groups = new Map<string, SessionSummary[]>();
  for (const s of p.list) {
    const id = s.projectId ?? '';
    groups.set(id, [...(groups.get(id) ?? []), s]);
  }
  return (
    <>
      <div className="workspace-picker">
        <PopupMenu
          label="切换工作区"
          trigger={
            <>
              <span>{p.space?.name ?? '选择工作区'}</span>
              <ChevronDown />
            </>
          }
        >
          <Menu.Group>
            <Menu.GroupLabel className="menu-label">工作区</Menu.GroupLabel>
            {p.catalog.map((w) => (
              <Menu.Item key={w.id} className="menu-item" onClick={() => p.onWorkspace(w.id)}>
                {w.name}
                {w.id === p.space?.id && <Check />}
              </Menu.Item>
            ))}
          </Menu.Group>
          <Menu.Separator className="menu-separator" />
          <Menu.Item className="menu-item" onClick={p.onManage}>
            <Settings2 />
            管理工作区
          </Menu.Item>
        </PopupMenu>
      </div>
      <button id="new" className="new-session" disabled={!p.canCreate} onClick={p.onNew}>
        <SquarePen />
        新会话<span className="shortcut">＋</span>
      </button>
      <div className="navigation-search">
        <Search />
        <input
          id="session-search"
          type="search"
          aria-label="搜索会话、项目或电脑"
          placeholder="搜索会话…"
          value={p.search}
          onChange={(e) => p.onSearch(e.target.value)}
        />
        <PopupMenu label="筛选项目" trigger={<SlidersHorizontal />}>
          <Menu.Item className="menu-item" onClick={() => p.onProject('')}>
            全部项目{!p.projectFilter && <Check />}
          </Menu.Item>
          {p.space?.projects.map((project) => (
            <Menu.Item
              key={project.id}
              className="menu-item"
              onClick={() => p.onProject(project.id)}
            >
              {p.projectLabels[project.id] || project.name}
              {project.id === p.projectFilter && <Check />}
            </Menu.Item>
          ))}
        </PopupMenu>
      </div>
      {p.projectFilter && (
        <button className="filter-chip" onClick={() => p.onProject('')}>
          {p.space?.projects.find((v) => v.id === p.projectFilter)?.name}
          <X />
        </button>
      )}
      <nav id="sessions" aria-label="会话列表">
        {[...groups].map(([id, sessions]) => (
          <section className="session-group" key={id}>
            <div className="section-label">
              <Folder />
              {p.projectLabels[id] || '项目'}
              <span>{sessions.length}</span>
            </div>
            {sessions.map((s) => (
              <button
                key={`${s.replicaId}/${s.id}`}
                className={`session ${s.id === p.selectedSession && s.replicaId === p.selectedReplica ? 'selected' : ''}`}
                aria-current={
                  s.id === p.selectedSession && s.replicaId === p.selectedReplica
                    ? 'page'
                    : undefined
                }
                onClick={() => p.onSession(s.id, s.replicaId)}
              >
                <span className="session-title truncate">{s.title || '新会话'}</span>
                <small>
                  {s.deviceName || '执行电脑'}
                  <span>
                    {s.lastMessageAt && s.lastMessageAt > 86400000
                      ? new Date(s.lastMessageAt).toLocaleDateString([], {
                          month: 'numeric',
                          day: 'numeric',
                        })
                      : ''}
                  </span>
                </small>
              </button>
            ))}
          </section>
        ))}
        {!p.list.length && (
          <p className="empty">
            {p.search || p.projectFilter ? '没有匹配的会话' : '从一段新会话开始。'}
          </p>
        )}
      </nav>
      <div className="sidebar-bottom">
        <PopupMenu
          label="我的电脑"
          trigger={
            <>
              <Monitor />
              <span>我的电脑</span>
              <small>{p.space?.hosts.filter((h) => h.online).length ?? 0} 台在线</small>
            </>
          }
        >
          <div className="menu-label">为新会话选择执行电脑</div>
          {p.space?.hosts.map((h) => (
            <Menu.Item key={h.id} className="menu-item" onClick={() => p.onHost(h.id)}>
              <i className={`dot ${h.online ? 'online' : ''}`} />
              <span>
                {h.name}
                <small>{h.online ? '在线' : '离线 · 可读缓存'}</small>
              </span>
              {h.deviceId === p.deviceId && h.runtimeWorkspaceId === p.runtimeWorkspaceId && (
                <Check />
              )}
            </Menu.Item>
          ))}
          {!p.localOnly && (
            <>
              <Menu.Separator className="menu-separator" />
              <Menu.Item className="menu-item" onClick={p.onPair}>
                <Plus />
                添加电脑
              </Menu.Item>
            </>
          )}
        </PopupMenu>
        <div className="sidebar-account">
          <span className={`connection-state ${p.connected ? '' : 'disconnected'}`} id="connection">
            <i className={`dot ${p.connected ? 'online' : ''}`} />
            {p.connected ? (p.localOnly ? '本机工作区' : '已连接') : '连接中断 · 可读缓存'}
          </span>
          <PopupMenu label="设置与账号" trigger={<MoreHorizontal />}>
            <div className="menu-label">外观</div>
            <Menu.RadioGroup value={appearance} onValueChange={setAppearance}>
              {[
                { id: 'system', name: '跟随系统' },
                { id: 'light', name: '浅色' },
                { id: 'dark', name: '深色' },
              ].map((theme) => (
                <Menu.RadioItem key={theme.id} value={theme.id} className="menu-item">
                  {theme.name}
                  <Menu.RadioItemIndicator className="item-indicator">
                    <Check />
                  </Menu.RadioItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
            <Menu.Separator className="menu-separator" />
            <Menu.Item className="menu-item" onClick={p.onManage}>
              <Settings2 />
              管理工作区
            </Menu.Item>
            {!p.localOnly && (
              <Menu.Item className="menu-item" onClick={p.onLogout}>
                <LogOut />
                退出登录
              </Menu.Item>
            )}
          </PopupMenu>
        </div>
      </div>
    </>
  );
}

export function Target({
  project,
  title,
  host,
  path,
  connected,
  online,
}: {
  project?: string;
  title?: string;
  host?: string;
  path?: string;
  connected: boolean;
  online: boolean;
}) {
  return (
    <>
      <div className="session-heading min-w-0">
        <span>{project || '工作区'}</span>
        <span className="breadcrumb-divider">/</span>
        <h1>{title || '新会话'}</h1>
      </div>
      <Popover.Root>
        <Popover.Trigger className="host-trigger" aria-label="执行电脑与连接状态">
          <i className={`dot ${online && connected ? 'online' : ''}`} />
          <span>{host || '选择电脑'}</span>
          <ChevronDown />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner sideOffset={10} align="end" className="popup-positioner">
            <Popover.Popup className="connection-popup">
              <Popover.Title>{host || '尚未选择执行电脑'}</Popover.Title>
              <dl>
                <dt>访问连接</dt>
                <dd>{connected ? '已连接' : '已断开'}</dd>
                <dt>执行电脑</dt>
                <dd>{online ? '在线' : '离线'}</dd>
                {path && (
                  <>
                    <dt>项目目录</dt>
                    <dd className="project-path">{path}</dd>
                  </>
                )}
              </dl>
              <Popover.Description>此会话始终由这台电脑执行。</Popover.Description>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}

export type RunControlsProps = {
  capabilities?: RunCapabilities;
  selection: RunSelection;
  agentType?: string;
  disabled: boolean;
  loading: boolean;
  canRefresh: boolean;
  validation: string;
  existing: boolean;
  onChange: (key: keyof RunSelection, value: string) => void;
  onRefresh: () => void;
};
export function RunControls(p: RunControlsProps) {
  const models = p.capabilities?.models ?? [];
  const efforts = models.find((m) => m.id === p.selection.modelId)?.efforts ?? [];
  const modes = p.capabilities?.modes ?? [];
  const labels: Record<string, string> =
    p.agentType === 'codex'
      ? {
          'read-only': '只读',
          agent: '工作区权限',
          'agent-auto-review': '自动审批审查',
          'agent-full-access': '完全访问',
        }
      : {};
  const mode = modes.find((m) => m.id === p.selection.modeId);
  return (
    <>
      <div className="run-controls">
        <Picker
          id="model"
          label="模型"
          icon={<Cpu />}
          value={p.selection.modelId}
          items={models}
          disabled={p.disabled}
          placeholder="Agent 默认"
          onChange={(v) => p.onChange('modelId', v)}
        />
        <Popover.Root>
          {p.selection.modeId === 'agent-full-access' && (
            <span className="permission-summary">完全访问</span>
          )}
          <Popover.Trigger className="run-settings-trigger" aria-label="运行设置">
            <SlidersHorizontal />
            <span>运行设置</span>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner sideOffset={10} align="end" className="popup-positioner">
              <Popover.Popup className="connection-popup run-settings-popup">
                <div className="run-settings-heading">
                  <Popover.Title>运行设置</Popover.Title>
                  <Popover.Close className="icon-button" aria-label="关闭运行设置">
                    <X />
                  </Popover.Close>
                </div>
                <Popover.Description>
                  {p.existing ? '应用于下一条指令。' : '应用于这段新会话。'}
                </Popover.Description>
                <div className="run-settings-row">
                  <span>思考强度</span>
                  <Picker
                    id="effort"
                    label="思考强度"
                    value={p.selection.reasoningEffort}
                    items={efforts.map((e) => ({ id: e, name: e }))}
                    disabled={p.disabled || !efforts.length}
                    placeholder={
                      !p.selection.modelId ? '先选模型' : efforts.length ? '默认' : '不支持'
                    }
                    onChange={(v) => p.onChange('reasoningEffort', v)}
                  />
                </div>
                <div className="run-settings-row">
                  <span>审批权限</span>
                  <Picker
                    id="approval-mode"
                    label="审批"
                    value={p.selection.modeId}
                    items={modes.map((m) => ({ id: m.id, name: labels[m.id] || m.name }))}
                    disabled={p.disabled}
                    placeholder="Agent 默认"
                    onChange={(v) => p.onChange('modeId', v)}
                  />
                </div>
                {mode?.description && <p>{mode.description}</p>}
                {p.selection.modeId === 'agent-full-access' && (
                  <p>完全访问允许更广的文件和执行权限。</p>
                )}
                <button
                  type="button"
                  id="refresh-run-options"
                  className="refresh-run-options"
                  disabled={!p.canRefresh || p.disabled}
                  onClick={p.onRefresh}
                >
                  <RefreshCw />
                  刷新可用选项
                </button>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </div>
      {(p.validation || p.loading || !p.capabilities) && (
        <p
          className={`run-description ${p.validation ? 'invalid' : ''}`}
          role={p.validation ? 'alert' : 'status'}
        >
          {p.validation ||
            (p.loading
              ? '正在读取模型与权限选项…'
              : '暂未获取选项，可在运行设置中刷新；留空沿用 Agent 设置。')}
        </p>
      )}
    </>
  );
}
export function showShell(props: Parameters<typeof Shell>[0]) {
  disposeUI();
  paint('#app', <Shell {...props} />);
}
export function showNavigation(props: NavigationProps) {
  paint('#navigation-content', <Navigation {...props} />);
}
export function showTarget(props: Parameters<typeof Target>[0]) {
  paint('#target', <Target {...props} />);
}
export function showRunControls(props: RunControlsProps) {
  paint('#run-options', <RunControls {...props} />);
}
export function showNewSessionControls(props: NewSessionControlsProps | null) {
  paint('#new-options', props ? <NewSessionControls {...props} /> : null);
}
export function sendIcon(state: 'sending' | 'pending' | 'ready') {
  paint(
    '#send',
    state === 'ready' ? (
      <ArrowUp />
    ) : state === 'pending' ? (
      <>重试确认</>
    ) : (
      <RefreshCw className="spin" />
    ),
  );
}

export function showAuth(props: LoginProps) {
  disposeUI();
  paint('#app', <Login {...props} />);
}
