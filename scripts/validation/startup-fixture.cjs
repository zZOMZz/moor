// Synthetic cached browser state; no host, account or project is contacted.
exports.startupFixture = async () => {
  const { LoroDoc, LoroMap, LoroList } = require('loro-crdt');
  const { Flock } = await import('@loro-dev/flock-wasm/base64');
  const owner = 'synthetic-owner';
  const device = {
    id: 'synthetic-device',
    name: 'Synthetic Mac',
    online: true,
    workspaces: [
      {
        id: 'synthetic-runtime',
        name: 'Synthetic runtime',
        machineId: 'synthetic-machine',
        userId: owner,
        projects: [
          { id: 'local-project', name: 'Synthetic project', rootPath: '/synthetic/project' },
        ],
        agents: [],
      },
    ],
  };
  const workspace = {
    id: 'synthetic-workspace',
    name: 'Cached synthetic workspace',
    hosts: [
      {
        id: 'synthetic-host',
        deviceId: device.id,
        machineId: 'synthetic-machine',
        runtimeWorkspaceId: device.workspaces[0].id,
        name: device.name,
        online: true,
        agents: [],
      },
    ],
    projects: [{ id: 'synthetic-project', name: 'Synthetic project', source: { kind: 'local' } }],
    replicas: [
      {
        id: 'synthetic-replica',
        hostId: 'synthetic-host',
        projectId: 'synthetic-project',
        localProjectId: 'local-project',
        rootPath: '/synthetic/project',
        available: true,
      },
    ],
  };
  const sessionId = 'synthetic-session';
  const doc = new LoroDoc();
  doc.getMap('session').set('id', sessionId);
  const history = doc.getList('history');
  for (const role of ['user', 'assistant']) {
    const turn = history.pushContainer(new LoroMap());
    turn.set('id', 'synthetic-' + role);
    turn.set('role', role);
    turn.set('timestamp', '2026-01-01T00:00:00.000Z');
    turn.set('finished', role === 'user');
    turn.setContainer('items', new LoroList()).push(
      role === 'user'
        ? { type: 'text', text: 'Synthetic cached history visible before identity' }
        : {
            type: 'tool_call',
            title: 'Synthetic approval',
            status: 'pending',
            content: [],
            permissionRequest: {
              requestId: 'synthetic-permission',
              options: [{ optionId: 'allow', name: 'Allow once' }],
            },
          },
    );
  }
  doc.commit();
  const snapshot = Buffer.from(doc.export({ mode: 'snapshot' })).toString('base64');
  const flock = new Flock();
  const metaBundle = flock.exportJson();
  const meta = {
    id: sessionId,
    title: 'Cached synthetic session',
    project: { kind: 'local', localProjectId: 'local-project' },
    latestUserMsgId: 'synthetic-user',
  };
  const selection = {
    deviceId: device.id,
    workspaceId: device.workspaces[0].id,
    catalogWorkspaceId: workspace.id,
    replicaId: workspace.replicas[0].id,
    sessionId,
    projectId: workspace.projects[0].id,
    search: '',
  };
  const key = [owner, device.id, device.workspaces[0].id, sessionId].join('/');
  const pending = {
    operationId: 'synthetic-original-operation',
    workspaceId: device.workspaces[0].id,
    sessionId,
    kind: 'turn',
    expectedTurnId: 'synthetic-user',
    update: snapshot,
  };
  return {
    owner,
    device,
    workspace,
    meta,
    snapshot,
    metaBundle,
    pending,
    records: [
      ['last-owner', owner],
      [owner + '/devices', [device]],
      [owner + '/workspaces', [workspace]],
      [owner + '/view', selection],
      [[owner, device.id, device.workspaces[0].id, 'list'].join('/'), [meta]],
      [key + '/session', { snapshot, meta, metaBundle }],
      [key + '/draft', 'Synthetic retained draft'],
      [key + '/pending', pending],
    ],
  };
};
