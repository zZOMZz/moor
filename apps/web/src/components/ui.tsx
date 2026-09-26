import { Select } from '@base-ui/react/select';
import { canonicalMode, type RunCapabilities, type RunSelection } from '@moor/protocol/run-config';
import { Check, ChevronDown, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { GoogleComplete } from '../features/auth/google-login';
import { Login, type LoginProps } from '../features/auth/login';
import { ModelMenu } from './model-menu';

let applicationRoot: Root | undefined;
/** Mount the standalone login and collaboration routes. Workspace owns its own React root. */
export function paint(selector: '#app', node: ReactNode) {
  applicationRoot ??= createRoot(document.querySelector(selector)!);
  flushSync(() => applicationRoot!.render(node));
}
export function showGoogleComplete() {
  paint('#app', <GoogleComplete />);
}
export function disposeUI() {
  if (applicationRoot) flushSync(() => applicationRoot!.unmount());
  applicationRoot = undefined;
}
export function showAuth(props: LoginProps) {
  disposeUI();
  paint('#app', <Login {...props} />);
}

function Picker({
  id,
  label,
  icon,
  value,
  items,
  disabled,
  placeholder,
  onChange,
  onOpen,
  allowEmpty = true,
  variant = 'compact',
}: {
  id: string;
  label: string;
  icon?: ReactNode;
  value?: string;
  items: { id: string; name: string; description?: string }[];
  disabled?: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onOpen?: () => void;
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
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
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
                  <Select.ItemText className="select-option-text">
                    {i.name}
                    {'description' in i && i.description && (
                      <small className="picker-description">{i.description}</small>
                    )}
                  </Select.ItemText>
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

type RunControlsProps = {
  idPrefix?: string;
  capabilities?: RunCapabilities;
  selection: RunSelection;
  agentType?: string;
  disabled: boolean;
  loading: boolean;
  canRefresh: boolean;
  validation: string;
  status?: string;
  existing: boolean;
  onChange: (key: keyof RunSelection, value: string) => void;
  onRefresh: () => void;
  onOpenModels?: () => void;
  onSaveDefaults?: (selection: RunSelection) => Promise<unknown>;
  compact?: boolean;
};

export function RunControls(p: RunControlsProps) {
  const modes = p.capabilities?.modes ?? [];
  const modeId = canonicalMode(p.selection.modeId, p.capabilities);
  const labels: Record<string, string> = {
    'moor-read-only': 'Read-only',
    'moor-agent': 'Agent',
    'moor-auto-review': 'Auto review',
    'moor-full-access': 'Full access',
  };
  const descriptions: Record<string, string> = {
    'moor-read-only': '只读文件，需要时由用户审批。',
    'moor-agent': '读写工作区，需要时由用户审批。',
    'moor-auto-review': '读写工作区，需要时由 Codex 自动审查。',
    'moor-full-access': '访问文件与网络，不请求审批。',
  };
  const compactLabels: Record<string, string> = {
    'moor-read-only': '只读',
    'moor-agent': '工作区',
    'moor-auto-review': '自动审查',
    'moor-full-access': '完全访问',
  };
  const mode = modes.find((m) => m.id === modeId);
  const approval = (
    <div className="run-approval" title={mode?.description}>
      <Picker
        id={(p.idPrefix ?? '') + 'approval-mode'}
        label="权限"
        icon={<ShieldCheck />}
        value={modeId}
        items={modes.map((m) => ({
          ...m,
          name: (p.compact ? compactLabels[m.id] : labels[m.id]) || m.name,
          description: descriptions[m.id] || m.description,
        }))}
        disabled={p.disabled}
        allowEmpty={false}
        placeholder={p.compact ? '权限未获取' : '选择权限'}
        onChange={(v) => p.onChange('modeId', v)}
      />
    </div>
  );
  const model = (
    <div className="run-model-options">
      <ModelMenu
        id={(p.idPrefix ?? '') + 'model'}
        capabilities={p.capabilities}
        selection={p.selection}
        existing={p.existing}
        disabled={p.disabled}
        loading={p.loading}
        onChange={p.onChange}
        onSaveDefault={p.onSaveDefaults}
        compact={p.compact}
      />
    </div>
  );
  return (
    <>
      <div className="run-controls">
        {p.compact ? model : approval}
        {p.compact ? approval : model}
      </div>
      {(p.validation || p.status || p.loading || !p.capabilities) && (
        <p
          className={`run-description ${p.validation ? 'invalid' : ''}`}
          role={p.validation ? 'alert' : 'status'}
        >
          {p.validation ||
            p.status ||
            (p.loading ? '正在读取模型与权限选项…' : '暂未获取选项，请在设置中刷新。')}
        </p>
      )}
    </>
  );
}
