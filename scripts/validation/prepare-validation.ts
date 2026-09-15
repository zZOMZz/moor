// Explicitly prepare isolated synthetic data while the host is stopped.
import { resolve } from 'node:path';
import { acquireRuntimeLock } from '@moor/e2ee/node/exclusive-lock';
import { RuntimeStore } from '@moor/host/persistence/store';
const [database, project] = process.argv.slice(2);
if (!database || !project)
  throw new Error(
    'Usage: tsx scripts/validation/prepare-validation.ts /tmp/isolated-host.sqlite /tmp/synthetic-project',
  );
const release = acquireRuntimeLock(resolve(database) + '.ownership.sqlite');
const store = new RuntimeStore(resolve(database));
try {
  store.registerProject(resolve(project));
  store.machine.set(['agentConfig', 'synthetic-validation-agent'], {
    id: 'synthetic-validation-agent',
    name: '合成验证 Agent',
    machineId: store.workspace.machineId,
    cliType: 'custom',
    agentType: 'synthetic-validation',
    customAcp: {
      command: process.execPath,
      args: [resolve('scripts/validation/synthetic-agent.mjs')],
    },
  });
  store.saveMachine();
  console.log('Synthetic Moor host prepared');
} finally {
  store.close();
  release();
}
