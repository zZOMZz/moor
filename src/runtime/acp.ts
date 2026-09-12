import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import * as nodeModule from 'node:module';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type CreateElicitationResponse,
} from '@agentclientprotocol/sdk';
import { capabilities } from './capabilities';
import type { AgentDriver, AgentMcpServer, AgentRunBinding, AgentSteerResult } from './agent';
import { resolveRunSelection, selectionFromInput } from '../run-config';
import { promptContent } from './attachment-input';
import { AppError, assert } from '../protocol';
import { CONTENT_LIMITS, isCanonicalBase64 } from '../content-protocol';
import {
  forkCapabilities,
  ForkAnchorObservation,
  forkResult,
  nativeForkRequest,
  validateForkInput,
} from './agent-fork';
import { steerRequestSchema } from '../interaction-protocol';
import { bridgeElicitation, claudeSteerParams } from './elicitation';
import {
  applySessionEvent,
  normalizePromptUsage,
  normalizeSessionEvent,
  runtimeFeatureReport,
  type SessionEvent,
  type SessionEventState,
  type SessionEventSource,
} from './session-events';
const agentRequire = nodeModule.createRequire(import.meta.url);
const steerInputSchema = steerRequestSchema.pick({ expectedTurnId: true, prompt: true }).strict();
const runBindingSchema = steerRequestSchema.omit({ operationId: true, prompt: true }).strict();
export const MCP_UNSUPPORTED_TRANSPORT = '此 Agent 未报告支持所选 MCP 传输，请更换配置或 Agent';
export const MCP_AUTHORIZATION_EXPIRED = 'MCP 会话授权已失效，未继续执行';
const MCP_INVALID_CONFIGURATION = '本机 MCP 配置不可验证，请重新检查并授权';
const mcpName = z.string().regex(/^moor_mcp_mcpv_[a-f0-9]{32}$/);
const mcpText = z
  .string()
  .max(8192)
  .refine((value) => !value.includes('\0'));
const mcpEnvironment = z
  .object({
    name: z
      .string()
      .max(100)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    value: mcpText,
  })
  .strict();
const mcpHeader = z
  .object({
    name: z
      .string()
      .max(100)
      .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
    value: mcpText.refine((value) => !/[\r\n]/.test(value)),
  })
  .strict();
const mcpServerSchema = z.union([
  z
    .object({
      name: mcpName,
      command: z
        .string()
        .min(1)
        .max(4096)
        .refine((value) => isAbsolute(value) && !value.includes('\0')),
      args: z
        .array(
          z
            .string()
            .max(4096)
            .refine((value) => !value.includes('\0')),
        )
        .max(128),
      env: z
        .array(mcpEnvironment)
        .max(32)
        .refine((values) => new Set(values.map((value) => value.name)).size === values.length),
    })
    .strict(),
  z
    .object({
      type: z.enum(['http', 'sse']),
      name: mcpName,
      url: z
        .string()
        .min(1)
        .max(4096)
        .url()
        .refine((value) => {
          const url = new URL(value);
          return (
            ['http:', 'https:'].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.hash
          );
        }),
      headers: z
        .array(mcpHeader)
        .max(32)
        .refine(
          (values) =>
            new Set(values.map((value) => value.name.toLowerCase())).size === values.length,
        ),
    })
    .strict(),
]);
const launchAcp = (command: string, args: string[], options: SpawnOptionsWithoutStdio) =>
  spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
