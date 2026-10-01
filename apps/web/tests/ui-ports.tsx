import { type ReactNode } from 'react';
import { UiPortsProvider } from '../src/platform/ui-ports';
import { createBrowserUiPorts } from '../src/platform/browser/ui-ports';
import { api } from '../src/platform/api';

export function withBrowserUiPorts(node: ReactNode) {
  return (
    <UiPortsProvider
      ports={createBrowserUiPorts({
        window,
        location: globalThis.location ?? window.location,
        request: api,
      })}
    >
      {node}
    </UiPortsProvider>
  );
}
