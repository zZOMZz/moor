import type { UiPorts, Appearance } from '../ui-ports';
import type { api } from '../api';
import { assertCatalogDataSettled } from '../catalog-data-guard';
import { readRetiredSecureRecords, readRetiredWebRecords } from './retired-records';

export type BrowserUiEnvironment = {
  window: Window;
  location: Pick<Location, 'assign' | 'replace' | 'reload'>;
  request: typeof api;
};
const validAppearance = (value: unknown): value is Appearance =>
  value === 'dark' || value === 'light' || value === 'system';
export function createBrowserUiPorts({
  window: win,
  location,
  request,
}: BrowserUiEnvironment): UiPorts {
  const preferences = {
    read(key: string) {
      try {
        return win.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    write(key: string, value: string) {
      try {
        win.localStorage.setItem(key, value);
      } catch {}
    },
  };
  const apply = (value: Appearance) => {
    win.document.documentElement.dataset.theme = value;
    preferences.write('moor-appearance', value);
    win.dispatchEvent(new Event('moor:appearance'));
  };
  return {
    preferences,
    catalog: { assertSettled: assertCatalogDataSettled },
    retired: {
      read: (format) =>
        format === 'moor-retired-secure-v1' ? readRetiredSecureRecords() : readRetiredWebRecords(),
      async export(value, current) {
        if (!current()) return { status: 'cancelled' };
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
        );
        try {
          const anchor = win.document.createElement('a');
          anchor.href = url;
          anchor.download = value.format + '.json';
          anchor.click();
          return { status: 'handed-off' };
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), 0);
        }
      },
    },
    navigation: {
      reload: () => location.reload(),
      confirm: (message) => win.confirm(message),
      catalogChanged: () => win.dispatchEvent(new Event('moor:catalog-changed')),
      copy: (value) => win.navigator.clipboard.writeText(value),
    },
    appearance: {
      read() {
        const value = win.document.documentElement.dataset.theme;
        return validAppearance(value) ? value : 'system';
      },
      async change(value) {
        apply(value);
        return value;
      },
      subscribe(listener) {
        const changed = () => listener();
        const storage = (event: StorageEvent) => {
          if (event.key !== 'moor-appearance') return;
          if (validAppearance(event.newValue)) apply(event.newValue);
          else apply('system');
        };
        win.addEventListener('moor:appearance', changed);
        win.addEventListener('storage', storage);
        return () => {
          win.removeEventListener('moor:appearance', changed);
          win.removeEventListener('storage', storage);
        };
      },
    },
    attachments: {
      async save(input, current) {
        if (!current()) return { status: 'cancelled' };
        const url = URL.createObjectURL(
          new Blob([input.bytes], { type: input.reference.content.mediaType }),
        );
        try {
          const link = win.document.createElement('a');
          link.href = url;
          link.download = input.reference.name;
          link.click();
          return { status: 'handed-off' };
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), 0);
        }
      },
      async cancel() {},
    },
    google: {
      async begin(input, current) {
        const result = await request('/api/auth/google/start', { ...input, desktop: false });
        if (!current()) return { kind: 'redirecting' };
        if (!/^\/auth\/google\/start\?flow=[A-Za-z0-9_-]{43}$/.test(result.launchPath))
          throw Error('登录地址无效，请重新开始');
        location.assign(result.launchPath);
        return { kind: 'redirecting' };
      },
      async complete() {
        throw Error('当前登录流程不使用桌面确认。');
      },
      async cancel() {},
      review: () => request('/api/auth/google/review'),
      async confirm(flowId, desktop, current) {
        await request('/api/auth/google/confirm', { flowId });
        if (!desktop && current()) location.replace('/');
      },
      async unlink(password) {
        await request('/api/auth/google/unlink', { password });
      },
    },
  };
}
