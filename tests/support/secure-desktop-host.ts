import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { AppError } from '../../src/protocol';
import { gitActionReceiptSchema } from '../../src/git-protocol';
import { forkReceiptSchema } from '../../src/fork-protocol';
import type { AgentForkInput } from '../../src/runtime/agent-fork';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { Store } from '../../src/relay/accounts';
import { createApp } from '../../src/relay/http';
import { RuntimeStore } from '../../src/runtime/store';
import type { AgentSession, AgentOpenOptions } from '../../src/runtime/agent';
import { HostWorkspace } from '../../src/bridge/host-workspace';
import { HostCommandDispatcher, hostCommandSchema } from '../../src/bridge/host-command';
import { HostProductCatalog } from '../../src/bridge/host-product-catalog';
import { EncryptedHostTransport, openSecureHostEndpoint } from '../../src/bridge/encrypted-host';
import { DeviceManager } from '../../src/security/device-manager';
import { PrivateEndpointFile } from '../../src/security/private-endpoint-file';
import { generateRecoveryKey } from '../../src/security/e2ee-recovery';
import { mutationReceiptSchema } from '../../src/session-responses';
import { attachmentReceiptSchema } from '../../src/attachment-protocol';
import {
  ENCRYPTED_BRIDGE_PATHS,
  encryptedCatalogSchema,
  encryptedBridgeClientRecordSchema,
  encryptedBridgeHostRecordSchema,
} from '../../src/security/encrypted-bridge-protocol';
import type { EncryptedRecord } from '../../src/security/e2ee-channel';
import { syntheticCapabilities } from './agent-capabilities';
import { createSecureIntegrationServices } from './secure-integration-services';
import { githubWriteReceiptSchema } from '../../src/github-write-protocol';

function sequenceSignal() {
  const reached = new Set<number>();
  const waiting = new Map<number, { resolve(): void; reject(error: Error): void }[]>();
  let failed: Error | undefined;
  return {
    wait(sequence: number) {
      assert(Number.isSafeInteger(sequence) && sequence > 0);
      if (failed) return Promise.reject(failed);
      if (reached.has(sequence)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        waiting.set(sequence, [...(waiting.get(sequence) ?? []), { resolve, reject }]);
      });
    },
    mark(sequence: number) {
      if (failed) return;
      reached.add(sequence);
      for (const waiter of waiting.get(sequence) ?? []) waiter.resolve();
      waiting.delete(sequence);
    },
    fail(error: Error) {
      failed ??= error;
      for (const waiters of waiting.values()) for (const waiter of waiters) waiter.reject(failed);
      waiting.clear();
    },
  };
}

