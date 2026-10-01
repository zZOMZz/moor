import { NodeHttp, connectionSchema, serverOrigin } from '@moor/client/adapters/node/http';
import {
  listTargets,
  replicaBase,
  resolveTarget,
  type CliResolvedTarget,
} from '@moor/client/adapters/node/targets';
import { buildSendTurn } from '@moor/client/features/sessions/session-intent';
import {
  ConfirmationPersistenceFailure,
  deliverOriginalOperation,
  persistOriginalConfirmation,
  recoverOriginalOperation,
} from '@moor/client/operations/session-operation';
import { readLocalCliConnection } from '@moor/local-state/private-connection';
import {
  RETIRED_RECORDS_FEATURE,
  RETIRED_SESSION_FEATURE,
} from '@moor/protocol/connection-authority';
import { hostCommandContracts } from '@moor/protocol/host-command-contract';
import { MCP_LIMITS, mcpReadSchema, validateMcpRead } from '@moor/protocol/mcp-protocol';
import {
  AGENT_VERSIONS_FEATURE,
  agentSchema,
  id,
  mutationSchema,
  sessionActionSchema,
} from '@moor/protocol/protocol';
import { RequestFailure, isRequestRejected } from '@moor/protocol/request-failure';
import {
  SESSION_CONTROL_FEATURE,
  sessionControlActionSchema,
  sessionOperationSchema,
  type SessionControlScope,
  type SessionOriginalOperation,
} from '@moor/protocol/session-control-protocol';
import {
  SESSION_INTENTS_FEATURE,
  respondPermissionSchema,
  sendTurnSchema,
} from '@moor/protocol/session-intent-protocol';
import { SESSION_RESPONSE_LIMITS, sessionListSchema } from '@moor/protocol/session-responses';
import { readClientSession } from '@moor/session/session-operations';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CliError, type CliArgs } from './args';
import { CliGoogleAuth } from './google-auth';
import { cliInput } from './input';
import { exportRetiredOperation } from './retired';
import { CliState, type CliOperation, type CliTarget } from './state';
export type CliDependencies = {
  state: CliState;
  fetch?: typeof fetch;
  stdin: AsyncIterable<Uint8Array | string>;
  signal?: AbortSignal;
  deadline?: (ms: number) => AbortSignal;
  uuid?: () => string;
  now?: () => number;
  pause?: (ms: number, signal?: AbortSignal) => Promise<void>;
  event?: (value: unknown) => void;
};
const authSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('remote'), connection: connectionSchema }).strict(),
  z.object({ kind: z.literal('local'), file: z.string() }).strict(),
]);
const loginSchema = z
  .object({ email: z.string().email().max(200), password: z.string().min(1).max(1024) })
  .strict();
const googleConfirmationSchema = z
  .object({
    expectedEmail: z.string().min(1).max(320),
    expectedCode: z.string().regex(/^[A-F0-9]{4}-[A-F0-9]{4}$/),
  })
  .strict();
