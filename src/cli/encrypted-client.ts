import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { agentSchema, id, sessionActionSchema } from '../protocol';
import { hostCommandSchema, type HostCommand } from '../bridge/host-command';
import { DeviceManager } from '../security/device-manager';
import { assertPrivatePathsOutsideProjects } from '../security/private-project-path';
import {
  EncryptedBridgeClient,
  EncryptedHostError,
  encryptedCommandTarget,
} from '../security/encrypted-bridge-client';
import {
  ENCRYPTED_BRIDGE_LIMITS,
  ENCRYPTED_BRIDGE_PATHS,
  type EncryptedCatalog,
} from '../security/encrypted-bridge-protocol';
import {
  encryptedProductActionSchema,
  validateEncryptedProductReceipt,
  validateEncryptedProductInspection,
  type EncryptedProductAuthority,
} from '../security/encrypted-product-catalog';
import { buildSessionTurn, readClientSession } from '../session-client';
import { mutationReceiptSchema, validateSessionActionReceipt } from '../session-responses';
import {
  sessionControlActionSchema,
  sessionOperationSchema,
  validateSessionControlReceipt,
  validateSessionOperationResult,
} from '../session-control-protocol';
import { mcpReadSchema, mcpServerIdsSchema, validateMcpRead } from '../mcp-protocol';
import { SECURE_TURN_AUTHORITY_FEATURE } from '../task-protocol';
import { CliError, type CliArgs } from './args';
import { CliHttp, connectionSchema } from './http';
import { cliInput } from './input';
import { waitPause, type CliDependencies } from './client';
import {
  secureOriginal,
  secureCatalogOriginal,
  secureCatalogTargetSchema,
  type SecureCatalogOperation,
  secureTargetSchema,
  type SecureCliOperation,
  type SecureCliTarget,
} from './secure-operation';

const authSchema = z.object({ kind: z.literal('remote'), connection: connectionSchema }).strict();
const summary = (op: SecureCliOperation) => ({
  operationId: op.operationId,
  kind: op.kind,
  target: op.target,
  state: op.state,
  requestVersion: op.requestVersion,
  createdAt: op.createdAt,
  ...(op.receipt === undefined ? {} : { receipt: op.receipt }),
});
const catalogSummary = (op: SecureCatalogOperation) => ({
  operationId: op.operationId,
  target: op.target,
  state: op.state,
  requestVersion: op.requestVersion,
  createdAt: op.createdAt,
  ...(op.receipt === undefined ? {} : { receipt: op.receipt }),
});
const catalogAuthority = (op: SecureCatalogOperation): EncryptedProductAuthority => ({
  serverOrigin: op.target.serverOrigin,
  accountId: op.target.accountId,
  rootKeyId: op.target.rootKeyId,
  hostDeviceId: op.target.hostDeviceId,
});
function catalogUnknown(operationId: string): never {
  throw new CliError(
    'unknown',
    '加密目录原操作结果未确认；请手动 catalog-inspect、catalog-retry 或 catalog-abandon。',
    6,
    operationId,
  );
}
const scope = (target: SecureCliTarget) => ({
  controlVersion: 1 as const,
  workspaceId: target.workspaceId,
  localProjectId: target.localProjectId,
  userId: target.userId,
  machineId: target.machineId,
  sessionId: target.sessionId,
});
function unknown(operationId: string): never {
  throw new CliError(
    'unknown',
    '加密原操作结果未确认；请手动 secure inspect、retry 或 abandon，不会自动重发。',
    6,
    operationId,
  );
}

