import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import * as nodeModule from 'node:module';
import { isAbsolute } from 'node:path';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type CreateElicitationResponse,
} from '@agentclientprotocol/sdk';
import { capabilities } from './capabilities';
import type { AgentDriver, AgentRunBinding, AgentSteerResult } from './agent';
import { resolveRunSelection, selectionFromInput } from '../run-config';
import { promptContent } from './attachment-input';
import { assert } from '../protocol';
import { steerRequestSchema } from '../interaction-protocol';
import { bridgeElicitation, claudeSteerParams } from './elicitation';
import {
  applySessionEvent,
  normalizePromptUsage,
  normalizeSessionEvent,
  runtimeFeatureReport,
  type SessionEvent,
  type SessionEventState,
} from './session-events';
const agentRequire = nodeModule.createRequire(import.meta.url);
const steerInputSchema = steerRequestSchema.pick({ expectedTurnId: true, prompt: true }).strict();
const runBindingSchema = steerRequestSchema.omit({ operationId: true, prompt: true }).strict();
const launchAcp = (command: string, args: string[], options: SpawnOptionsWithoutStdio) =>
  spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
// Injection changes only the owned child process. Protocol handling remains real.
export function createAcpDriver(launch = launchAcp): AgentDriver {
  return {
    async open(config, cwd, nativeId, callbacks) {
      const custom = config.customAcp;
      if (custom && !isAbsolute(custom.command)) throw new Error('ACP 启动程序必须为本机绝对路径');
      const entry =
        config.agentType === 'codex'
          ? '@agentclientprotocol/codex-acp'
          : config.agentType === 'claude'
            ? '@agentclientprotocol/claude-agent-acp/dist/index.js'
            : undefined;
      if (!custom && !entry) throw new Error('不支持的 Agent');
      const child = launch(
        custom?.command ?? process.execPath,
        custom?.args ?? [agentRequire.resolve(entry!)],
        {
          cwd,
          env: {
            ...process.env,
            ...(config.runtimeOverrides?.codexPath
              ? { CODEX_PATH: config.runtimeOverrides.codexPath }
              : {}),
          },
          windowsHide: true,
          detached: process.platform !== 'win32',
        },
      );
      child.stderr.resume(); // Raw logs may contain credentials; only protocol errors reach the UI.
      let stopped = false,
        acceptingUpdates = false,
        activeSessionId: string | undefined;
      type Run = {
        binding?: AgentRunBinding;
        cancelled: boolean;
        questions: Map<string, () => void>;
      };
      let activeRun: Run | undefined,
        steeringPending = false,
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
      const conn = new ClientSideConnection(
        () => ({
          sessionUpdate: async (value) => {
            if (stopped) return;
            const normalized = normalizeSessionEvent(value.update);
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
            if (stopped || !acceptingUpdates || !run || value.sessionId !== activeSessionId)
              return { outcome: { outcome: 'cancelled' as const } };
            const response = await callbacks.permission(value);
            return stopped || !acceptingUpdates || run.cancelled || run !== activeRun
              ? { outcome: { outcome: 'cancelled' as const } }
              : response;
          },
          createElicitation: async (value) => {
            const run = activeRun,
              requestId = randomUUID();
            if (!callbacks.question) return { action: 'decline' as const };
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
                    !stopped && acceptingUpdates && run === activeRun && !run?.cancelled
                      ? binding
                      : undefined,
                  async (question) => {
                    observedQuestion = true;
                    return callbacks.question!(question);
                  },
                ),
                cancelled,
              ]);
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
      async function bounded<T>(work: Promise<T>): Promise<T> {
        let timer: ReturnType<typeof setTimeout>;
        try {
          return await Promise.race([
            work,
            failed,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                close();
                reject(new Error('Agent 连接超时，请手动重试'));
              }, 20000);
            }),
          ]);
        } finally {
          clearTimeout(timer!);
        }
      }
      try {
        const init = await bounded(
          conn.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientInfo: { name: 'Moor', version: '0.2.0' },
            clientCapabilities: {
              ...(callbacks.question ? { elicitation: { form: {} } } : {}),
              plan: {},
            },
          }),
        );
        if (nativeId && !init.agentCapabilities?.loadSession)
          throw new Error('该 Agent 不支持恢复会话；请创建新会话');
        const response = nativeId
          ? await bounded(conn.loadSession({ sessionId: nativeId, cwd, mcpServers: [] }))
          : await bounded(conn.newSession({ cwd, mcpServers: [] }));
        const id = nativeId ?? (response as { sessionId: string }).sessionId;
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
        return {
          id,
          capabilities: choices,
          inputCapabilities,
          interactionCapabilities,
          get runtimeFeatures() {
            return runtimeFeatureReport(init, eventState, observedQuestion);
          },
          get currentEvents() {
            return eventState;
          },
          close,
          async prompt(input, binding) {
            assert(!stopped, 409, 'Agent 已停止');
            assert(!activeRun && !steeringPending, 409, 'Agent 已有活动回合或待确认追加指令');
            const content = promptContent(input, inputCapabilities);
            resolveRunSelection(selectionFromInput(input, choices), choices);
            const run: Run = {
              binding: binding ? runBindingSchema.parse(binding) : undefined,
              cancelled: false,
              questions: new Map(),
            };
            activeRun = run;
            try {
              if (input.modelId)
                await bounded(
                  conn.setSessionConfigOption({
                    sessionId: id,
                    configId:
                      (response as any).configOptions?.find(
                        (o: any) => o.category === 'model' || o.id === 'model',
                      )?.id ?? 'model',
                    value: input.modelId,
                  }),
                );
              if (input.modeId)
                await bounded(conn.setSessionMode({ sessionId: id, modeId: input.modeId }));
              for (const [configId, value] of Object.entries(input.configOptionValues ?? {}))
                await bounded(
                  conn.setSessionConfigOption({ sessionId: id, configId, value: String(value) }),
                );
              assert(!run.cancelled && !stopped, 409, '回合在发送前已取消');
              acceptingUpdates = true;
              const result = await Promise.race([
                conn.prompt({ sessionId: id, prompt: content }),
                failed,
              ]);
              if (!stopped && activeRun === run && !run.cancelled) {
                const usage = normalizePromptUsage(result);
                if (usage.status === 'accepted') observe(usage.event, run);
              }
              if (!['end_turn', 'cancelled'].includes(result.stopReason))
                throw new Error('Agent 停止执行：' + result.stopReason);
            } finally {
              acceptingUpdates = false;
              cancelQuestions(run);
              if (activeRun === run) activeRun = undefined;
            }
          },
          async steer(input): Promise<AgentSteerResult> {
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
              const response = await bounded(
                conn.request<Record<string, unknown>>(
                  '_session/steering',
                  claudeSteerParams(id, request.prompt),
                ),
              );
              if (response.outcome === 'injected') return { outcome: 'injected' };
              if (response.outcome === 'promptRequired' && response.reason === 'noRunningTurn')
                return { outcome: 'promptRequired', reason: 'noRunningTurn' };
              // A violated extension contract cannot be presented as delivery into
              // the requested turn. Stop the owned process to bound unexpected work.
              await close();
              throw new Error('Agent 未确认追加指令进入指定活动回合');
            } finally {
              steeringPending = false;
            }
          },
          async cancel() {
            acceptingUpdates = false;
            if (activeRun) activeRun.cancelled = true;
            cancelQuestions(activeRun);
            await bounded(conn.cancel({ sessionId: id }));
          },
        };
      } catch (error) {
        await close();
        throw error;
      }
    },
  };
}
export const acpDriver = createAcpDriver();