function scope(target: CliTarget): SessionControlScope {
  return {
    controlVersion: 1,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId: id.parse(target.sessionId),
    userId: target.userId,
    machineId: target.machineId,
  };
}
function original(op: CliOperation): SessionOriginalOperation {
  const value = JSON.parse(op.body);
  return op.kind === 'send-turn'
    ? { kind: 'send-turn', value: sendTurnSchema.parse(value) }
    : op.kind === 'respond-permission'
      ? { kind: 'respond-permission', value: respondPermissionSchema.parse(value) }
      : op.kind === 'turn'
        ? { kind: 'mutation', value: mutationSchema.parse(value) }
        : op.kind === 'session-action'
          ? { kind: 'metadata', value: sessionActionSchema.parse(value) }
          : { kind: 'control', value: sessionControlActionSchema.parse(value) };
}
function summary(op: CliOperation) {
  return {
    operationId: op.operationId,
    kind: op.kind,
    state: op.state,
    target: op.target,
    requestVersion: op.requestVersion,
    createdAt: op.createdAt,
    ...(op.receipt ? { receipt: op.receipt } : {}),
  };
}
function requireFeature(target: CliResolvedTarget, feature: string) {
  if (!target.features.includes(feature))
    throw new CliError('unsupported', '此执行电脑尚不支持所需的会话接口，请升级主机。', 5);
}
export function waitPause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CliError('interrupted', '等待已结束，未发送停止操作。', 130));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    function abort() {
      clearTimeout(timer);
      reject(new CliError('interrupted', '等待已结束，未发送停止操作。', 130));
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export class CliClient {
  constructor(readonly deps: CliDependencies) {}
  get state() {
    return this.deps.state;
  }
  uuid() {
    return (this.deps.uuid ?? randomUUID)();
  }
  now() {
    return (this.deps.now ?? Date.now)();
  }
  async http(args: CliArgs) {
    const stored = authSchema.optional().parse(this.state.get('auth'));
    if (args.flags.connection || (stored?.kind === 'local' && !args.flags.server)) {
      const file = String(args.flags.connection ?? (stored as { file: string }).file);
      let local;
      try {
        local = readLocalCliConnection(file);
      } catch {
        throw new CliError(
          'local-connection',
          '本机连接文件不可用，请确认主机正在运行并选择其私有连接文件。',
          3,
        );
      }
      return new NodeHttp(
        {
          origin: local.connection.origin,
          cookie: 'personal=' + local.connection.secret,
          owner: local.connection.ownerId,
        },
        {
          fetch: this.deps.fetch,
          local,
          signal: this.deps.signal,
          deadline: this.deps.deadline,
          current: () => this.state.assertCurrent(),
        },
      );
    }
    if (!stored || stored.kind !== 'remote')
      throw new CliError('authentication', '请先登录或通过 --connection 选择本机连接。', 3);
    if (args.flags.server && serverOrigin(String(args.flags.server)) !== stored.connection.origin)
      throw new CliError('authentication', '指定服务器与保存的登录不同，请先显式登录。', 3);
    return new NodeHttp(connectionSchema.parse(stored.connection), {
      fetch: this.deps.fetch,
      signal: this.deps.signal,
      deadline: this.deps.deadline,
      current: () => this.state.assertCurrent(),
    });
  }
  async target(http: NodeHttp, args: CliArgs, withSession = false) {
    const saved = this.state.target();
    let target: CliTarget;
    if (args.flags.workspace || args.flags.replica) {
      if (!args.flags.workspace || !args.flags.replica)
        throw new CliError('usage', '请同时提供 --workspace 和 --replica。');
      const found = (
        await listTargets(http, (roots) => this.state.assertOutsideProjects(roots))
      ).filter(
        (t) =>
          t.target.catalogWorkspaceId === args.flags.workspace &&
          t.target.replicaId === args.flags.replica,
      );
      if (found.length !== 1) throw new CliError('target', '未找到明确可用的项目副本。', 5);
      target = found[0]!.target;
    } else {
      if (!saved) throw new CliError('target', '请先使用 targets use 明确选择项目副本。', 5);
      target = saved;
    }
    const session =
      args.flags.session ??
      (args.group === 'session' ? args.positional : undefined) ??
      target.sessionId;
    target = { ...target, ...(session ? { sessionId: id.parse(session) } : {}) };
    if (withSession && !target.sessionId)
      throw new CliError('session', '请指定已有会话编号，或先创建会话。', 5);
    const resolved = await resolveTarget(http, target, (roots) =>
      this.state.assertOutsideProjects(roots),
    );
    if (http.options.local && resolved.rootPath)
      this.state.assertOutsideProjects([resolved.rootPath]);
    return resolved;
  }
  async read(http: NodeHttp, target: CliTarget) {
    return readClientSession(
      await http.json(
        replicaBase(target) + '/sessions/' + id.parse(target.sessionId),
        undefined,
        SESSION_RESPONSE_LIMITS.readBytes,
      ),
      scope(target),
    );
  }
  stage(
    target: CliTarget,
    kind: CliOperation['kind'],
    path: string,
    request: { operationId: string },
  ) {
    if (this.deps.signal?.aborted) throw new CliError('interrupted', '操作已中断，未派发。', 130);
    return this.state.stage(
      {
        operationId: request.operationId,
        kind,
        target: { ...target, sessionId: id.parse(target.sessionId) },
        path,
        body: JSON.stringify(request),
      },
      new Date(this.now()).toISOString(),
    );
  }
  async deliver(http: NodeHttp, op: CliOperation, first = false) {
    if (!['pending', 'ending'].includes(op.state)) return summary(op);
    if (op.state === 'ending')
      throw new CliError(
        'ending',
        '此操作正在结束核查，请使用 operation abandon 沿用原请求。',
        6,
        op.operationId,
      );
    try {
      const request = original(op);
      if (
        request.value.operationId !== op.operationId ||
        request.value.workspaceId !== op.target.workspaceId ||
        request.value.sessionId !== op.target.sessionId ||
        ('localProjectId' in request.value &&
          request.value.localProjectId !== op.target.localProjectId) ||
        ('userId' in request.value &&
          (request.value.userId !== op.target.userId ||
            request.value.machineId !== op.target.machineId))
      )
        throw new CliError(
          'corrupt-outbox',
          '原操作与完整执行范围不匹配；未发送。',
          5,
          op.operationId,
        );
      const mapped = await resolveTarget(http, op.target, (roots) =>
        this.state.assertOutsideProjects(roots),
      );
      if (http.options.local && mapped.rootPath)
        this.state.assertOutsideProjects([mapped.rootPath]);
      if (request.kind === 'send-turn' || request.kind === 'respond-permission')
        requireFeature(mapped, SESSION_INTENTS_FEATURE);
      http = new NodeHttp(http.connection, {
        ...http.options,
        current: () => {
          this.state.assertCurrent();
          const saved = this.state.operation(op.operationId);
          if (
            !saved ||
            saved.state !== 'pending' ||
            saved.requestVersion !== op.requestVersion ||
            saved.body !== op.body
          )
            throw new CliError(
              'operation-conflict',
              '原操作已被另一个 CLI 更新；请先核查。',
              6,
              op.operationId,
            );
        },
      });
      const confirmation = await deliverOriginalOperation(scope(op.target), request, {
        dispatch: async (method) =>
          (
            await http.request(
              replicaBase(mapped.target) + '/' + hostCommandContracts[method].http.path,
              op.body,
              64 * 1024,
            )
          ).value,
      });
      if (confirmation.status === 'pending') {
        await persistOriginalConfirmation(
          op.operationId,
          'pending',
          () => this.state.assertCurrent(),
          () => this.state.transition(op.operationId, ['pending'], 'pending', confirmation.receipt),
        );
        throw new CliError(
          'unknown',
          '停止已登记，尚未确认结束；请手动核查原操作。',
          6,
          op.operationId,
        );
      }
      const state = confirmation.status === 'abandoned' ? 'abandoned' : 'accepted';
      const saved = await persistOriginalConfirmation(
        op.operationId,
        confirmation.status,
        () => this.state.assertCurrent(),
        () => this.state.transition(op.operationId, ['pending'], state, confirmation.receipt),
      );
      if (confirmation.interrupted)
        throw new CliError(
          'interrupted-turn',
          '原回合已因主机重启或中断结束，未确认正常停止。',
          5,
          op.operationId,
        );
      return summary(saved);
    } catch (error) {
      if (isRequestRejected(error) && first) {
        this.state.transition(op.operationId, ['pending'], 'rejected');
        throw new CliError(
          error.status === 410 ? 'retired' : 'rejected',
          error.status === 410
            ? RETIRED_SESSION_FEATURE
            : '主机明确拒绝了本次新操作；原记录已保留。',
          5,
          op.operationId,
        );
      }
      if (error instanceof RequestFailure && error.status === 410)
        throw new CliError(
          'retired',
          '此功能已退场；旧原操作状态保持不变，请核查已保存的记录。',
          6,
          op.operationId,
        );
      if (error instanceof ConfirmationPersistenceFailure)
        throw new CliError('local-persistence', error.message, 6, op.operationId);
      if (error instanceof CliError && error.operationId) throw error;
      throw new CliError(
        'unknown',
        '原请求结果尚未确认；请使用 operation inspect、retry 或 abandon，不会自动重发。',
        6,
        op.operationId,
      );
    }
  }
  async recover(http: NodeHttp, op: CliOperation, action: 'inspect' | 'abandon') {
    if (action === 'abandon' && !['pending', 'ending'].includes(op.state)) return summary(op);
    if (action === 'abandon' && op.state === 'pending')
      op = this.state.transition(op.operationId, ['pending'], 'ending');
    const mapped = await resolveTarget(http, op.target, (roots) =>
      this.state.assertOutsideProjects(roots),
    );
    if (http.options.local && mapped.rootPath) this.state.assertOutsideProjects([mapped.rootPath]);
    const request = sessionOperationSchema.parse({
      ...scope(op.target),
      action,
      request: original(op),
    });
    try {
      const result = await recoverOriginalOperation(scope(op.target), request.request, action, {
        dispatch: (_method, input) =>
          http.json(replicaBase(mapped.target) + '/session-operations', input, 4096),
      });
      if (
        result.found &&
        ['accepted', 'abandoned', 'interrupted'].includes(result.receipt.status)
      ) {
        const state = result.receipt.status === 'abandoned' ? 'abandoned' : 'accepted';
        if (['pending', 'ending'].includes(op.state))
          op = this.state.transition(op.operationId, ['pending', 'ending'], state, result.receipt);
      }
      return { ...summary(op), inspection: result };
    } catch {
      throw new CliError(
        'unknown',
        '原操作核查尚未确认；原请求和结束意图已保留。',
        6,
        op.operationId,
      );
    }
  }
  async wait(http: NodeHttp, target: CliTarget, args: CliArgs, turnId?: string) {
    const duration = Number(args.flags.timeout ?? 60000),
      deadline = this.now() + duration,
      ending = (this.deps.deadline ?? AbortSignal.timeout)(duration);
    http = new NodeHttp(http.connection, {
      ...http.options,
      signal: AbortSignal.any([ending, ...(http.options.signal ? [http.options.signal] : [])]),
    });
    try {
      let previous = '';
      let expected = turnId,
        anchored = turnId !== undefined;
      while (true) {
        if (this.deps.signal?.aborted)
          throw new CliError('interrupted', '等待已结束，未发送停止操作。', 130);
        const mapped = await resolveTarget(http, target, (roots) =>
            this.state.assertOutsideProjects(roots),
          ),
          read = await this.read(http, mapped.target);
        if (read.persisted === false)
          throw new CliError(
            'not-persisted',
            '主机尚未持久保存结果；等待结束，不表示停止 Agent。',
            4,
          );
        const version = JSON.stringify(read.history);
        if (args.flags.follow && version !== previous) {
          this.deps.event?.({
            event: 'session',
            sessionId: target.sessionId,
            meta: read.meta,
            history: read.history,
          });
          previous = version;
        }
        if (!anchored) {
          expected = read.meta.latestUserMsgId;
          anchored = true;
        }
        const assistant = read.history.find(
          (t) => t.role === 'assistant' && t.userTurnId === expected,
        );
        if (!expected || assistant?.finished)
          return { meta: read.meta, history: read.history, waited: true };
        if (this.now() >= deadline)
          throw new CliError('wait-timeout', '等待超时，Agent 可能仍在运行；未发送停止操作。', 7);
        await (this.deps.pause ?? waitPause)(
          Math.min(1000, deadline - this.now()),
          this.deps.signal,
        );
      }
    } catch (error) {
      if (this.deps.signal?.aborted)
        throw new CliError('interrupted', '等待已结束，未发送停止操作。', 130);
      if (ending.aborted || this.now() >= deadline)
        throw new CliError('wait-timeout', '等待超时，Agent 可能仍在运行；未发送停止操作。', 7);
      throw error;
    }
  }
  async run(args: CliArgs): Promise<unknown> {
    if (args.group === 'retired') {
      if (args.command === 'list') return this.state.retiredSummaries();
      return exportRetiredOperation(this.state, args.positional!, String(args.flags.output), () => {
        if (this.deps.signal?.aborted) throw new CliError('interrupted', '离线导出已中断。', 130);
        this.state.assertCurrent();
      });
    }
    const authRevision = args.group === 'auth' ? this.state.settingsRevision() : undefined;
    const authCurrent = () => {
      if (this.deps.signal?.aborted || this.state.settingsRevision() !== authRevision)
        throw new CliError(
          'authentication-conflict',
          '登录状态已改变；请核对当前账号后手动继续。',
          3,
        );
    };
    if (args.group === 'auth' && args.command.startsWith('google-')) {
      const google = new CliGoogleAuth(this.deps);
      switch (args.command) {
        case 'google-start':
          return google.begin({ origin: String(args.flags.server) });
        case 'google-review':
          return google.review();
        case 'google-cancel':
          return google.cancel();
        case 'google-confirm': {
          let confirmation;
          try {
            if (!args.flags.stdin || args.flags.file) throw new Error();
            confirmation = googleConfirmationSchema.parse(
              JSON.parse((await cliInput(args, this.deps.stdin, 4096))!),
            );
          } catch {
            throw new CliError('google-input', '确认输入必须是包含核对邮箱和代码的有效 JSON。');
          }
          authCurrent();
          return google.finish(confirmation);
        }
      }
    }
    if (args.group === 'auth' && args.command === 'login') {
      if (args.flags.connection) {
        const initial = await this.http(args);
        authCurrent();
        const http = new NodeHttp(initial.connection, { ...initial.options, current: authCurrent });
        await http.identity();
        authCurrent();
        this.state.compareAndSetSettings(authRevision!, {
          auth: { kind: 'local', file: String(args.flags.connection) },
        });
        return { authenticated: true, kind: 'local', owner: http.owner, server: http.origin };
      }
      if (!args.flags.server) throw new CliError('usage', '远程登录需要明确 --server。');
      const origin = serverOrigin(String(args.flags.server));
      let credentials;
      try {
        credentials = loginSchema.parse(JSON.parse((await cliInput(args, this.deps.stdin, 4096))!));
      } catch {
        throw new CliError('login-input', '登录输入必须包含 email 和 password，且使用有效 JSON。');
      }
      authCurrent();
      const initial = new NodeHttp(
          { origin },
          {
            fetch: this.deps.fetch,
            signal: this.deps.signal,
            deadline: this.deps.deadline,
            current: authCurrent,
          },
        ),
        response = await initial.request('/api/login', JSON.stringify(credentials), 4096),
        cookie = response.headers
          .getSetCookie()
          .map((value) => value.split(';')[0]!)
          .find((value) => value.startsWith('personal='));
      if (!cookie) throw new CliError('authentication', '服务器没有返回可验证的登录凭据。', 3);
      const connection = connectionSchema.parse({
        origin,
        cookie,
        owner: await new NodeHttp(
          { origin, cookie },
          {
            fetch: this.deps.fetch,
            signal: this.deps.signal,
            deadline: this.deps.deadline,
            current: authCurrent,
          },
        ).identity(),
      });
      authCurrent();
      this.state.compareAndSetSettings(authRevision!, { auth: { kind: 'remote', connection } });
      return { authenticated: true, kind: 'remote', owner: connection.owner, server: origin };
    }
    if (args.group === 'config') {
      const auth = authSchema.optional().parse(this.state.get('auth'));
      return {
        stateDirectory: this.state.directory,
        connection:
          auth?.kind === 'remote'
            ? { kind: 'remote', server: auth.connection.origin, owner: auth.connection.owner }
            : auth
              ? { kind: 'local', file: auth.file }
              : null,
        target: this.state.target() ?? null,
      };
    }
    if (args.group === 'operation' && args.command === 'list')
      return this.state.operationSummaries();
    if (
      args.group === 'auth' &&
      args.command === 'logout' &&
      (args.flags.connection ||
        authSchema.optional().parse(this.state.get('auth'))?.kind === 'local')
    ) {
      authCurrent();
      this.state.compareAndSetSettings(authRevision!, { auth: undefined, target: undefined });
      return { authenticated: false, kind: 'local', hostConnectionRetained: true };
    }
    let http = await this.http(args);
    if (args.group === 'auth') {
      authCurrent();
      http = new NodeHttp(http.connection, { ...http.options, current: authCurrent });
      if (args.command === 'status')
        return {
          authenticated: true,
          owner: await http.identity(),
          server: http.origin,
          kind: http.options.local ? 'local' : 'remote',
        };
      try {
        await http.json(
          '/api/logout?expectedAccount=' + encodeURIComponent(id.parse(http.owner)),
          {},
        );
      } finally {
        authCurrent();
        this.state.compareAndSetSettings(authRevision!, { auth: undefined, target: undefined });
      }
      return { authenticated: false };
    }
    if (args.group === 'targets') {
      const targets = await listTargets(http, (roots) => this.state.assertOutsideProjects(roots));
      if (args.command === 'list') return { targets };
      if (!args.flags.workspace || !args.flags.replica)
        throw new CliError('usage', 'targets use 需要明确 --workspace 和 --replica。');
      const found = targets.filter(
        (t) =>
          t.target.catalogWorkspaceId === args.flags.workspace &&
          t.target.replicaId === args.flags.replica,
      );
      if (found.length !== 1) throw new CliError('target', '没有找到指定副本。', 5);
      const target = {
        ...found[0]!.target,
        ...(args.flags.session ? { sessionId: id.parse(args.flags.session) } : {}),
      };
      this.state.setTarget(target);
      return { target };
    }
    if (args.group === 'operation') {
      const op = this.state.operation(id.parse(args.positional));
      if (!op) throw new CliError('operation', '未找到原操作记录。', 5);
      return args.command === 'retry'
        ? this.deliver(http, op)
        : this.recover(http, op, args.command as 'inspect' | 'abandon');
    }
    const resolved = await this.target(http, args, !['create', 'list'].includes(args.command));
    let target = resolved.target;
    if (args.command === 'list') {
      const sessions = sessionListSchema.parse(
        await http.json(
          replicaBase(target) + '/sessions',
          undefined,
          SESSION_RESPONSE_LIMITS.listBytes,
        ),
      );
      if (
        sessions.some(
          (s) =>
            s.userId !== target.userId ||
            s.machineId !== target.machineId ||
            s.project.localProjectId !== target.localProjectId,
        )
      )
        throw new CliError('scope', '会话列表包含其他执行范围。', 5);
      return { target, sessions };
    }
    if (args.command === 'create') {
      requireFeature(resolved, SESSION_CONTROL_FEATURE);
      const agent = id.parse(args.flags.agent);
      if (!resolved.agents.some((a) => a.id === agent))
        throw new CliError('agent', '请选择此执行电脑当前可用的 Agent 版本。', 5);
      const title = await cliInput(args, this.deps.stdin, 800, false);
      target = {
        ...target,
        sessionId: args.flags.session ? id.parse(args.flags.session) : this.uuid(),
      };
      const action = sessionControlActionSchema.parse({
        ...scope(target),
        operationId: this.uuid(),
        action: 'create',
        agentId: agent,
        ...(title?.trim() ? { title: title.trim() } : {}),
      });
      const op = this.stage(target, 'create', replicaBase(target) + '/session-control', action);
      this.state.setTarget(target);
      return this.deliver(http, op, true);
    }
    if (args.command === 'read' && (args.flags.follow || args.flags.wait))
      return this.wait(http, target, args);
    const read = await this.read(http, target);
    if (args.command === 'read') return { target, ...read };
    const readMcp = async () => {
      requireFeature(resolved, RETIRED_RECORDS_FEATURE);
      const request = mcpReadSchema.parse({
        mcpVersion: 1,
        workspaceId: target.workspaceId,
        localProjectId: target.localProjectId,
        sessionId: target.sessionId,
      });
      return validateMcpRead(
        await http.json(replicaBase(target) + '/mcp/read', request, MCP_LIMITS.responseBytes),
        request,
      );
    };
    if (args.command === 'mcp') return { target, ...(await readMcp()) };
    if (args.command === 'send') {
      requireFeature(resolved, SESSION_CONTROL_FEATURE);
      requireFeature(resolved, SESSION_INTENTS_FEATURE);
      if (args.flags.agent && args.flags.agent !== read.meta.agentConfigId)
        throw new CliError('agent', '已有会话的 Agent 版本固定；请选择新的会话。', 5);
      const agent =
        read.agent ??
        (!resolved.features.includes(AGENT_VERSIONS_FEATURE)
          ? resolved.agents.find((a) => a.id === read.meta.agentConfigId)
          : undefined);
      if (!agent) throw new CliError('agent', '主机未提供此会话的固定 Agent 版本；未发送。', 5);
      const turnId = this.uuid(),
        request = buildSendTurn({
          scope: scope(target),
          read,
          agent: agentSchema.parse(agent),
          prompt: (await cliInput(args, this.deps.stdin))!,
          selection: {
            ...(args.flags.model ? { modelId: String(args.flags.model) } : {}),
            ...(args.flags.effort ? { reasoningEffort: String(args.flags.effort) } : {}),
            ...(args.flags.mode ? { modeId: String(args.flags.mode) } : {}),
          },
          operationId: this.uuid(),
          turnId,
        });
      const op = this.stage(target, 'send-turn', replicaBase(target) + '/send-turn', request),
        confirmation = await this.deliver(http, op, true);
      return args.flags.wait || args.flags.follow
        ? { operation: confirmation, result: await this.wait(http, target, args, turnId) }
        : confirmation;
    }
    if (args.command === 'stop') {
      requireFeature(resolved, SESSION_CONTROL_FEATURE);
      const active = read.history.find((t) => t.role === 'assistant' && !t.finished),
        turnId = id.parse(args.flags.turn ?? active?.id);
      if (!active || active.id !== turnId)
        throw new CliError('turn', '未找到匹配的活动回合；请重新读取。', 5);
      const request = sessionControlActionSchema.parse({
          ...scope(target),
          operationId: this.uuid(),
          action: 'stop',
          turnId,
        }),
        op = this.stage(target, 'stop', replicaBase(target) + '/session-control', request);
      let confirmation: unknown;
      try {
        confirmation = await this.deliver(http, op, true);
      } catch (error) {
        const saved = this.state.operation(op.operationId)!;
        if (
          !(args.flags.wait || args.flags.follow) ||
          (error instanceof CliError && error.code !== 'unknown') ||
          (saved.receipt as { status?: string } | undefined)?.status !== 'stopping'
        )
          throw error;
        confirmation = summary(saved);
      }
      if (args.flags.wait || args.flags.follow) {
        const result = await this.wait(http, target, args, active.userTurnId);
        return {
          operation: await this.recover(http, this.state.operation(op.operationId)!, 'inspect'),
          result,
        };
      }
      return confirmation;
    }
    requireFeature(resolved, 'session-actions');
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
    return this.deliver(
      http,
      this.stage(target, 'session-action', replicaBase(target) + '/session-actions', request),
      true,
    );
  }
}