// Injection changes only the owned child process. Protocol handling remains real.
export function createAcpDriver(launch = launchAcp): AgentDriver {
  const driver: AgentDriver = {
    async fork(config, input) {
      validateForkInput(config, input);
      let source;
      try {
        source = await driver.open(config, input.sourceCwd, input.sourceNativeId, {
          update: () => {},
          permission: async () => ({ outcome: { outcome: 'cancelled' } }),
        });
      } catch {
        throw new AppError(409, '原生 Fork 尚未执行，无法读取来源 Agent 会话', true);
      }
      try {
        if (!source.fork) throw new AppError(409, '此 Agent 不支持原生会话 Fork', true);
        return await source.fork(input);
      } finally {
        // A confirmed fork response remains confirmed even if process cleanup
        // subsequently fails; retrying creation could duplicate the native fork.
        await Promise.resolve()
          .then(() => source.close())
          .catch(() => {});
      }
    },
    async open(config, cwd, nativeId, callbacks, options) {
      const taskTools = options?.taskTools;
      const mcp = options?.mcp;
      let extraServers: AgentMcpServer[] = [];
      if (mcp) {
        const parsed = z.array(mcpServerSchema).max(8).safeParse(mcp.servers);
        assert(
          parsed.success &&
            new Set(parsed.data.map((server) => server.name)).size === parsed.data.length &&
            Buffer.byteLength(JSON.stringify(parsed.data)) <= 512 * 1024 &&
            Array.isArray(mcp.redact) &&
            mcp.redact.length <= 4096 &&
            mcp.redact.every((value) => typeof value === 'string' && value.length <= 8192) &&
            Buffer.byteLength(JSON.stringify(mcp.redact)) <= 1024 * 1024 &&
            typeof mcp.assertCurrent === 'function',
          400,
          MCP_INVALID_CONFIGURATION,
        );
        extraServers = parsed.data;
      }
      let eventSource: SessionEventSource | undefined;
      let cleanTaskValue = <T>(value: T): T => value;
      if (taskTools || mcp) {
        // Native adapters can include MCP connection diagnostics in updates or
        // errors. The ephemeral endpoint and bearer must stay outside Moor's
        // shared documents even when the adapter echoes them back.
        const privateStrings = new Set<string>(
          [
            ...(taskTools ? [taskTools.token, taskTools.url] : []),
            ...(mcp?.redact ?? []),
            ...extraServers.flatMap((server) =>
              'type' in server
                ? [server.url, ...server.headers.map((entry) => entry.value)]
                : [server.command, ...server.args, ...server.env.map((entry) => entry.value)],
            ),
          ]
            .filter(Boolean)
            .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]),
        );
        const pattern = [...privateStrings]
          .sort((a, b) => b.length - a.length)
          .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|');
        const privatePattern = pattern ? new RegExp(pattern, 'g') : undefined;
        const privateBytes = [...privateStrings].map((value) => Buffer.from(value, 'utf8'));
        const encodedLimit = 4 * Math.ceil(CONTENT_LIMITS.attachmentBytes / 3);
        const clean = <T>(value: T): T => {
          if (typeof value === 'string')
            return (
              privatePattern ? value.replace(privatePattern, '[已隐藏 MCP 配置]') : value
            ) as T;
          if (Array.isArray(value)) return value.map(clean) as T;
          if (value && typeof value === 'object') {
            const block = value as Record<string, any>;
            const encoded =
              block.type === 'resource'
                ? block.resource?.blob
                : ['image', 'audio'].includes(block.type)
                  ? block.data
                  : undefined;
            if (typeof encoded === 'string') {
              // Host attachment normalization decodes exactly this embedded
              // base64 layer. Inspect bounded bytes before that persistence
              // boundary; a binary artifact must never be partially rewritten.
              if (encoded.length > encodedLimit || !isCanonicalBase64(encoded))
                return { type: 'text', text: '[Agent 附件无法安全检查，未保存]' } as T;
              const bytes = Buffer.from(encoded, 'base64');
              if (
                privateBytes.some((secret) => bytes.includes(secret)) ||
                clean(encoded) !== encoded
              )
                return { type: 'text', text: '[Agent 附件包含 MCP 私有配置，未保存]' } as T;
            }
            return Object.fromEntries(
              Object.entries(value).map(([key, item]) => [clean(key), clean(item)]),
            ) as T;
          }
          return value;
        };
        cleanTaskValue = clean;
        const original = callbacks;
        callbacks = {
          ...original,
          update: (value) => original.update(clean(value)),
          permission: (value) => {
            const safe = clean(value);
            // Rewritten choice identifiers would approve a different request.
            if (
              JSON.stringify(value.options?.map((entry: any) => entry.optionId)) !==
              JSON.stringify(safe.options?.map((entry: any) => entry.optionId))
            )
              return Promise.resolve({ outcome: { outcome: 'cancelled' as const } });
            return original.permission(safe);
          },
          ...(original.event
            ? { event: (event, binding) => original.event!(clean(event), binding) }
            : {}),
          ...(original.forkAnchor
            ? {
                forkAnchor: (anchor, binding) => {
                  if (JSON.stringify(clean(anchor)) === JSON.stringify(anchor))
                    original.forkAnchor!(anchor, binding);
                },
              }
            : {}),
          ...(original.question
            ? {
                question: (request) => {
                  const safe = clean(request);
                  const identity = (value: typeof request) => ({
                    ...Object.fromEntries(
                      [
                        'workspaceId',
                        'localProjectId',
                        'sessionId',
                        'expectedTurnId',
                        'requestId',
                      ].map((key) => [key, (value as any)[key]]),
                    ),
                    fields: value.fields.map((field) => ({
                      id: field.id,
                      kind: field.kind,
                      ...('options' in field
                        ? { options: field.options.map((option) => option.value) }
                        : {}),
                    })),
                  });
                  if (JSON.stringify(identity(safe)) !== JSON.stringify(identity(request)))
                    return Promise.resolve({
                      interactionVersion: request.interactionVersion,
                      workspaceId: request.workspaceId,
                      localProjectId: request.localProjectId,
                      sessionId: request.sessionId,
                      expectedTurnId: request.expectedTurnId,
                      requestId: request.requestId,
                      operationId: randomUUID(),
                      answer: { action: 'cancel' as const },
                    });
                  return original.question!(safe);
                },
              }
            : {}),
        };
      }
      const currentTaskTools = () => {
        if (mcp) {
          try {
            mcp.assertCurrent();
          } catch {
            throw new AppError(409, MCP_AUTHORIZATION_EXPIRED);
          }
        }
        if (!taskTools) return;
        try {
          taskTools.assertCurrent();
        } catch {
          throw new AppError(409, '多 Agent 任务授权已失效，未继续执行');
        }
      };
      const safeError = (error: unknown, message: string): unknown => {
        if (!mcp) return error;
        if (
          error instanceof AppError &&
          [
            MCP_AUTHORIZATION_EXPIRED,
            MCP_UNSUPPORTED_TRANSPORT,
            MCP_INVALID_CONFIGURATION,
            '此 Agent 不支持 HTTP MCP，无法执行已授权的多 Agent 任务',
            '多 Agent 任务授权已失效，未继续执行',
            '多 Agent 任务授权已失效，未派发父回合',
          ].includes(error.message)
        )
          return error;
        return new AppError(502, message);
      };
      currentTaskTools();
      let taskServers: Array<{
        type: 'http';
        name: string;
        url: string;
        headers: Array<{ name: string; value: string }>;
      }> = [];
      if (taskTools) {
        let url: URL;
        try {
          url = new URL(taskTools.url);
        } catch {
          throw new AppError(400, '本机任务工具连接无效');
        }
        assert(
          url.protocol === 'http:' &&
            url.hostname === '127.0.0.1' &&
            Number(url.port) > 0 &&
            url.pathname === '/mcp' &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.href === taskTools.url &&
            /^[A-Za-z0-9_-]{43}$/.test(taskTools.token) &&
            Buffer.from(taskTools.token, 'base64url').toString('base64url') === taskTools.token,
          400,
          '本机任务工具连接无效',
        );
        taskServers = [
          {
            type: 'http',
            name: 'moor_tasks',
            url: url.href,
            headers: [{ name: 'Authorization', value: 'Bearer ' + taskTools.token }],
          },
        ];
      }
      const custom = config.customAcp;
      if (custom && !isAbsolute(custom.command)) throw new Error('ACP 启动程序必须为本机绝对路径');
      const entry =
        config.agentType === 'codex'
          ? '@agentclientprotocol/codex-acp'
          : config.agentType === 'claude'
            ? '@agentclientprotocol/claude-agent-acp/dist/index.js'
            : undefined;
      if (!custom && !entry) throw new Error('不支持的 Agent');
      let child: ReturnType<typeof launch>;
      try {
        child = launch(
          custom?.command ?? process.execPath,
          custom?.args ?? [agentRequire.resolve(entry!)],
          {
            cwd,
            env: {
              // The host-selected cwd owns Git routing for both new and loaded
              // sessions. Shell-inherited Git overrides must not redirect it.
              ...Object.fromEntries(
                Object.entries(process.env).filter(
                  ([key]) => !key.toUpperCase().startsWith('GIT_'),
                ),
              ),
              ...(config.runtimeOverrides?.codexPath
                ? { CODEX_PATH: config.runtimeOverrides.codexPath }
                : {}),
              // Codex ACP 1.11.0 otherwise drops explicitly supplied names that
              // also exist in native settings. The switch only selects the supplied
              // descriptor; it does not alter approval or sandbox policy.
              ...(!custom && config.agentType === 'codex' && (extraServers.length || taskTools)
                ? { DISABLE_MCP_CONFIG_FILTERING: 'true' }
                : {}),
            },
            windowsHide: true,
            detached: process.platform !== 'win32',
          },
        );
      } catch (error) {
        throw safeError(error, '无法启动使用 MCP 的 Agent，请检查本机配置');
      }
      child.stderr.resume(); // Raw logs may contain credentials; only protocol errors reach the UI.
      let stopped = false,
        acceptingUpdates = false,
        activeSessionId: string | undefined;
      type Run = {
        binding?: AgentRunBinding;
        cancelled: boolean;
        questions: Map<string, () => void>;
        forkAnchor: ForkAnchorObservation;
      };
      let activeRun: Run | undefined,
        steeringPending = false,
        forking = false,
        eventState: SessionEventState | undefined,
        observedQuestion = false;
      const startupCommands = new Map<string, SessionEvent>();
      const cancelQuestions = (run?: Run) => {
        for (const cancel of run?.questions.values() ?? []) cancel();
        run?.questions.clear();
      };
      const observe = (event: SessionEvent, run?: Run) => {
        eventState = applySessionEvent(eventState, event);
        if (run?.binding) callbacks.event?.(event, { ...run.binding });
      };
      let forceStop: ReturnType<typeof setTimeout> | undefined;
      const ended = new Promise<void>((resolve) =>
        child.once('close', () => {
          clearTimeout(forceStop);
          resolve();
        }),
      );
      const killOwnedProcess = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // Some application sandboxes deny process-group signals while permitting
          // the direct child handle. Do not target any process outside this launch.
          if (code === 'EPERM' || code === 'EACCES') child.kill(signal);
          else if (code !== 'ESRCH') throw error;
        }
      };
      const close = () => {
        if (!stopped) {
          stopped = true;
          acceptingUpdates = false;
          if (activeRun) activeRun.cancelled = true;
          cancelQuestions(activeRun);
          child.stdin.destroy();
          killOwnedProcess('SIGTERM');
          if (child.exitCode === null && child.signalCode === null) {
            forceStop = setTimeout(() => killOwnedProcess('SIGKILL'), 3000);
            forceStop.unref();
          }
        }
        return ended;
      };
      const failed = new Promise<never>((_, reject) => {
        child.once('error', () => reject(new Error('无法启动本机 ACP Agent')));
        child.once('exit', () => reject(new Error('本机 ACP Agent 已退出')));
      });
      // Observe process failures even between protocol requests.
      void failed.catch(() => {});
      const currentCallback = () => {
        try {
          currentTaskTools();
          return true;
        } catch {
          void close();
          return false;
        }
      };
      const conn = new ClientSideConnection(
        () => ({
          sessionUpdate: async (value) => {
            if (stopped || !currentCallback()) return;
            const normalized = normalizeSessionEvent(value.update, eventSource);
            if (!activeSessionId) {
              // Session creation can emit command choices before its response. Keep
              // bounded snapshots and bind them only after the actual ID is known.
              if (normalized.status === 'accepted' && normalized.event.kind === 'commands') {
                if (startupCommands.size >= 4 && !startupCommands.has(value.sessionId))
                  startupCommands.delete(startupCommands.keys().next().value!);
                startupCommands.set(value.sessionId, normalized.event);
              }
              return;
            }
            if (value.sessionId !== activeSessionId) return;
            if (!acceptingUpdates || !activeRun || activeRun.cancelled) {
              if (normalized.status === 'accepted' && normalized.event.kind === 'commands')
                observe(normalized.event);
              return;
            }
            activeRun.forkAnchor.observe(value.update);
            if (normalized.status === 'accepted') observe(normalized.event, activeRun);
            else if (
              [
                'user_message_chunk',
                'agent_message_chunk',
                'agent_thought_chunk',
                'tool_call',
                'tool_call_update',
              ].includes(value.update.sessionUpdate)
            )
              callbacks.update(value.update);
          },
          requestPermission: async (value) => {
            const run = activeRun;
            if (
              stopped ||
              !acceptingUpdates ||
              !run ||
              value.sessionId !== activeSessionId ||
              !currentCallback()
            )
              return { outcome: { outcome: 'cancelled' as const } };
            try {
              const response = await callbacks.permission(value);
              return stopped ||
                !acceptingUpdates ||
                run.cancelled ||
                run !== activeRun ||
                !currentCallback()
                ? { outcome: { outcome: 'cancelled' as const } }
                : response;
            } catch (error) {
              if (!currentCallback()) return { outcome: { outcome: 'cancelled' as const } };
              throw safeError(error, 'MCP Agent 的权限请求尚未确认');
            }
          },
          createElicitation: async (value) => {
            const run = activeRun,
              requestId = randomUUID();
            if (!callbacks.question) return { action: 'decline' as const };
            if (!currentCallback()) return { action: 'cancel' as const };
            const binding =
              run?.binding && activeSessionId
                ? { ...run.binding, requestId, nativeSessionId: activeSessionId }
                : undefined;
            let cancel!: () => void;
            const cancelled = new Promise<CreateElicitationResponse>((resolve) => {
              cancel = () => resolve({ action: 'cancel' });
            });
            if (run) run.questions.set(requestId, cancel);
            try {
              return await Promise.race([
                bridgeElicitation(
                  value,
                  () =>
                    !stopped &&
                    acceptingUpdates &&
                    run === activeRun &&
                    !run?.cancelled &&
                    currentCallback()
                      ? binding
                      : undefined,
                  async (question) => {
                    observedQuestion = true;
                    return callbacks.question!(question);
                  },
                ),
                cancelled,
              ]);
            } catch (error) {
              if (!currentCallback()) return { action: 'cancel' as const };
              throw safeError(error, 'MCP Agent 的问题尚未确认');
            } finally {
              run?.questions.delete(requestId);
            }
          },
        }),
        ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        ),
      );
      async function authorized<T>(work: () => Promise<T>): Promise<T> {
        currentTaskTools();
        try {
          const result = await work();
          currentTaskTools();
          return result;
        } catch (error) {
          currentTaskTools();
          throw error;
        }
      }
      async function bounded<T>(work: () => Promise<T>, guard = true): Promise<T> {
        let timer: ReturnType<typeof setTimeout>;
        try {
          const waiting = () =>
            Promise.race([
              work(),
              failed,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  close();
                  reject(new Error('Agent 连接超时，请手动重试'));
                }, 20000);
              }),
            ]);
          return await (guard ? authorized(waiting) : waiting());
        } finally {
          clearTimeout(timer!);
        }
      }
      try {
        const init = await bounded(() =>
          conn.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientInfo: { name: 'Moor', version: '0.2.0' },
            clientCapabilities: {
              ...(callbacks.question ? { elicitation: { form: {} } } : {}),
              plan: {},
            },
          }),
        );
        eventSource = {
          agentType: config.agentType,
          custom: !!config.customAcp,
          ...(init.agentInfo ? { agentInfo: init.agentInfo } : {}),
        };
        currentTaskTools();
        if (
          extraServers.some(
            (server) =>
              'type' in server && init.agentCapabilities?.mcpCapabilities?.[server.type] !== true,
          )
        )
          throw new AppError(409, MCP_UNSUPPORTED_TRANSPORT);
        if (taskTools && init.agentCapabilities?.mcpCapabilities?.http !== true)
          throw new AppError(409, '此 Agent 不支持 HTTP MCP，无法执行已授权的多 Agent 任务');
        if (nativeId && !init.agentCapabilities?.loadSession)
          throw new Error('该 Agent 不支持恢复会话；请创建新会话');
        const response = nativeId
          ? await bounded(() =>
              conn.loadSession({
                sessionId: nativeId,
                cwd,
                mcpServers: [...taskServers, ...extraServers],
              }),
            )
          : await bounded(() =>
              conn.newSession({ cwd, mcpServers: [...taskServers, ...extraServers] }),
            );
        currentTaskTools();
        const id = nativeId ?? (response as { sessionId: string }).sessionId;
        assert(
          typeof id === 'string' && cleanTaskValue(id) === id,
          502,
          'Agent 返回的会话标识无效',
        );
        activeSessionId = id;
        const initialCommands = startupCommands.get(id);
        if (initialCommands) observe(initialCommands);
        startupCommands.clear();
        const choices = capabilities(response);
        const inputCapabilities = {
          image: init.agentCapabilities?.promptCapabilities?.image === true,
          audio: init.agentCapabilities?.promptCapabilities?.audio === true,
          embeddedContext: init.agentCapabilities?.promptCapabilities?.embeddedContext === true,
        };
        const supportedSteer =
          !custom &&
          config.agentType === 'claude' &&
          init.agentInfo?.name === '@agentclientprotocol/claude-agent-acp' &&
          init.agentInfo.version === '0.76.0' &&
          (init._meta?.steering as { supported?: unknown } | undefined)?.supported === true;
        const interactionCapabilities = {
          questions: !!callbacks.question,
          steer: supportedSteer,
          ...(supportedSteer
            ? {}
            : {
                steerUnavailableReason:
                  config.agentType === 'codex'
                    ? '当前 Codex 适配器不能保证追加指令只进入活动回合，请等待当前回合结束后发送'
                    : '该 Agent 尚未验证支持活动回合追加指令',
              }),
        };
        const nativeForkCapabilities = forkCapabilities(config, init);
        return {
          id,
          capabilities: cleanTaskValue(choices),
          inputCapabilities,
          interactionCapabilities,
          forkCapabilities: nativeForkCapabilities,
          get runtimeFeatures() {
            return runtimeFeatureReport(init, eventState, observedQuestion);
          },
          get currentEvents() {
            return cleanTaskValue(eventState);
          },
          close,
          async fork(input) {
            assert(!taskTools && !mcp, 409, '带有 MCP 授权的会话不能直接派生原生 Fork');
            validateForkInput(config, input);
            if (
              stopped ||
              activeRun ||
              steeringPending ||
              forking ||
              input.sourceNativeId !== id ||
              input.sourceCwd !== cwd ||
              !nativeForkCapabilities.sameDirectory ||
              (input.targetCwd !== cwd && !nativeForkCapabilities.worktree) ||
              (input.anchor && !nativeForkCapabilities.turnCutoff)
            )
              throw new AppError(409, '原生 Fork 的来源或能力已失效', true);
            try {
              input.assertCurrent?.();
            } catch {
              throw new AppError(409, '原生 Fork 尚未执行，来源或目标执行目录已失效', true);
            }
            forking = true;
            try {
              // Entering this call is irreversible from Moor's perspective:
              // errors, disconnects and malformed responses may follow a fork.
              const result = forkResult(
                await bounded(() =>
                  conn.unstable_forkSession(
                    nativeForkRequest(input, nativeForkCapabilities.adapter!),
                  ),
                ),
                id,
              );
              if (input.onNativeId)
                await bounded(() => Promise.resolve(input.onNativeId!(result.nativeId)));
              if (
                nativeForkCapabilities.adapter === 'claude-agent-acp' &&
                input.targetCwd !== cwd
              ) {
                // Claude stores the new native transcript under the source cwd.
                // Load only its returned child ID at the target before confirming
                // the full operation. No prompt, replay callbacks or source move.
                input.assertCurrent?.();
                await bounded(() =>
                  conn.loadSession({
                    sessionId: result.nativeId,
                    cwd: input.targetCwd,
                    mcpServers: [],
                  }),
                );
              }
              return result;
            } catch {
              throw new AppError(
                502,
                '原生 Fork 结果尚未确认，请确认原操作；不会再次创建会话',
                false,
              );
            } finally {
              forking = false;
            }
          },
          async prompt(input, binding) {
            currentTaskTools();
            assert(!stopped, 409, 'Agent 已停止');
            assert(!activeRun && !steeringPending, 409, 'Agent 已有活动回合或待确认追加指令');
            assert(!forking, 409, 'Agent 的原生 Fork 尚未确认');
            const content = promptContent(input, inputCapabilities);
            resolveRunSelection(selectionFromInput(input, choices), choices);
            const run: Run = {
              binding: binding ? runBindingSchema.parse(binding) : undefined,
              cancelled: false,
              questions: new Map(),
              forkAnchor: new ForkAnchorObservation(),
            };
            activeRun = run;
            try {
              if (input.modelId)
                await bounded(() =>
                  conn.setSessionConfigOption({
                    sessionId: id,
                    configId:
                      (response as any).configOptions?.find(
                        (o: any) => o.category === 'model' || o.id === 'model',
                      )?.id ?? 'model',
                    value: input.modelId,
                  }),
                );
              currentTaskTools();
              if (input.modeId)
                await bounded(() => conn.setSessionMode({ sessionId: id, modeId: input.modeId }));
              currentTaskTools();
              for (const [configId, value] of Object.entries(input.configOptionValues ?? {})) {
                await bounded(() =>
                  conn.setSessionConfigOption({ sessionId: id, configId, value: String(value) }),
                );
                currentTaskTools();
              }
              currentTaskTools();
              assert(!run.cancelled && !stopped, 409, '回合在发送前已取消');
              if (taskTools) {
                try {
                  taskTools.onPromptDispatch();
                } catch {
                  throw new AppError(409, '多 Agent 任务授权已失效，未派发父回合');
                }
                currentTaskTools();
              }
              acceptingUpdates = true;
              const result = await authorized(() =>
                Promise.race([conn.prompt({ sessionId: id, prompt: content }), failed]),
              );
              if (!stopped && activeRun === run && !run.cancelled) {
                const usage = normalizePromptUsage(result);
                if (usage.status === 'accepted') observe(usage.event, run);
              }
              if (!['end_turn', 'cancelled'].includes(result.stopReason))
                throw new Error('Agent 停止执行：' + result.stopReason);
              if (
                result.stopReason === 'end_turn' &&
                !stopped &&
                !run.cancelled &&
                activeRun === run &&
                run.binding &&
                nativeForkCapabilities.turnCutoff
              ) {
                const anchor = run.forkAnchor.complete(config, id);
                if (anchor) callbacks.forkAnchor?.(anchor, { ...run.binding });
              }
            } catch (error) {
              if (mcp)
                throw safeError(error, 'MCP Agent 回合结果尚未确认，请检查原回合；不会自动重发');
              if (taskTools && !(error instanceof AppError))
                throw new AppError(
                  502,
                  '任务工具 Agent 回合结果未确认，请检查原回合；不会自动重发',
                );
              throw error;
            } finally {
              acceptingUpdates = false;
              cancelQuestions(run);
              if (activeRun === run) activeRun = undefined;
            }
          },
          async steer(input): Promise<AgentSteerResult> {
            currentTaskTools();
            const request = steerInputSchema.parse(input),
              run = activeRun;
            assert(
              supportedSteer,
              409,
              interactionCapabilities.steerUnavailableReason ?? 'Agent 不支持追加指令',
            );
            assert(
              !stopped &&
                acceptingUpdates &&
                run &&
                !run.cancelled &&
                run.binding?.expectedTurnId === request.expectedTurnId,
              409,
              '追加指令的活动回合已失效',
            );
            assert(!steeringPending, 409, '上一条追加指令尚未确认');
            steeringPending = true;
            try {
              const response = await bounded(() =>
                conn.request<Record<string, unknown>>(
                  '_session/steering',
                  claudeSteerParams(id, request.prompt),
                ),
              );
              currentTaskTools();
              if (response.outcome === 'injected') return { outcome: 'injected' };
              if (response.outcome === 'promptRequired' && response.reason === 'noRunningTurn')
                return { outcome: 'promptRequired', reason: 'noRunningTurn' };
              // A violated extension contract cannot be presented as delivery into
              // the requested turn. Stop the owned process to bound unexpected work.
              await close();
              throw new Error('Agent 未确认追加指令进入指定活动回合');
            } catch (error) {
              if (mcp) throw safeError(error, 'MCP Agent 尚未确认追加指令，请检查原回合');
              if (taskTools && !(error instanceof AppError))
                throw new AppError(502, '任务工具 Agent 尚未确认追加指令，请检查原回合');
              throw error;
            } finally {
              steeringPending = false;
            }
          },
          async cancel() {
            acceptingUpdates = false;
            if (activeRun) activeRun.cancelled = true;
            cancelQuestions(activeRun);
            try {
              // Stopping the owned process remains available after revocation.
              await bounded(() => conn.cancel({ sessionId: id }), false);
            } catch (error) {
              if (mcp) throw safeError(error, 'MCP Agent 停止结果尚未确认');
              if (taskTools && !(error instanceof AppError))
                throw new AppError(502, '任务工具 Agent 停止结果尚未确认');
              throw error;
            }
          },
        };
      } catch (error) {
        await close();
        if (mcp) throw safeError(error, '无法连接使用 MCP 的 Agent，请检查本机配置');
        if (taskTools && !(error instanceof AppError))
          throw new AppError(502, '无法连接支持任务工具的 Agent，请检查本机配置');
        throw error;
      }
    },
  };
  return driver;
}
export const acpDriver = createAcpDriver();
