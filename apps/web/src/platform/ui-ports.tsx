import { createContext, useContext, type ReactNode } from 'react';
import type { GoogleAuthPort } from '@moor/client/features/auth/google-auth';
import type { AttachmentExportPort } from '@moor/client/features/attachments/export';
import type { CatalogSafetyPort } from '@moor/client/features/workspace/catalog-safety';

export type Appearance = 'dark' | 'light' | 'system';
export interface AppearancePort {
  read(): Appearance;
  change(value: Appearance): Promise<Appearance>;
  subscribe(listener: () => void): () => void;
}
export interface PreferencePort {
  read(key: string): string | null;
  write(key: string, value: string): void;
}
export interface NavigationPort {
  reload(): void;
  confirm(message: string): boolean;
  catalogChanged(): void;
  copy(value: string): Promise<void>;
}
export type UiPorts = {
  google: GoogleAuthPort;
  attachments: AttachmentExportPort;
  appearance: AppearancePort;
  preferences: PreferencePort;
  navigation: NavigationPort;
  catalog: CatalogSafetyPort;
};
const Google = createContext<GoogleAuthPort | null>(null);
const Attachments = createContext<AttachmentExportPort | null>(null);
const AppearanceContext = createContext<AppearancePort | null>(null);
const Preferences = createContext<PreferencePort | null>(null);
const Navigation = createContext<NavigationPort | null>(null);
const Catalog = createContext<CatalogSafetyPort | null>(null);
function required<T>(port: T | null, name: string): T {
  if (!port) throw Error(`${name}能力未由入口提供。`);
  return port;
}
export const useGoogleAuth = () => required(useContext(Google), '登录');
export const useAttachmentExport = () => required(useContext(Attachments), '附件保存');
export const useAppearancePort = () => required(useContext(AppearanceContext), '外观');
export const usePreferences = () => required(useContext(Preferences), '本机偏好');
export const useNavigation = () => required(useContext(Navigation), '页面交互');
export const useCatalogSafety = () => required(useContext(Catalog), '目录数据检查');

/** Only the assembly receives the bundle; consumers obtain their individual interface. */
export function UiPortsProvider({ ports, children }: { ports: UiPorts; children: ReactNode }) {
  return (
    <Google.Provider value={ports.google}>
      <Attachments.Provider value={ports.attachments}>
        <AppearanceContext.Provider value={ports.appearance}>
          <Preferences.Provider value={ports.preferences}>
            <Navigation.Provider value={ports.navigation}>
              <Catalog.Provider value={ports.catalog}>{children}</Catalog.Provider>
            </Navigation.Provider>
          </Preferences.Provider>
        </AppearanceContext.Provider>
      </Attachments.Provider>
    </Google.Provider>
  );
}
