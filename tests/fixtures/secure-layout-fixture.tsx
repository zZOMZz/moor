// Synthetic encrypted conversation for Chromium layout verification; no transport or account.
import { createRoot } from 'react-dom/client';
import { SecureApp, type SecureUiController } from '../../apps/web/src/app/secure-app';
import type { SecureWorkspaceState } from '../../apps/web/src/platform/secure-controller';
import { PERMISSION_REVIEW_FEATURE } from '@moor/protocol/permission-review';
import { syntheticCapabilities } from './agent-capabilities';
import { applyAppearance } from '../../apps/web/src/components/appearance';
const pin = {
  serverOrigin: 'https://relay.synthetic.invalid',
  accountId: 'synthetic-owner',
  rootKeyId: 'A'.repeat(43),
};
const account = {
  origin: pin.serverOrigin,
  owner: pin.accountId,
  needsSetup: false,
  google: { enabled: false },
};
function seed(): SecureWorkspaceState {
  return {
    status: { device: { phase: 'empty', revision: null }, connecting: false, connection: null },
    hostId: null,
    catalog: null,
    replicaId: null,
    sessions: [],
    session: null,
    operations: [],
    draft: '',
    attachmentDraft: [],
    mcpDraft: null,
    previewAnnotations: [],
    extensionBlock: null,
    permissionReviews: [],
    notice: null,
    busy: false,
  };
}
function connected(): SecureWorkspaceState {
  const state = seed();
  state.status = {
    device: {
      phase: 'active',
      revision: 2,
      pin,
      deviceId: 'client',
      roles: ['client'],
      trustEpoch: 1,
      pending: null,
      trust: null,
      devices: [],
    },
    connecting: false,
    connection: {
      connectionId: 'b819e99c-be2c-4a9c-81dd-b9f465cbcf69',
      phase: 'connected',
      verified: false,
      hosts: [
        {
          deviceId: 'host',
          keyId: 'b'.repeat(43),
          rootKeyId: pin.rootKeyId,
          trustEpoch: 1,
          trustDigest: 'c'.repeat(43),
          hostChallenge: 'd'.repeat(43),
        },
      ],
    },
  };
  state.hostId = 'host';
  state.replicaId = 'replica';
  state.catalog = {
    catalogVersion: 2,
    machineId: 'machine',
    workspaces: [
      {
        id: 'runtime',
        name: '合成运行目录',
        features: [PERMISSION_REVIEW_FEATURE],
        userId: 'user',
        machineId: 'machine',
        projects: [{ id: 'local', name: '合成项目', rootPath: '/synthetic/project' }],
        agents: [{ id: 'agent', name: '合成 Agent', cliType: 'synthetic', agentType: 'synthetic' }],
      },
    ],
    products: {
      version: 1,
      authority: { ...pin, hostDeviceId: 'host' },
      revision: 3,
      workspaces: [{ id: 'workspace', name: '工作区' }],
      projects: [
        { id: 'project', workspaceId: 'workspace', name: '合成项目', source: { kind: 'local' } },
      ],
      replicas: [
        {
          id: 'replica',
          catalogWorkspaceId: 'workspace',
          projectId: 'project',
          revision: 3,
          runtimeWorkspaceId: 'runtime',
          localProjectId: 'local',
          machineId: 'machine',
          userId: 'user',
          available: true,
        },
      ],
    },
  } as SecureWorkspaceState['catalog'];
  state.session = {
    meta: {
      id: 'session',
      userId: 'user',
      machineId: 'machine',
      project: { kind: 'local', localProjectId: 'local' },
      agentConfigId: 'agent',
      cliType: 'synthetic',
      agentType: 'synthetic',
      title: '合成会话',
      metadataRevision: 0,
    },
    metaBundle: { version: 1, entries: {} },
    update: '',
    synced: true,
    online: true,
    persisted: true,
    history: [],
  };
  state.sessions = [state.session.meta];
  return state;
}

const state = connected();
state.session!.agent = {
  ...state.catalog!.workspaces[0]!.agents[0]!,
  runConfig: syntheticCapabilities,
};
state.session!.history = [
  {
    id: 'question',
    role: 'user',
    finished: true,
    timestamp: '2026-01-01T00:00:00Z',
    items: [{ type: 'text', text: '请检查当前项目。' }],
  },
  {
    id: 'answer',
    role: 'assistant',
    finished: true,
    timestamp: '2026-01-01T00:00:01Z',
    items: [
      { type: 'text', text: '项目内容已读取。可以在右上角查看文件变更，或继续输入下一条指令。' },
    ],
  },
] as NonNullable<SecureWorkspaceState['session']>['history'];
const controller = {
  state,
  get contentContext() {
    const device = state.status?.device;
    const session = state.session;
    const replica = state.catalog?.products.replicas.find((entry) => entry.id === state.replicaId);
    if (!device || !('deviceId' in device) || !session || !replica)
      return { target: null, online: false, generation: 0 };
    return {
      target: {
        origin: device.pin.serverOrigin,
        owner: device.pin.accountId,
        rootKeyId: device.pin.rootKeyId,
        clientDeviceId: device.deviceId,
        hostDeviceId: state.hostId!,
        workspaceId: replica.runtimeWorkspaceId,
        localProjectId: replica.localProjectId,
        machineId: replica.machineId,
        userId: replica.userId,
        sessionId: session.meta.id,
        product: {
          catalogWorkspaceId: replica.catalogWorkspaceId,
          projectId: replica.projectId,
          replicaId: replica.id,
          revision: replica.revision,
        },
      },
      online: !!state.status?.connection,
      generation: 0,
    };
  },

  subscribe() {
    return () => {};
  },
  refreshStatus: async () => {},
  refreshAgentOptions: async () => {},
  saveRunSelection: async () => {},
  invalidate() {},
} as unknown as SecureUiController;
applyAppearance(localStorage.getItem('moor-appearance') ?? 'system');
createRoot(document.getElementById('app')!).render(
  <div className="workspace-secure-content" style={{ height: '100vh' }}>
    <SecureApp
      layout="session"
      controller={controller}
      accountApi={async () => ({ ok: true, value: account })}
    />
  </div>,
);
