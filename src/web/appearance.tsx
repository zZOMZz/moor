import { useEffect, useState, useSyncExternalStore } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Moon, Sun, Monitor, X } from 'lucide-react';

export type Appearance = 'dark' | 'light' | 'system';
const choices = [
  { value: 'dark', label: 'Dark mode', description: '深色', Icon: Moon },
  { value: 'light', label: 'Light mode', description: '浅色', Icon: Sun },
  { value: 'system', label: 'Auto', description: '跟随系统', Icon: Monitor },
] as const;
const valid = (value: unknown): value is Appearance =>
  value === 'dark' || value === 'light' || value === 'system';
type DesktopAppearance = {
  appearance?: (value?: Appearance) => Promise<unknown>;
  onAppearance?: (listener: (value: unknown) => void) => () => void;
};
const desktop = () => (window as unknown as { moorDesktop?: DesktopAppearance }).moorDesktop;
export function applyAppearance(value: unknown) {
  if (!valid(value)) return;
  document.documentElement.dataset.theme = value;
  try {
    localStorage.setItem('moor-appearance', value);
  } catch {
    // The current window can still change appearance when storage is unavailable.
  }
  window.dispatchEvent(new Event('moor:appearance'));
}
export function useAppearance() {
  const appearance = useSyncExternalStore(
    (listener) => {
      window.addEventListener('moor:appearance', listener);
      const storage = (event: StorageEvent) => {
        if (event.key === 'moor-appearance') applyAppearance(event.newValue ?? 'system');
      };
      window.addEventListener('storage', storage);
      return () => {
        window.removeEventListener('moor:appearance', listener);
        window.removeEventListener('storage', storage);
      };
    },
    () => {
      const value = document.documentElement.dataset.theme;
      return valid(value) ? value : 'system';
    },
    () => 'system' as Appearance,
  );
  useEffect(() => {
    const bridge = desktop();
    let active = true;
    let fresh = true;
    const unsubscribe = bridge?.onAppearance?.((value) => {
      fresh = false;
      applyAppearance(value);
    });
    if (bridge?.appearance)
      void bridge
        .appearance()
        .then((value) => active && fresh && applyAppearance(value))
        .catch(() => {});
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);
  return {
    appearance,
    async change(value: Appearance) {
      const bridge = desktop();
      if (bridge?.appearance) {
        const saved = await bridge.appearance(value);
        if (!valid(saved)) throw Error('外观设置未能保存，请重试。');
        applyAppearance(saved);
      } else applyAppearance(value);
    },
  };
}
export function AppearanceSettings({
  open,
  onOpenChange,
  openDesktopSettings,
}: {
  open: boolean;
  onOpenChange(value: boolean): void;
  openDesktopSettings?: () => void;
}) {
  const { appearance, change } = useAppearance();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
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