/** Explicit secure CLI workflows. Their outbox never enters the legacy HTTP command path. */
export class EncryptedCliClient {
  constructor(private readonly deps: CliDependencies) {}
  get state() {
    return this.deps.state;
  }
  uuid() {
    return (this.deps.uuid ?? randomUUID)();
  }
  now() {
    return (this.deps.now ?? Date.now)();
  }
  async run(args: CliArgs): Promise<unknown> {
    if (args.command === 'operations') return this.state.secureOperationSummaries();
    if (args.command === 'catalog-operations') return this.state.secureCatalogOperationSummaries();
    const expected = this.state.settingsRevision(),
      auth = authSchema.parse(this.state.get('auth'));
    const current = () => {
      if (this.deps.signal?.aborted || this.state.settingsRevision() !== expected)
        throw new CliError('authentication', '加密连接的原登录或设置已改变；请重新核对。', 3);
    };
    current();
    const endpointPath = String(args.flags.endpoint ?? '');
    if (!isAbsolute(endpointPath))
      throw new CliError('endpoint', '加密端点必须使用项目外的私有绝对文件路径。');
    let manager: DeviceManager | undefined, client: EncryptedBridgeClient | undefined;
    try {
      manager = await DeviceManager.open(endpointPath);
      current();
      const status = manager.status();
      if (
        status.phase !== 'active' ||
        !('device' in status) ||
        status.pin.accountId !== auth.connection.owner ||
        status.pin.serverOrigin !== auth.connection.origin
      )
        throw new CliError('endpoint', '端点与当前登录账号和服务不匹配。', 3);
      const trust = manager.current();
      if (!trust) throw Error();
      trust.device(status.device.deviceId, 'client');
      const key = await manager.encryptionKey();
      current();
      await new CliHttp(auth.connection, {
        fetch: this.deps.fetch,
        signal: this.deps.signal,
        deadline: this.deps.deadline,
        current,
      }).identity();
      current();
      const url = new URL(ENCRYPTED_BRIDGE_PATHS.client, auth.connection.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url, {
        headers: { Origin: auth.connection.origin, Cookie: auth.connection.cookie },
        maxPayload: ENCRYPTED_BRIDGE_LIMITS.wireBytes,
        perMessageDeflate: false,
        followRedirects: false,
      });
      client = await EncryptedBridgeClient.connect({
        socket,
        trust,
        clientDeviceId: status.device.deviceId,
        privateKey: key,
        signal: this.deps.signal,
        current: () => {
          current();
          return manager?.current();
        },
      });
      current();
      if (args.command === 'hosts') return { hosts: client.hosts(), verified: false };
      let original: SecureCliOperation | undefined;
      if (['inspect', 'retry', 'abandon'].includes(args.command)) {
        original = this.state.secureOperation(id.parse(args.positional));
        if (!original) throw new CliError('operation', '未找到这个加密原操作。', 5);
      }
      let catalogOriginal: SecureCatalogOperation | undefined;
      if (['catalog-inspect', 'catalog-retry', 'catalog-abandon'].includes(args.command)) {
        catalogOriginal = this.state.secureCatalogOperation(id.parse(args.positional));
        if (!catalogOriginal) throw new CliError('operation', '未找到这个加密目录原操作。', 5);
      }
      const hostId = id.parse(
        original?.target.hostDeviceId ?? catalogOriginal?.target.hostDeviceId ?? args.flags.host,
      );
      const catalog = await client.catalog(hostId);
      current();
      const projectRoots = catalog.workspaces.flatMap((workspace) =>
        workspace.projects.map((project) => project.rootPath),
      );
      this.state.assertOutsideProjects(projectRoots);
      assertPrivatePathsOutsideProjects([endpointPath], projectRoots);
      if (args.command === 'catalog') return { hostDeviceId: hostId, catalog };
      const productAuthority = {
        serverOrigin: auth.connection.origin,
        accountId: auth.connection.owner,
        rootKeyId: status.pin.rootKeyId,
        hostDeviceId: hostId,
      };
      if (catalogOriginal) {
        const expectedTarget = secureCatalogTargetSchema.parse({
          ...productAuthority,
          clientDeviceId: status.device.deviceId,
        });
        if (
          Object.entries(expectedTarget).some(
            ([key, value]) => catalogOriginal!.target[key as keyof typeof expectedTarget] !== value,
          )
        )
          throw new CliError('scope', '目录原操作不属于当前账号、根或设备。', 5);
        if (args.command === 'catalog-retry') {
          if (catalogOriginal.state === 'ending')
            throw new CliError(
              'ending',
              '目录原操作已请求封存，请继续 catalog-inspect 或 catalog-abandon。',
              6,
              catalogOriginal.operationId,
            );
          if (catalogOriginal.state !== 'pending') return catalogSummary(catalogOriginal);
          return await this.deliverCatalog(client, catalogOriginal, false, current);
        }
        return await this.recoverCatalog(
          client,
          catalogOriginal,
          args.command === 'catalog-inspect' ? 'inspect' : 'abandon',
          current,
        );
      }
      if (args.command === 'organize') {
        if (catalog.catalogVersion !== 2)
          throw new CliError('catalog', '此主机尚未提供产品目录；未发送目录变更。', 5);
        const input: unknown = JSON.parse((await cliInput(args, this.deps.stdin, 64 * 1024))!);
        current();
        if (
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          Object.hasOwn(input, 'operationId') ||
          Object.hasOwn(input, 'version')
        )
          throw new CliError(
            'input',
            '目录输入只接受 action、expectedRevision 和动作字段；原操作编号由 CLI 固定生成。',
          );
        const action = encryptedProductActionSchema.parse({
          ...input,
          version: 1,
          operationId: this.uuid(),
        });
        client.assertCurrent();
        const staged = this.state.secureCatalogStage(
          {
            operationId: action.operationId,
            target: secureCatalogTargetSchema.parse({
              ...productAuthority,
              clientDeviceId: status.device.deviceId,
            }),
            body: JSON.stringify(action),
          },
          new Date(this.now()).toISOString(),
        );
        return await this.deliverCatalog(client, staged, true, current);
      }
      if (original) {
        if (args.flags.timeout !== undefined && !original.mcpReview?.servers.length)
          throw new CliError('usage', '--timeout 仅用于等待含 MCP 的原回合。');
        if (
          original.mcpReview?.servers.length &&
          !catalog.workspaces
            .find((workspace) => workspace.id === original.target.workspaceId)
            ?.features?.includes(SECURE_TURN_AUTHORITY_FEATURE)
        )
          throw new CliError(
            'mcp',
            '执行主机尚不支持完整的加密回合授权，请升级后核查原 MCP 操作。',
            5,
            original.operationId,
          );
        this.matchTarget(original.target, catalog, {
          origin: auth.connection.origin,
          owner: auth.connection.owner,
          rootKeyId: status.pin.rootKeyId,
          clientDeviceId: status.device.deviceId,
          hostDeviceId: hostId,
        });
        if (args.command === 'retry') {
          if (original.state === 'ending')
            throw new CliError(
              'ending',
              '原操作已请求封存，请继续 inspect 或 abandon。',
              6,
              original.operationId,
            );
          if (original.state !== 'pending') return summary(original);
          if (catalog.catalogVersion === 2 && !original.target.product)
            throw new CliError(
              'unmapped-operation',
              '旧原操作没有产品映射，只能 inspect 或 abandon；不会用最新目录重新绑定。',
              5,
              original.operationId,
            );
          if (original.kind === 'turn' && !original.userTurnId)
            throw new CliError(
              'turn-binding',
              '旧回合原操作没有精确回合绑定，只能 inspect 或 abandon；未重发。',
              5,
              original.operationId,
            );
          const confirmation = await this.deliver(client, original, false, current);
          return original.mcpReview?.servers.length && confirmation.state === 'accepted'
            ? {
                ...confirmation,
                execution: await this.waitForMcp(
                  client,
                  this.state.secureOperation(original.operationId)!,
                  args,
                  current,
                ),
              }
            : confirmation;
        }
        return await this.recover(client, original, args.command as 'inspect' | 'abandon', current);
      }
      const selectedReplica =
        catalog.catalogVersion === 2 && args.flags.space && args.flags.replica
          ? catalog.products.replicas.find(
              (replica) =>
                replica.catalogWorkspaceId === args.flags.space &&
                replica.id === args.flags.replica &&
                replica.available,
            )
          : undefined;
      const workspace = catalog.workspaces.find(
          (workspace) =>
            workspace.id === (selectedReplica?.runtimeWorkspaceId ?? args.flags.workspace),
        ),
        project = workspace?.projects.find(
          (project) => project.id === (selectedReplica?.localProjectId ?? args.flags.project),
        );
      if (!workspace || !project)
        throw new CliError('target', '请选择加密目录中明确且可用的产品副本或运行工作区和项目。', 5);
      const product =
        catalog.catalogVersion === 2
          ? encryptedCommandTarget(catalog, {
              method: 'sessions',
              workspaceId: workspace.id,
              localProjectId: project.id,
              params: {},
            })
          : undefined;
      const base = {
        origin: auth.connection.origin,
        owner: auth.connection.owner,
        rootKeyId: status.pin.rootKeyId,
        clientDeviceId: status.device.deviceId,
        hostDeviceId: hostId,
        workspaceId: workspace.id,
        localProjectId: project.id,
        userId: workspace.userId,
        machineId: workspace.machineId,
        ...(product ? { product } : {}),
      };
      const command = (method: HostCommand['method'], params: unknown) =>
        hostCommandSchema.parse({
          method,
          workspaceId: workspace.id,
          localProjectId: project.id,
          params,
        });
      if (args.command === 'list')
        return {
          hostDeviceId: hostId,
          workspaceId: workspace.id,
          localProjectId: project.id,
          sessions: await client.execute(hostId, command('sessions', {}), product),
          ...(product ? { product } : {}),
        };
      const target = secureTargetSchema.parse({
        ...base,
        sessionId:
          args.positional ??
          args.flags.session ??
          (args.command === 'create' ? this.uuid() : undefined),
      });
      const stage = (
        kind: SecureCliOperation['kind'],
        request: HostCommand,
        mcpReview?: SecureCliOperation['mcpReview'],
        userTurnId?: string,
      ) => {
        current();
        client!.assertCurrent();
        const operationId = (request.params as { operationId: string }).operationId;
        return this.state.secureStage(
          {
            operationId,
            kind,
            target,
            body: JSON.stringify(request),
            ...(mcpReview ? { mcpReview } : {}),
            ...(userTurnId ? { userTurnId } : {}),
          },
          new Date(this.now()).toISOString(),
        );
      };
      if (args.command === 'create') {
        const agentId = id.parse(args.flags.agent);
        if (!workspace.agents.some((agent) => agent.id === agentId))
          throw new CliError('agent', '请选择此加密目录中的固定 Agent 版本。', 5);
        const title = await cliInput(args, this.deps.stdin, 800, false);
        current();
        const action = sessionControlActionSchema.parse({
          ...scope(target),
          operationId: this.uuid(),
          action: 'create',
          agentId,
          ...(title?.trim() ? { title: title.trim() } : {}),
        });
        return await this.deliver(
          client,
          stage('create', command('session-control', action)),
          true,
          current,
        );
      }
      const raw = await client.execute(
        hostId,
        command('session', { sessionId: target.sessionId }),
        product,
      );
      current();
      const read = readClientSession(raw, scope(target));
      if (args.command === 'read') return { target, ...read };
      const readMcp = async () => {
        const request = mcpReadSchema.parse({
          mcpVersion: 1,
          workspaceId: target.workspaceId,
          localProjectId: target.localProjectId,
          sessionId: target.sessionId,
        });
        return validateMcpRead(
          await client!.execute(hostId, command('mcp-read', request), product),
          request,
        );
      };
      if (args.command === 'mcp') return { target, ...(await readMcp()) };
      if (args.command === 'send') {
        if (args.flags.agent && args.flags.agent !== read.meta.agentConfigId)
          throw new CliError('agent', '已有会话固定原 Agent 版本；未发送。', 5);
        if (!read.agent)
          throw new CliError('agent', '主机没有提供此会话的固定 Agent 版本；未发送。', 5);
        const mcpServerIds = mcpServerIdsSchema.parse(
          args.flags['mcp-server-ids'] ? String(args.flags['mcp-server-ids']).split(',') : [],
        );
        if (args.flags.timeout !== undefined && !mcpServerIds.length)
          throw new CliError('usage', '--timeout 仅用于等待含 MCP 的原回合。');
        let mcpReview: SecureCliOperation['mcpReview'];
        if (mcpServerIds.length) {
          if (!workspace.features?.includes(SECURE_TURN_AUTHORITY_FEATURE))
            throw new CliError(
              'mcp',
              '执行主机尚不支持完整的加密回合授权，请升级后重新审阅 MCP。',
              5,
            );
          const mcp = await readMcp();
          if (mcpServerIds.some((id) => !mcp.servers.some((server) => server.id === id)))
            throw new CliError('mcp', '所选 MCP 版本不可用；请重新核对。', 5);
          mcpReview = {
            reviewId: this.uuid(),
            servers: mcpServerIds.map((id) => mcp.servers.find((server) => server.id === id)!),
          };
        }
        const prompt = (await cliInput(args, this.deps.stdin))!;
        current();
        const userTurnId = this.uuid();
        const request = buildSessionTurn({
          scope: scope(target),
          read,
          agent: agentSchema.parse(read.agent),
          prompt,
          mcpServerIds,
          selection: {
            ...(args.flags.model ? { modelId: String(args.flags.model) } : {}),
            ...(args.flags.effort ? { reasoningEffort: String(args.flags.effort) } : {}),
            ...(args.flags.mode ? { modeId: String(args.flags.mode) } : {}),
          },
          operationId: this.uuid(),
          turnId: userTurnId,
          peerId: this.uuid().replaceAll('-', '').slice(0, 16),
          now: new Date(this.now()).toISOString(),
        });
        const op = stage('turn', command('mutate', request), mcpReview, userTurnId);
        const confirmation = await this.deliver(client, op, true, current);
        return mcpReview?.servers.length && confirmation.state === 'accepted'
          ? {
              ...confirmation,
              execution: await this.waitForMcp(
                client,
                this.state.secureOperation(op.operationId)!,
                args,
                current,
              ),
            }
          : confirmation;
      }
      if (args.command === 'stop') {
        const active = read.history.find((turn) => turn.role === 'assistant' && !turn.finished),
          turnId = id.parse(args.flags.turn ?? active?.id);
        if (!active || active.id !== turnId)
          throw new CliError('turn', '未找到精确匹配的活动回合；请重新读取。', 5);
        const request = sessionControlActionSchema.parse({
          ...scope(target),
          operationId: this.uuid(),
          action: 'stop',
          turnId,
        });
        return await this.deliver(
          client,
          stage('stop', command('session-control', request)),
          true,
          current,
        );
      }
      const request = sessionActionSchema.parse({
        operationId: this.uuid(),
        workspaceId: target.workspaceId,
        localProjectId: target.localProjectId,
        sessionId: target.sessionId,
        expectedRevision: read.meta.metadataRevision ?? 0,
        action: args.command,
        ...(args.command === 'rename'
          ? { title: (await cliInput(args, this.deps.stdin, 800))!.trim() }
          : {}),
      });
      return await this.deliver(
        client,
        stage('session-action', command('session-action', request)),
        true,
        current,
      );
    } finally {
      client?.close();
      manager?.close();
    }
  }
  private matchTarget(
    target: SecureCliTarget,
    catalog: EncryptedCatalog,
    expected: Pick<
      SecureCliTarget,
      'origin' | 'owner' | 'rootKeyId' | 'clientDeviceId' | 'hostDeviceId'
    >,
  ) {
    if (
      Object.entries(expected).some(
        ([key, value]) => target[key as keyof SecureCliTarget] !== value,
      )
    )
      throw new CliError('scope', '原操作不属于当前账号、根或设备。', 5);
    const workspace = catalog.workspaces.find((workspace) => workspace.id === target.workspaceId);
    if (
      !workspace ||
      workspace.userId !== target.userId ||
      workspace.machineId !== target.machineId ||
      !workspace.projects.some((project) => project.id === target.localProjectId)
    )
      throw new CliError('scope', '原操作的执行范围已改变；未迁移或重发。', 5);
  }
  /** Keep this authorization channel alive; observing completion never resends the original. */
  private async waitForMcp(
    client: EncryptedBridgeClient,
    operation: SecureCliOperation,
    args: CliArgs,
    current: () => void,
  ) {
    const userTurnId = operation.userTurnId;
    if (!userTurnId || operation.state !== 'accepted' || !operation.mcpReview?.servers.length)
      throw new CliError(
        'turn-binding',
        '原 MCP 操作缺少精确回合绑定；请手动核查。',
        6,
        operation.operationId,
      );
    const duration = args.flags.timeout === undefined ? undefined : Number(args.flags.timeout);
    const expiresAt = duration === undefined ? undefined : this.now() + duration;
    const ending =
      duration === undefined ? undefined : (this.deps.deadline ?? AbortSignal.timeout)(duration);
    const signals = [this.deps.signal, ending].filter((signal): signal is AbortSignal => !!signal);
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    const close = () => client.close();
    signal?.addEventListener('abort', close, { once: true });
    try {
      if (signal?.aborted) close();
      while (true) {
        current();
        if (ending?.aborted || (expiresAt !== undefined && this.now() >= expiresAt)) throw Error();
        const target = operation.target;
        const raw = await client.execute(
          target.hostDeviceId,
          {
            method: 'session',
            workspaceId: target.workspaceId,
            localProjectId: target.localProjectId,
            params: { sessionId: target.sessionId },
          },
          target.product,
        );
        current();
        const read = readClientSession(raw, scope(target));
        if (signal?.aborted || (expiresAt !== undefined && this.now() >= expiresAt)) throw Error();
        if (read.persisted === false || read.persistenceError) throw Error();
        const user = read.history.find((turn) => turn.id === userTurnId && turn.role === 'user');
        if (
          !user ||
          user.userId !== target.userId ||
          JSON.stringify(
            mcpServerIdsSchema.parse(
              (user.inputConfig as { mcpServerIds?: unknown } | undefined)?.mcpServerIds,
            ),
          ) !== JSON.stringify(operation.mcpReview.servers.map((server) => server.id))
        )
          throw Error();
        const assistants = read.history.filter(
          (turn) => turn.role === 'assistant' && turn.userTurnId === userTurnId,
        );
        if (assistants.length > 1) throw Error();
        const assistant = assistants[0];
        if (assistant?.finished) {
          if (assistant.status !== 'handled')
            throw new CliError(
              'turn-failed',
              '主机已接受原 MCP 操作，但此精确回合未成功完成；原接受回执已保留。',
              7,
              operation.operationId,
            );
          return { userTurnId, assistantTurnId: assistant.id, status: 'handled' as const };
        }
        await (this.deps.pause ?? waitPause)(
          expiresAt === undefined ? 1000 : Math.max(1, Math.min(1000, expiresAt - this.now())),
          signal,
        );
      }
    } catch (error) {
      if (this.deps.signal?.aborted)
        throw new CliError(
          'interrupted',
          '原 MCP 操作已被主机接受；等待中断并关闭授权连接，已请求撤销此回合。已派发的外部操作请核查原结果。',
          130,
          operation.operationId,
        );
      if (ending?.aborted || (expiresAt !== undefined && this.now() >= expiresAt))
        throw new CliError(
          'wait-timeout',
          '原 MCP 操作已被主机接受；等待超时并关闭授权连接，已请求撤销此回合。已派发的外部操作请核查原结果。',
          7,
          operation.operationId,
        );
      if (error instanceof CliError && error.code === 'turn-failed') throw error;
      throw new CliError(
        'execution-unconfirmed',
        '原 MCP 操作已被主机接受，但精确回合结果无法确认；授权连接已关闭，原接受回执已保留。',
        6,
        operation.operationId,
      );
    } finally {
      signal?.removeEventListener('abort', close);
      client.close();
    }
  }
  private async deliver(
    client: EncryptedBridgeClient,
    op: SecureCliOperation,
    first: boolean,
    current: () => void,
  ) {
    try {
      current();
      const raw = await client.execute(
        op.target.hostDeviceId,
        hostCommandSchema.parse(JSON.parse(op.body)),
        op.target.product,
      );
      current();
      let receipt: unknown,
        state: SecureCliOperation['state'] = 'accepted';
      const original = secureOriginal(op);
      if (original.kind === 'control') {
        const parsed = validateSessionControlReceipt(raw, scope(op.target), original);
        receipt = parsed;
        if (parsed.status === 'stopping') state = 'pending';
        else if (parsed.status === 'abandoned') state = 'abandoned';
      } else if (original.kind === 'mutation') {
        const parsed = mutationReceiptSchema.parse(raw);
        if (parsed.operationId !== op.operationId) throw Error();
        receipt = parsed;
        if (!parsed.accepted) state = 'abandoned';
      } else if (original.kind === 'attachment') {
        // The durable attachment schema validates the complete original receipt before accepting it.
        receipt = raw;
      } else {
        const parsed = validateSessionActionReceipt(original.value, raw);
        receipt = parsed;
        if (!parsed.accepted) state = 'abandoned';
      }
      return summary(this.state.secureTransition(op.operationId, ['pending'], state, receipt));
    } catch (error) {
      if (error instanceof EncryptedHostError && error.rejected && first) {
        current();
        this.state.secureTransition(op.operationId, ['pending'], 'rejected');
        throw new CliError(
          'rejected',
          '主机明确拒绝了这次新的加密操作，原记录已保留。',
          5,
          op.operationId,
        );
      }
      return unknown(op.operationId);
    }
  }
  private async recover(
    client: EncryptedBridgeClient,
    op: SecureCliOperation,
    action: 'inspect' | 'abandon',
    current: () => void,
  ) {
    if (action === 'abandon' && !['pending', 'ending'].includes(op.state)) return summary(op);
    if (action === 'abandon' && op.state === 'pending')
      op = this.state.secureTransition(op.operationId, ['pending'], 'ending');
    const request = sessionOperationSchema.parse({
      ...scope(op.target),
      action,
      request: secureOriginal(op),
    });
    try {
      current();
      const result = validateSessionOperationResult(
        await (op.target.product
          ? client.execute(
              op.target.hostDeviceId,
              {
                method: 'session-operations',
                workspaceId: op.target.workspaceId,
                localProjectId: op.target.localProjectId,
                params: request,
              },
              op.target.product,
            )
          : client.executeLegacyOperation(op.target.hostDeviceId, {
              method: 'session-operations',
              workspaceId: op.target.workspaceId,
              localProjectId: op.target.localProjectId,
              params: request,
            })),
        request,
      );
      current();
      if (
        result.found &&
        ['accepted', 'abandoned', 'interrupted'].includes(result.receipt.status) &&
        ['pending', 'ending'].includes(op.state)
      )
        op = this.state.secureTransition(
          op.operationId,
          ['pending', 'ending'],
          result.receipt.status === 'abandoned' ? 'abandoned' : 'accepted',
          result.receipt,
        );
      return { ...summary(op), inspection: result };
    } catch {
      return unknown(op.operationId);
    }
  }
  private async deliverCatalog(
    client: EncryptedBridgeClient,
    op: SecureCatalogOperation,
    first: boolean,
    current: () => void,
  ) {
    try {
      current();
      const request = secureCatalogOriginal(op);
      const receipt = validateEncryptedProductReceipt(
        await client.catalogAction(op.target.hostDeviceId, request),
        catalogAuthority(op),
        request,
      );
      current();
      return catalogSummary(
        this.state.secureCatalogTransition(op.operationId, ['pending'], receipt.status, receipt),
      );
    } catch (error) {
      if (error instanceof EncryptedHostError && error.rejected && first) {
        current();
        this.state.secureCatalogTransition(op.operationId, ['pending'], 'rejected');
        throw new CliError(
          'rejected',
          '主机明确拒绝了新的目录操作，原记录已保留。',
          5,
          op.operationId,
        );
      }
      return catalogUnknown(op.operationId);
    }
  }
  private async recoverCatalog(
    client: EncryptedBridgeClient,
    op: SecureCatalogOperation,
    action: 'inspect' | 'abandon',
    current: () => void,
  ) {
    if (action === 'abandon' && !['pending', 'ending'].includes(op.state))
      return catalogSummary(op);
    if (action === 'abandon' && op.state === 'pending')
      op = this.state.secureCatalogTransition(op.operationId, ['pending'], 'ending');
    try {
      current();
      const request = secureCatalogOriginal(op);
      const raw = await client.catalogOperation(op.target.hostDeviceId, { action, request });
      const inspection =
        action === 'inspect'
          ? validateEncryptedProductInspection(raw, catalogAuthority(op), request)
          : undefined;
      const receipt = inspection
        ? inspection.found
          ? inspection.receipt
          : undefined
        : validateEncryptedProductReceipt(raw, catalogAuthority(op), request);
      current();
      if (receipt && ['pending', 'ending'].includes(op.state))
        op = this.state.secureCatalogTransition(
          op.operationId,
          ['pending', 'ending'],
          receipt.status,
          receipt,
        );
      return { ...catalogSummary(op), ...(inspection ? { inspection } : {}) };
    } catch {
      return catalogUnknown(op.operationId);
    }
  }
}