/** Native GUI fixture: production Relay, Host, encrypted transport and private device files. */
export async function createSecureDesktopHost(
  root: string,
  options: {
    richContent?: boolean;
    extensions?: boolean;
    workspaces?: boolean;
    integrations?: { electronPath: string; workerPath: string };
  } = {},
) {
  const privateRoot = join(root, 'private'),
    project = join(root, 'SYNTHETIC_PRIVATE_PROJECT'),
    relayFile = join(root, 'relay.sqlite');
  mkdirSync(privateRoot, { mode: 0o700 });
  mkdirSync(project, { mode: 0o700 });
  if (options.richContent)
    writeFileSync(join(project, 'SYNTHETIC_PRIVATE_FILE.txt'), 'SYNTHETIC_PRIVATE_BEFORE\n');
  if (options.extensions) {
    const skills = join(project, '.agents/skills/synthetic');
    mkdirSync(skills, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(skills, 'SKILL.md'),
      '---\nname: SYNTHETIC_PRIVATE_SKILL\ndescription: Synthetic review fixture\n---\nSYNTHETIC_PRIVATE_SKILL_BODY\n',
    );
  }
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'user.name=Synthetic',
        '-c',
        'user.email=synthetic@example.invalid',
        '-C',
        project,
        ...args,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
          ),
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      },
    ).trim();
  if (options.workspaces) {
    writeFileSync(join(project, 'SYNTHETIC_PRIVATE_BASELINE.txt'), 'SYNTHETIC_PRIVATE_BASELINE\n');
    git('init', '-b', 'main');
    git('add', '.');
    git('commit', '-m', 'Synthetic baseline');
  }
  const forks: Omit<AgentForkInput, 'assertCurrent' | 'onNativeId'>[] = [],
    opens: { cwd: string; nativeId?: string }[] = [];
  let nextForkFault: 'reject' | 'after-native' | undefined,
    nativeSequence = 0;
  let relay: Store | undefined,
    application: ReturnType<typeof createApp> | undefined,
    store: RuntimeStore | undefined,
    host: HostWorkspace | undefined,
    endpoint: Awaited<ReturnType<typeof openSecureHostEndpoint>> | undefined,
    transport: EncryptedHostTransport | undefined,
    hostManager: DeviceManager | undefined,
    clientManager: DeviceManager | undefined,
    connection: PrivateEndpointFile | undefined,
    integrations: Awaited<ReturnType<typeof createSecureIntegrationServices>> | undefined,
    closed = false,
    fixtureError: Error | undefined;
  const permissionSignal = sequenceSignal(),
    completedSignal = sequenceSignal(),
    outcomes: unknown[] = [],
    inputs: unknown[] = [];
  const mcpOpened = sequenceSignal(),
    mcpContinue = sequenceSignal(),
    mcpDescriptors: unknown[] = [],
    mcpCurrent = new Map<number, () => void>();
  let prompts = 0,
    droppedReplies = 0,
    armed: 'permission' | 'attachment' | 'turn' | 'github-write' | 'git' | 'fork' | undefined;
  type Pending = { socket: WebSocket; record: EncryptedRecord };
  const pending = new Map<string, Pending>();
  let drop: (Pending & { accepted: boolean }) | undefined;
  const wire: {
      path: string;
      direction: 'in' | 'out';
      text: string;
      record?: EncryptedRecord;
      delivered: boolean;
    }[] = [],
    http: string[] = [];
  const fail = (error: unknown) => {
    fixtureError ??= error instanceof Error ? error : Error('Synthetic fixture failed');
    permissionSignal.fail(fixtureError);
    completedSignal.fail(fixtureError);
    mcpOpened.fail(fixtureError);
    mcpContinue.fail(fixtureError);
    return fixtureError;
  };
  const current = () => {
    if (fixtureError) throw fixtureError;
    assert(!closed, 'Synthetic fixture is closed');
  };
  const originalUpgrade = WebSocketServer.prototype.handleUpgrade;
  const captureUpgrade: typeof originalUpgrade = function (
    this: WebSocketServer,
    request,
    socket,
    head,
    callback,
  ) {
    return originalUpgrade.call(this, request, socket, head, (ws: WebSocket, req) => {
      const path = request.url ?? '';
      const capture = (direction: 'in' | 'out', text: string) => {
        const message = JSON.parse(text);
        const record =
          message.type === 'record'
            ? (path === ENCRYPTED_BRIDGE_PATHS.client
                ? encryptedBridgeClientRecordSchema
                : encryptedBridgeHostRecordSchema
              ).parse(message).record
            : undefined;
        const frame = { path, direction, text, record, delivered: true };
        wire.push(frame);
        return frame;
      };
      ws.on('message', (raw: RawData) => {
        try {
          const frame = capture('in', raw.toString());
          if (path === ENCRYPTED_BRIDGE_PATHS.client && frame.record) {
            const record = frame.record;
            assert.equal(record.header.kind, 'request');
            assert.equal(record.header.direction, 'client-to-host');
            assert(!pending.has(record.header.requestId), 'Synthetic request ID is ambiguous');
            assert(
              !drop,
              'Synthetic fault requires no concurrent request during permission dispatch',
            );
            pending.set(record.header.requestId, { socket: ws, record });
          }
        } catch (error) {
          fail(error);
          ws.terminate();
        }
      });
      ws.on('close', () => {
        for (const [requestId, entry] of pending)
          if (entry.socket === ws) pending.delete(requestId);
      });
      const send = ws.send.bind(ws);
      ws.send = ((data: unknown, ...args: unknown[]) => {
        try {
          const frame = capture('out', String(data));
          if (path === ENCRYPTED_BRIDGE_PATHS.client && frame.record) {
            const record = frame.record;
            assert.equal(record.header.kind, 'response');
            assert.equal(record.header.direction, 'host-to-client');
            const entry = pending.get(record.header.requestId);
            assert(entry?.socket === ws, 'Synthetic response has no exact pending client request');
            pending.delete(record.header.requestId);
            if (drop?.record.header.requestId === record.header.requestId) {
              assert(
                drop.socket === ws && drop.accepted,
                'Permission must commit before losing its reply',
              );
              frame.delivered = false;
              drop = undefined;
              droppedReplies++;
              ws.terminate();
              const callback = args.at(-1);
              if (typeof callback === 'function')
                callback(Error('Synthetic lost encrypted permission reply'));
              return;
            }
          }
          return (send as (...values: unknown[]) => void)(data, ...args);
        } catch (error) {
          fail(error);
          ws.terminate();
          const callback = args.at(-1);
          if (typeof callback === 'function') callback(fixtureError);
        }
      }) as typeof ws.send;
      callback(ws, req);
    });
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    const error = Error('Synthetic fixture closed');
    permissionSignal.fail(error);
    completedSignal.fail(error);
    mcpOpened.fail(error);
    mcpContinue.fail(error);
    transport?.close();
    endpoint?.close();
    connection?.close();
    hostManager?.close();
    clientManager?.close();
    await integrations?.close();
    const done = [...(host?.active.values() ?? [])].map((run) => run.done);
    host?.close();
    await Promise.allSettled(done);
    store?.close();
    await application?.close();
    relay?.close();
    if (WebSocketServer.prototype.handleUpgrade === captureUpgrade)
      WebSocketServer.prototype.handleUpgrade = originalUpgrade;
  };
  try {
    relay = new Store(relayFile);
    const cookie = relay.setupGoogle(
      {
        issuer: 'https://accounts.google.com',
        subject: 'synthetic-desktop-subject',
        email: 'desktop@synthetic.invalid',
        emailVerified: true,
      },
      'synthetic-desktop-owner',
    );
    const owner = relay.owner(cookie);
    application = createApp(relay, {
      origin: 'http://127.0.0.1:0',
      setupToken: 'synthetic-unused-setup',
    });
    WebSocketServer.prototype.handleUpgrade = captureUpgrade;
    application.server.on('request', (request) => http.push(request.method + ' ' + request.url));
    application.server.listen(0, '127.0.0.1');
    await once(application.server, 'listening');
    const address = application.server.address();
    assert(address && typeof address !== 'string');
    const origin = 'http://127.0.0.1:' + address.port;
    application.setOrigin(origin);

    const hostFile = join(privateRoot, 'host.json'),
      clientFile = join(privateRoot, 'client.json'),
      connectionFile = join(privateRoot, 'connection.json'),
      recovery = generateRecoveryKey();
    hostManager = await DeviceManager.open(hostFile);
    clientManager = await DeviceManager.open(clientFile);
    const initialized = await hostManager.initialize(
      {
        accountId: owner,
        serverOrigin: origin,
        deviceId: 'synthetic-desktop-host',
        roles: ['host'],
      },
      recovery,
    );
    assert('pin' in initialized);
    const pairing = await clientManager.beginPairing({
      pin: initialized.pin,
      deviceId: 'synthetic-desktop-client',
      roles: ['client'],
    });
    assert('pending' in pairing && pairing.pending);
    const approval = await hostManager.approvePairing({
      expectedRevision: initialized.revision!,
      request: pairing.pending.request,
      expectedFingerprint: pairing.fingerprint,
      expectedDeviceKeyId: null,
      recoveryKey: recovery,
    });
    await clientManager.acceptPairing({
      expectedRevision: pairing.revision!,
      approval: approval.approval,
      rootPublicKey: approval.trust.rootPublicKey,
      signedManifest: approval.trust.signedManifest,
    });
    hostManager.close();
    hostManager = undefined;
    clientManager.close();
    clientManager = undefined;
    connection = PrivateEndpointFile.open(connectionFile);
    connection.save(null, {
      kind: 'moor-trust-connection',
      origin,
      owner,
      cookie: 'personal=' + cookie,
    });
    connection.close();
    connection = undefined;

    store = new RuntimeStore(join(privateRoot, 'runtime.sqlite'));
    const runtime = store;
    runtime.workspace.name = 'SYNTHETIC_PRIVATE_WORKSPACE';
    const projectId = runtime.registerProject(project);
    runtime.registerAgent(options.workspaces ? 'codex' : 'synthetic', {
      id: 'synthetic-desktop-agent',
      name: 'SYNTHETIC_PRIVATE_AGENT',
      machineId: runtime.workspace.machineId,
      cliType: options.workspaces ? 'builtin' : 'custom',
      agentType: options.workspaces ? 'codex' : 'synthetic',
      ...(!options.workspaces ? { customAcp: { command: '/synthetic/never-run', args: [] } } : {}),
    });
    if (options.integrations)
      integrations = await createSecureIntegrationServices(
        project,
        projectId,
        options.integrations,
      );
    host = new HostWorkspace(
      runtime,
      {
        async fork(_config, input) {
          assert(options.workspaces);
          input.assertCurrent?.();
          const fault = nextForkFault;
          nextForkFault = undefined;
          const { assertCurrent: _current, onNativeId: _native, ...record } = input;
          forks.push(structuredClone(record));
          if (fault === 'reject') throw new AppError(409, 'Synthetic native Fork rejected', true);
          const nativeId = 'synthetic-fork-native-' + forks.length;
          await input.onNativeId?.(nativeId);
          if (fault === 'after-native') throw Error('Synthetic lost native Fork result');
          return { nativeId };
        },
        async open(_config, _cwd, nativeId, callbacks, openOptions?: AgentOpenOptions) {
          openOptions?.assertCurrent?.();
          if (options.workspaces) opens.push({ cwd: _cwd, nativeId });
          let activeSequence: number | undefined;
          if (options.extensions)
            mcpDescriptors.push(structuredClone(openOptions?.mcp?.servers ?? []));
          const session: AgentSession = {
            id:
              nativeId ??
              (options.workspaces
                ? 'synthetic-native-' + ++nativeSequence
                : 'synthetic-desktop-native'),
            ...(options.workspaces
              ? {
                  forkCapabilities: {
                    sameDirectory: true,
                    worktree: true,
                    turnCutoff: true,
                    adapter: 'codex-acp' as const,
                    adapterVersion: '1.11.0' as const,
                  },
                }
              : {}),
            capabilities: syntheticCapabilities,
            inputCapabilities:
              options.richContent || options.integrations
                ? { image: true, audio: true, embeddedContext: true }
                : undefined,
            async prompt(input, binding) {
              try {
                const sequence = ++prompts;
                activeSequence = sequence;
                inputs.push(structuredClone(input));
                const runEntry = [...host!.active].find(([, run]) => run.session === session);
                assert(runEntry?.[1].done, 'Synthetic prompt must belong to one active Host run');
                const [sessionId, run] = runEntry;
                void run
                  .done!.then(() => {
                    if (closed) return;
                    assert(
                      !host!.closed && !host!.active.has(sessionId),
                      'Synthetic Host did not complete',
                    );
                    completedSignal.mark(sequence);
                  })
                  .catch(fail);
                if (options.extensions || options.integrations || options.workspaces) {
                  if (openOptions?.mcp) {
                    mcpCurrent.set(sequence, openOptions.mcp.assertCurrent);
                    mcpOpened.mark(sequence);
                    await mcpContinue.wait(sequence);
                    if (run.stopped) return;
                    openOptions.mcp.assertCurrent();
                  }
                  callbacks.update({
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'SYNTHETIC_PRIVATE_COMPLETED_' + sequence },
                  });
                  if (options.workspaces && binding)
                    callbacks.forkAnchor?.(
                      {
                        version: 1,
                        kind: 'completed-turn',
                        adapter: 'codex-acp',
                        adapterVersion: '1.11.0',
                        sourceNativeId: session.id,
                        messageId: 'synthetic-message-' + binding.expectedTurnId,
                      },
                      binding,
                    );
                  return;
                }
                if (options.richContent) {
                  writeFileSync(
                    join(project, 'SYNTHETIC_PRIVATE_FILE.txt'),
                    'SYNTHETIC_PRIVATE_AFTER_' + sequence + '\n',
                  );
                  callbacks.update({
                    sessionUpdate: 'agent_message_chunk',
                    content: {
                      type: 'resource',
                      resource: {
                        uri: 'file:///synthetic/SYNTHETIC_PRIVATE_GENERATED_' + sequence + '.txt',
                        mimeType: 'text/plain',
                        text: 'SYNTHETIC_PRIVATE_OUTPUT_' + sequence,
                      },
                    },
                  });
                  callbacks.update({
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'SYNTHETIC_PRIVATE_COMPLETED_' + sequence },
                  });
                  return;
                }
                const result = callbacks.permission({
                  toolCall: {
                    toolCallId: 'synthetic-tool-' + sequence,
                    title: 'SYNTHETIC_PRIVATE_APPROVAL_' + sequence,
                    kind: 'edit',
                    rawInput: { path: 'SYNTHETIC_PRIVATE_FILE.txt', instruction: 'synthetic edit' },
                  },
                  options: [
                    { optionId: 'allow', name: '允许此次合成操作', kind: 'allow_once' },
                    { optionId: 'deny', name: '拒绝此次合成操作', kind: 'reject_once' },
                  ],
                });
                assert.equal(
                  run.permissions.size,
                  1,
                  'Synthetic permission must be registered by Host',
                );
                permissionSignal.mark(sequence);
                outcomes.push(await result);
                callbacks.update({
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'SYNTHETIC_PRIVATE_COMPLETED_' + sequence },
                });
              } catch (error) {
                throw fail(error);
              }
            },
            async cancel() {
              if (activeSequence) mcpContinue.mark(activeSequence);
            },
            close() {
              if (activeSequence) mcpContinue.mark(activeSequence);
            },
          };
          return session;
        },
      },
      () => {},
      () => {},
      undefined,
      undefined,
      undefined,
      integrations?.github,
      integrations?.githubWrite,
      integrations?.preview,
    );
    const workspace = host;
    if (options.extensions) {
      for (const name of ['A', 'B'])
        await workspace.mcpSettings.handle({
          action: 'save',
          expectedRevision: workspace.mcpSettings.read().revision,
          name: 'SYNTHETIC_PRIVATE_MCP_' + name,
          description: 'SYNTHETIC_PRIVATE_MCP_DESCRIPTION_' + name,
          enabled: true,
          projectIds: [projectId],
          connection: {
            transport: 'http',
            url: 'https://synthetic.invalid/mcp/' + name,
            headers: { Authorization: 'SYNTHETIC_PRIVATE_MCP_SECRET_' + name },
          },
        });
    }
    endpoint = await openSecureHostEndpoint({
      endpointFile: hostFile,
      connectionFile,
      projectRoots: () => [project],
    });
    const dispatcher = new HostCommandDispatcher({
      ready: () => !workspace.closed,
      workspace: (id) => (id === workspace.workspace.id ? workspace : undefined),
      hasOperation: (id) => runtime.journal.has(id),
    });
    const execute = dispatcher.execute.bind(dispatcher);
    dispatcher.execute = async (raw, context) => {
      const command = hostCommandSchema.parse(raw);
      let selected: typeof drop;
      if (
        (armed === 'permission' &&
          command.method === 'mutate' &&
          command.params.kind === 'permission') ||
        (armed === 'attachment' && command.method === 'attachment-action') ||
        (armed === 'turn' && command.method === 'mutate' && command.params.kind === 'turn') ||
        (armed === 'github-write' && command.method === 'github-write-action') ||
        (armed === 'git' && command.method === 'git-action') ||
        (armed === 'fork' && command.method === 'fork-action')
      ) {
        try {
          current();
          assert.equal(
            pending.size,
            1,
            'Synthetic fault cannot select among concurrent encrypted requests',
          );
          const original = [...pending.values()][0];
          const resource = original.record.header.resource;
          assert(resource.kind === 'session' && resource.sessionId === command.params.sessionId);
          assert.equal(resource.workspaceId, command.workspaceId);
          assert.equal(resource.projectId, command.localProjectId);
          selected = drop = { ...original, accepted: false };
          armed = undefined;
        } catch (error) {
          throw fail(error);
        }
      }
      try {
        const result = await execute(raw, context);
        if (selected) {
          if (
            command.method === 'github-write-action' ||
            command.method === 'git-action' ||
            command.method === 'fork-action'
          ) {
            const receipt = (
              command.method === 'github-write-action'
                ? githubWriteReceiptSchema
                : command.method === 'git-action'
                  ? gitActionReceiptSchema
                  : forkReceiptSchema
            ).parse(result);
            assert.equal(receipt.phase, 'accepted');
            assert.equal(receipt.operationId, command.params.operationId);
            selected.accepted = true;
            return result;
          }
          const receipt =
            command.method === 'attachment-action'
              ? attachmentReceiptSchema.parse(result)
              : mutationReceiptSchema.parse(result);
          assert(
            (command.method === 'mutate' || command.method === 'attachment-action') &&
              receipt.accepted &&
              receipt.operationId === command.params.operationId,
          );
          selected.accepted = true;
        }
        return result;
      } catch (error) {
        if (selected) fail(error);
        throw error;
      }
    };
    const runtimeCatalog = () =>
      encryptedCatalogSchema.parse({
        catalogVersion: 1,
        machineId: workspace.workspace.machineId,
        workspaces: [
          {
            ...workspace.workspace,
            features: workspace.workspace.features?.filter(
              (feature) => !/attention|actor|followup/.test(feature),
            ),
          },
        ],
      });
    const products = new HostProductCatalog({
      db: runtime.journal.db,
      authority: {
        serverOrigin: origin,
        accountId: owner,
        rootKeyId: endpoint.current().checkpoint.rootKeyId,
        hostDeviceId: endpoint.deviceId,
      },
      runtime: runtimeCatalog,
    });
    products.synchronize();
    transport = new EncryptedHostTransport({
      endpoint,
      dispatcher,
      products,
      catalog: () => ({ ...runtimeCatalog(), catalogVersion: 2, products: products.read() }),
      invalidated: () => {
        workspace.previewManager.invalidateUnavailable();
        workspace.taskManager.invalidateUnavailable();
        workspace.invalidateMcp();
      },
    });
    const activeTransport = transport;
    await new Promise<void>((resolve, reject) => {
      const changed = () => {
        if (activeTransport.ready) {
          activeTransport.socket.off('message', changed);
          activeTransport.socket.off('close', stopped);
          resolve();
        }
      };
      const stopped = () => reject(Error('Synthetic Host closed before ready'));
      activeTransport.socket.on('message', changed);
      activeTransport.socket.once('close', stopped);
      changed();
    });
    const needles = ['SYNTHETIC_PRIVATE_', privateRoot, recovery];
    const assertPrivateBytes = (value: string | Uint8Array, location: string) => {
      const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
      for (const needle of needles)
        for (const encoding of ['utf8', 'utf16le'] as const)
          assert(
            !bytes.includes(Buffer.from(needle, encoding)),
            location + ' exposed synthetic private content',
          );
    };
    return {
      origin,
      owner,
      cookie,
      clientFile,
      outcomes,
      inputs,
      mcpDescriptors,
      integrations,
      workspaces: {
        forks,
        opens,
        project,
        git,
        failNextFork(fault: 'reject' | 'after-native') {
          current();
          assert(!nextForkFault);
          nextForkFault = fault;
        },
      },
      dropNextGitReply() {
        current();
        assert(!armed && !drop);
        armed = 'git';
      },
      dropNextForkReply() {
        current();
        assert(!armed && !drop);
        armed = 'fork';
      },
      waitMcpOpened: (sequence: number) => mcpOpened.wait(sequence),
      assertMcpCurrent(sequence: number) {
        const check = mcpCurrent.get(sequence);
        assert(check, 'Synthetic MCP grant must have opened');
        check();
      },
      continueMcp: (sequence: number) => mcpContinue.mark(sequence),
      get prompts() {
        return prompts;
      },
      get droppedReplies() {
        return droppedReplies;
      },
      waitPermission: (sequence: number) => permissionSignal.wait(sequence),
      waitCompleted: (sequence: number) => completedSignal.wait(sequence),
      dropNextPermissionReply() {
        current();
        assert(!armed && !drop, 'Synthetic permission reply fault is already armed');
        armed = 'permission';
      },
      dropNextAttachmentReply() {
        current();
        assert(!armed && !drop, 'Synthetic attachment reply fault is already armed');
        armed = 'attachment';
      },
      dropNextTurnReply() {
        current();
        assert(!armed && !drop, 'Synthetic turn reply fault is already armed');
        armed = 'turn';
      },
      dropNextGithubWriteReply() {
        current();
        assert(!armed && !drop, 'Synthetic GitHub reply fault is already armed');
        armed = 'github-write';
      },
      assertOpaque() {
        current();
        const paths: string[] = [ENCRYPTED_BRIDGE_PATHS.client, ENCRYPTED_BRIDGE_PATHS.host];
        assert(
          wire.every((frame) => paths.includes(frame.path)),
          'Unexpected non-v4 transport',
        );
        for (const frame of wire) assertPrivateBytes(frame.text, 'Relay frame');
        const requests = wire.filter(
          (frame) =>
            frame.path === ENCRYPTED_BRIDGE_PATHS.client &&
            frame.direction === 'in' &&
            frame.record?.header.kind === 'request',
        );
        assert(
          requests.some(({ record }) =>
            [
              [ENCRYPTED_BRIDGE_PATHS.host, 'out', 'request'],
              [ENCRYPTED_BRIDGE_PATHS.host, 'in', 'response'],
              [ENCRYPTED_BRIDGE_PATHS.client, 'out', 'response'],
            ].every(([path, direction, kind]) =>
              wire.some(
                (frame) =>
                  frame.delivered &&
                  frame.path === path &&
                  frame.direction === direction &&
                  frame.record?.header.kind === kind &&
                  frame.record.header.requestId === record!.header.requestId,
              ),
            ),
          ),
          'No complete encrypted client/Relay/Host round trip',
        );
        const tables = relay!.db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all();
        for (const { name } of tables) {
          const rows = relay!.db
            .prepare('SELECT * FROM "' + String(name).replaceAll('"', '""') + '"')
            .all();
          for (const row of rows)
            for (const value of Object.values(row))
              if (typeof value === 'string' || value instanceof Uint8Array)
                assertPrivateBytes(value, 'Relay table ' + name);
        }
        for (const suffix of ['', '-wal', '-shm'])
          if (existsSync(relayFile + suffix))
            assertPrivateBytes(readFileSync(relayFile + suffix), 'Relay SQLite' + suffix);
        assert(http.length > 0 && http.every((request) => request === 'GET /api/me'));
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
