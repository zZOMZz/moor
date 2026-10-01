import { api } from '../platform/api';
import { createDesktopUiPorts, type DesktopUiBridge } from '../platform/desktop/ui-ports';
import { createRoot } from 'react-dom/client';
import { WorkspaceApp } from './workspace-app';
import { WorkspaceController } from '../features/workspace/workspace-controller';
import { WorkspaceStore } from '../features/workspace/workspace-store';
import { IndexedStorage } from '../platform/indexed-storage';
import type { AccountApi } from '../platform/account';
import type { WorkspaceRequest } from '@moor/protocol/workspace-client-protocol';

/** @nativeEntry Invoked by the desktop startup module through its build-owned entry alias. */
export async function start() {
  const bridges = window as unknown as {
    moorWorkspace?: {
      version: number;
      request(value: WorkspaceRequest): Promise<unknown>;
      account: AccountApi;
      context(): Promise<unknown>;
      addProject(): Promise<unknown>;
      onChange(listener: () => void): () => void;
      onSync(listener: (notice: unknown) => void): () => void;
    };
    moorDesktop?: DesktopUiBridge & { openSettings?: () => Promise<unknown> };
  };
  if (!bridges.moorDesktop || bridges.moorWorkspace?.version !== 1)
    throw Error('桌面工作区接口不可用。');
  const ports = createDesktopUiPorts({ window, location, request: api }, bridges.moorDesktop!);
  const container = document.getElementById('app');
  if (!container) throw Error('桌面页面容器不可用。');
  const store = new WorkspaceStore(
    new IndexedStorage({ databaseName: 'moor-desktop-workspace-v1' }),
  );
  const controller = new WorkspaceController({
    store,
    request: (value) => bridges.moorWorkspace!.request(value),
  });
  const root = createRoot(container);
  root.render(
    <WorkspaceApp
      ports={ports}
      localAvailable={true}
      controller={controller}
      accountApi={(value) => bridges.moorWorkspace!.account(value)}
      openSettings={bridges.moorDesktop?.openSettings}
      addLocalProject={bridges.moorWorkspace.addProject}
      readRuntimeContext={bridges.moorWorkspace.context}
      subscribeRuntimeChanges={bridges.moorWorkspace.onChange}
      subscribeSessionChanges={bridges.moorWorkspace.onSync}
    />,
  );
  window.addEventListener(
    'pagehide',
    () => {
      root.unmount();
      void controller.flushDraft().finally(() => controller.close());
    },
    { once: true },
  );
  window.dispatchEvent(new Event('moor:ready'));
}
