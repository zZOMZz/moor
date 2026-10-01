import { createBrowserUiPorts, type BrowserUiEnvironment } from '../browser/ui-ports';
import type { UiPorts, Appearance } from '../ui-ports';
import type { GoogleBegin } from '@moor/client/features/auth/google-auth';

export type DesktopUiBridge = {
  version: number;
  platform?: string;
  appearance(value?: Appearance): Promise<unknown>;
  onAppearance(listener: (value: unknown) => void): () => void;
  googleAuth: {
    begin(value: GoogleBegin): Promise<{ flowId: string; code: string }>;
    complete(): Promise<{ completed: boolean }>;
    cancel(): Promise<void>;
  };
  saveAttachment(value: unknown): Promise<{ status: string }>;
  cancelAttachmentSave(): Promise<void>;
};
const valid = (value: unknown): value is Appearance =>
  value === 'dark' || value === 'light' || value === 'system';
export function createDesktopUiPorts(
  environment: BrowserUiEnvironment,
  bridge: DesktopUiBridge,
): UiPorts {
  if (bridge.version !== 1) throw Error('桌面能力接口不可用。');
  const common = createBrowserUiPorts(environment);
  let appearance: Appearance = 'system';
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;
  let epoch = 0;
  const accept = (value: unknown) => {
    if (!valid(value)) return;
    appearance = value;
    environment.window.document.documentElement.dataset.theme = value;
    common.preferences.write('moor-appearance', value);
    for (const listener of listeners) listener();
  };
  return {
    ...common,
    appearance: {
      read: () => appearance,
      async change(value) {
        const result = await bridge.appearance(value);
        if (!valid(result)) throw Error('外观设置未能保存，请重试。');
        accept(result);
        return result;
      },
      subscribe(listener) {
        listeners.add(listener);
        if (!stop) {
          let current = ++epoch;
          stop = bridge.onAppearance((value) => {
            current = ++epoch;
            accept(value);
          });
          const requested = current;
          void bridge
            .appearance()
            .then((value) => {
              if (listeners.size && requested === epoch) accept(value);
            })
            .catch(() => {});
        }
        return () => {
          listeners.delete(listener);
          if (!listeners.size) {
            epoch++;
            stop?.();
            stop = undefined;
          }
        };
      },
    },
    attachments: {
      async save(input, current) {
        if (!current()) return { status: 'cancelled' };
        const result = await bridge.saveAttachment({
          scope: input.scope,
          reference: input.reference,
          data: input.data,
        });
        if (!['saved', 'cancelled'].includes(result.status)) throw Error('附件保存结果尚未确认。');
        return { status: result.status as 'saved' | 'cancelled' };
      },
      cancel: () => bridge.cancelAttachmentSave(),
    },
    google: {
      ...common.google,
      async begin(input, current) {
        const result = await bridge.googleAuth.begin(input);
        if (!current()) {
          await bridge.googleAuth.cancel();
          return { kind: 'redirecting' };
        }
        return { kind: 'confirmation', code: result.code };
      },
      async complete(current) {
        const result = await bridge.googleAuth.complete();
        if (!current()) return { completed: false };
        return result;
      },
      cancel: () => bridge.googleAuth.cancel(),
    },
  };
}
