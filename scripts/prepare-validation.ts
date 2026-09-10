import { Effect } from 'effect';
import { resolve } from 'node:path';
import { Flock } from '../src/model';
import { LocalLink } from '../src/bridge/local-link';
import { LocalLoroTransportAdapter } from '@lody/shared/local-loro-transport';
import {
  makeLocalProbeClientAuto,
  makeLocalControlClientAuto,
  getLocalLoroDataPlaneSocketPath,
} from '@lody/shared/node/local-ipc';
const state = await Effect.runPromise(makeLocalProbeClientAuto().state());
if (!state.machineId || !state.connectedWorkspaces?.[0]) throw new Error('本地工作区尚未就绪');
const workspace = state.connectedWorkspaces[0],
  machineId = state.machineId;
const project = await Effect.runPromise(
  makeLocalControlClientAuto().projectControl({
    type: 'local-project/add',
    machineId: machineId as never,
    workspace: workspace.id,
    rootPath: resolve(process.argv[2]),
  }),
);
console.log('Synthetic project registration:', project);
const link = new LocalLink(getLocalLoroDataPlaneSocketPath('local')),
  adapter = new LocalLoroTransportAdapter({ workspaceId: workspace.id, connection: link }),
  flock = new Flock();
const sub = adapter.joinFlockDocRoom(`${workspace.id}:mf:${machineId}`, flock);
await sub.firstSyncedWithRemote;
console.log('Local catalogue row families:', [...new Set(flock.scan({}).map((r) => r.key[0]))]);
flock.set(['agentConfig', 'synthetic-validation-agent'], {
  id: 'synthetic-validation-agent',
  name: '合成验证 Agent',
  machineId,
  description: 'No model calls or file modifications',
  cliType: 'custom',
  agentType: 'synthetic-validation',
  env: {},
  customAcp: { command: process.execPath, args: [resolve('scripts/synthetic-agent.mjs')] },
});
flock.commit();
await sub.waitUntilSynced();
await sub.rejoin();
await sub.waitUntilSynced();
console.log('Synthetic Agent registered');
sub.unsubscribe();
await adapter.close();
link.close();
