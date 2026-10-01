import { useAppearancePort, type Appearance } from '../platform/ui-ports';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Moon, Sun, Monitor, X } from 'lucide-react';

export type { Appearance } from '../platform/ui-ports';
const choices = [
  { value: 'dark', label: 'Dark mode', description: '深色', Icon: Moon },
  { value: 'light', label: 'Light mode', description: '浅色', Icon: Sun },
  { value: 'system', label: 'Auto', description: '跟随系统', Icon: Monitor },
] as const;
const valid = (value: unknown): value is Appearance =>
  value === 'dark' || value === 'light' || value === 'system';
export function applyAppearance(value: unknown) {
  if (valid(value)) document.documentElement.dataset.theme = value;
}
export function useAppearance() {
  const port = useAppearancePort();
  const appearance = useSyncExternalStore(port.subscribe, port.read, () => 'system' as Appearance);
  useEffect(() => applyAppearance(appearance), [appearance]);
  return { appearance, change: (value: Appearance) => port.change(value) };
}
export function AppearanceSettings({
  open,
  onOpenChange,
  openDesktopSettings,
  agentControls,
}: {
  open: boolean;
  onOpenChange(value: boolean): void;
  openDesktopSettings?: () => void;
  agentControls?: {
    name: string;
    disabled?: boolean;
    observedAt?: number;
    scopeLabel?: string;
    error?: string;
    refresh(): Promise<unknown>;
  };
}) {
  const { appearance, change } = useAppearance();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [refreshed, setRefreshed] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="session-dialog-backdrop" />
        <Dialog.Popup className="session-dialog appearance-settings">
          <div className="appearance-heading">
            <Dialog.Title>设置</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="关闭设置">
              <X size={18} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            选择 Moor 的外观，立即应用到当前客户端。
          </Dialog.Description>
          <fieldset disabled={busy}>
            <legend>外观</legend>
            <div className="appearance-options">
              {choices.map(({ value, label, description, Icon }) => (
                <label key={value} className="appearance-option">
                  <Icon size={20} aria-hidden="true" />
                  <input
                    type="radio"
                    name="appearance"
                    value={value}
                    checked={appearance === value}
                    onChange={() => {
                      setBusy(true);
                      setError('');
                      void change(value)
                        .catch((cause: unknown) =>
                          setError(cause instanceof Error ? cause.message : '外观设置未能保存'),
                        )
                        .finally(() => setBusy(false));
                    }}
                  />
                  <span>
                    {label}
                    <small>{description}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <p className="appearance-description">
            {appearance === 'system'
              ? '自动跟随系统的深色或浅色外观。'
              : appearance === 'dark'
                ? '始终使用深色背景和浅色文字。'
                : '始终使用浅色背景和深色文字。'}
          </p>
          {agentControls && (
            <fieldset disabled={busy || agentControls.disabled} className="agent-controls-settings">
              <legend>Agent</legend>
              <p>{agentControls.name}</p>
              <p className="appearance-description">
                模型与推理选项在工作区就绪时读取并缓存。配置更新后，可在这里刷新模型与账号额度。
              </p>
              {agentControls.observedAt !== undefined && (
                <p className="agent-capability-status">
                  能力目录更新于{' '}
                  <time dateTime={new Date(agentControls.observedAt).toISOString()}>
                    {new Date(agentControls.observedAt).toLocaleString()}
                  </time>
                  {agentControls.scopeLabel ? ` · ${agentControls.scopeLabel}` : ''}
                </p>
              )}
              {agentControls.error && (
                <p className="agent-capability-error" role="alert">
                  {agentControls.error}
                </p>
              )}
              <button
                type="button"
                disabled={busy || agentControls.disabled}
                onClick={() => {
                  setBusy(true);
                  setError('');
                  setRefreshed(false);
                  void agentControls
                    .refresh()
                    .then(() => setRefreshed(true))
                    .catch((cause: unknown) =>
                      setError(cause instanceof Error ? cause.message : '刷新失败'),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                {busy ? '正在刷新…' : '刷新模型与额度'}
              </button>
              {refreshed && <p role="status">已刷新当前 Agent 的模型目录与额度状态。</p>}
            </fieldset>
          )}
          {error && <p role="alert">{error}</p>}
          {openDesktopSettings && (
            <button className="appearance-device-settings" onClick={openDesktopSettings}>
              设备、Agent 与连接设置
            </button>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
