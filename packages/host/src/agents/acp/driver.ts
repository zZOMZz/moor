import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import * as nodeModule from 'node:module';
import { isAbsolute } from 'node:path';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type CreateElicitationResponse,
} from '@agentclientprotocol/sdk';
import { AcpConfiguration } from '../capabilities';
import { agentAdapterEntry, inspectAgentProgram } from '../program';
import { identifyAgentModelFailure } from '@moor/protocol/agent-errors';
import { LOCAL_CODEX_NOT_INSTALLED, type AgentDriver, type AgentRunBinding } from '../driver';
import { canonicalMode, resolveRunSelection, selectionFromInput } from '@moor/protocol/run-config';
import {
  agentUsageUpdateSchema,
  MOOR_USAGE_READ,
  MOOR_USAGE_UPDATED,
} from '@moor/protocol/agent-usage';
import { readAcpUsage, supportsUsage } from './usage';
import { promptContent } from '../../sessions/attachment-input';
import { AppError, assert } from '@moor/protocol/protocol';
import {
  forkCapabilities,
  ForkAnchorObservation,
  forkResult,
  nativeForkRequest,
  validateForkInput,
} from '../fork';
import { steerRequestSchema } from '@moor/protocol/interaction-protocol';
import { bridgeElicitation } from '../../sessions/elicitation';
import {
  applySessionEvent,
  normalizePromptUsage,
  normalizeSessionEvent,
  runtimeFeatureReport,
  type SessionEvent,
  type SessionEventState,
} from '../../sessions/events';
const agentRequire = nodeModule.createRequire(import.meta.url);
const runBindingSchema = steerRequestSchema.omit({ operationId: true, prompt: true }).strict();
const launchAcp = (command: string, args: string[], options: SpawnOptionsWithoutStdio) =>
  spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
// Injection changes only the owned child process. Protocol handling remains real.
export function createAcpDriver(launch = launchAcp): AgentDriver {
  const driver: AgentDriver = {
    readUsage: (config, cwd, current) => readAcpUsage(config, cwd, current, launch),
    diagnose: (config, cwd) => inspectAgentProgram(config, cwd),
    async fork(config, input) {
      validateForkInput(config, input);
      let source;
      try {
        input.assertCurrent?.();
        source = await driver.open(
          config,
          input.sourceCwd,
          input.sourceNativeId,
          { update: () => {}, permission: async () => ({ outcome: { outcome: 'cancelled' } }) },
          { assertCurrent: input.assertCurrent },
        );
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
      if (options && Object.keys(options).some((key) => key !== 'assertCurrent'))
        throw new AppError(410, 'Moor 逐回合 MCP 与父子任务工具已退场', true);
      options?.assertCurrent?.();
      const assertCurrent = () => options?.assertCurrent?.();
      const custom = config.customAcp;
      if (custom && !isAbsolute(custom.command)) throw new Error('ACP 启动程序必须为本机绝对路径');
      const configuredCodexPath = config.runtimeOverrides?.codexPath,
        codexPath = !custom ? configuredCodexPath : undefined;
      if (!custom) {
        assert(config.agentType === 'codex', 409, '仅支持本机 Codex Agent');
        let usable = false;
        try {
          if (codexPath && isAbsolute(codexPath)) {
            accessSync(codexPath, constants.X_OK);
            usable = statSync(codexPath).isFile();
          }
        } catch {
          usable = false;
        }
        if (!usable) throw new AppError(409, LOCAL_CODEX_NOT_INSTALLED);
      }
      const entry = agentAdapterEntry(config);
      if (!custom && !entry) throw new Error('不支持的 Agent');
      let child: ReturnType<typeof launch>;
      try {
        assertCurrent();
        child = launch(
          custom?.command ?? process.execPath,
          custom?.args ?? [agentRequire.resolve('@agentclientprotocol/codex-acp')],
          {
            cwd,
            env: {
              // The host-selected cwd owns Git routing for both new and loaded
              // sessions. Shell-inherited Git overrides must not redirect it.
              ...Object.fromEntries(
                Object.entries(process.env).filter(
                  ([key]) =>
                    !key.toUpperCase().startsWith('GIT_') &&
                    (custom || config.agentType !== 'codex' || key !== 'CODEX_PATH'),
                ),
              ),
              ...(configuredCodexPath ? { CODEX_PATH: configuredCodexPath } : {}),
            },
            windowsHide: true,
            detached: process.platform !== 'win32',
          },
        );
      } catch (error) {
        throw identifyAgentModelFailure(error) ?? error;
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
        configuring = false,
        steeringPending = false,
        forking = false,
        eventState: SessionEventState | undefined,
        observedQuestion = false;
      const startupCommands = new Map<string, SessionEvent>();
      const startupContext = new Map<string, SessionEvent>();
      let usageSupported = false,
        usageSequence = -1;
      const deliverUsage = (value: unknown) => {
        const parsed = agentUsageUpdateSchema.safeParse(value);
        if (
          parsed.success &&
          parsed.data.sequence > usageSequence &&
          !stopped &&
          currentCallback()
        ) {
          usageSequence = parsed.data.sequence;
          callbacks.usage?.(parsed.data);
        }
      };
      const startupConfigurations = new Map<string, unknown>();
      let configuration: AcpConfiguration | undefined,
        configurationFault = false;
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
          assertCurrent();
          return true;
        } catch {
          void close();
          return false;
        }
      };
      const conn = new ClientSideConnection(
        () => ({
          extNotification: async (method, value) => {
            if (method !== MOOR_USAGE_UPDATED || !usageSupported || stopped || !currentCallback())
              return;
            deliverUsage(value);
          },
          sessionUpdate: async (value) => {
            if (stopped || !currentCallback()) return;
            const normalized = normalizeSessionEvent(value.update);
            if (!activeSessionId) {
              if (value.update.sessionUpdate === 'config_option_update') {
                if (startupConfigurations.size >= 4 && !startupConfigurations.has(value.sessionId))
                  startupConfigurations.delete(startupConfigurations.keys().next().value!);
                startupConfigurations.set(value.sessionId, value.update.configOptions);
              }
              // Session creation can emit command choices before its response. Keep
              // bounded snapshots and bind them only after the actual ID is known.
              if (normalized.status === 'accepted' && normalized.event.kind === 'commands') {
                if (startupCommands.size >= 4 && !startupCommands.has(value.sessionId))
                  startupCommands.delete(startupCommands.keys().next().value!);
                startupCommands.set(value.sessionId, normalized.event);
              }
              if (normalized.status === 'accepted' && normalized.event.kind === 'context-usage') {
                if (startupContext.size >= 4 && !startupContext.has(value.sessionId))
                  startupContext.delete(startupContext.keys().next().value!);
                startupContext.set(value.sessionId, normalized.event);
              }
              return;
            }
            if (value.sessionId !== activeSessionId) return;
            try {
              if (value.update.sessionUpdate === 'config_option_update')
                configuration?.replace(value.update.configOptions);
              if (value.update.sessionUpdate === 'current_mode_update')
                configuration?.mode(value.update.currentModeId);
            } catch {
              configurationFault = true;
            }
            if (!acceptingUpdates || !activeRun || activeRun.cancelled) {
              if (
                normalized.status === 'accepted' &&
                ['commands', 'context-usage'].includes(normalized.event.kind)
              )
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
              throw identifyAgentModelFailure(error) ?? error;
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
              throw identifyAgentModelFailure(error) ?? error;
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
        assertCurrent();
        try {
          const result = await work();
          assertCurrent();
          return result;
        } catch (error) {
          assertCurrent();
          throw identifyAgentModelFailure(error) ?? error;
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
              _meta: { moor: { version: 1 } },
            },
          }),
        );
        assertCurrent();
        usageSupported = supportsUsage(init);
        if (nativeId && !init.agentCapabilities?.loadSession)
          throw new Error('该 Agent 不支持恢复会话；请创建新会话');
        const response = nativeId
          ? await bounded(() =>
              conn.loadSession({
                sessionId: nativeId,
                cwd,
                mcpServers: [],
              }),
            )
          : await bounded(() => conn.newSession({ cwd, mcpServers: [] }));
        assertCurrent();
        const id = nativeId ?? (response as { sessionId: string }).sessionId;
        assert(typeof id === 'string', 502, 'Agent 返回的会话标识无效');
        activeSessionId = id;
        const initialCommands = startupCommands.get(id);
        if (initialCommands) observe(initialCommands);
        startupCommands.clear();
        const initialContext = startupContext.get(id);
        if (initialContext) observe(initialContext);
        startupContext.clear();
        configuration = new AcpConfiguration(response, nativeId ? 'loaded' : 'new');
        if (startupConfigurations.has(id)) configuration.replace(startupConfigurations.get(id));
        startupConfigurations.clear();
        const currentConfiguration = () => {
          assertCurrent();
          assert(!configurationFault && !stopped, 409, 'Agent 当前配置不可验证，请重新读取能力');
          return configuration!;
        };
        const applyModel = async (modelId: string) => {
          resolveRunSelection({ modelId }, currentConfiguration().capabilities);
          const result = await bounded(() =>
            conn.setSessionConfigOption({
              sessionId: id,
              configId: currentConfiguration().modelConfigId,
              value: modelId,
            }),
          );
          currentConfiguration().replace(result.configOptions);
          const observed = currentConfiguration().capabilities;
          resolveRunSelection({ modelId }, observed);
          assert(
            !observed.currentModelId || observed.currentModelId === modelId,
            409,
            'Agent 未确认所选模型，请刷新模型选项',
          );
        };
        const inputCapabilities = {
          image: init.agentCapabilities?.promptCapabilities?.image === true,
          audio: init.agentCapabilities?.promptCapabilities?.audio === true,
          embeddedContext: init.agentCapabilities?.promptCapabilities?.embeddedContext === true,
        };
        const interactionCapabilities = {
          questions: !!callbacks.question,
          steer: false,
          steerUnavailableReason:
            '当前 Codex 适配器不能保证追加指令只进入活动回合，请等待当前回合结束后发送',
        };
        const nativeForkCapabilities = forkCapabilities(config, init);
        return {
          id,
          ...(usageSupported
            ? {
                readUsage: async () => {
                  const result = agentUsageUpdateSchema.parse(
                    await bounded(() => conn.extMethod(MOOR_USAGE_READ, {})),
                  );
                  deliverUsage(result);
                  return result;
                },
              }
            : {}),
          get capabilities() {
            assert(!configurationFault, 409, 'Agent 当前配置不可验证，请重新读取能力');
            return configuration!.capabilities;
          },
          async configureModel(modelId) {
            assert(
              !activeRun && !steeringPending && !forking && !configuring,
              409,
              'Agent 正在处理其他请求，无法检查模型配置',
            );
            configuring = true;
            try {
              await applyModel(modelId);
              return currentConfiguration().capabilities;
            } finally {
              configuring = false;
            }
          },
          inputCapabilities,
          interactionCapabilities,
          forkCapabilities: nativeForkCapabilities,
          get runtimeFeatures() {
            return runtimeFeatureReport(init, eventState, observedQuestion);
          },
          get currentEvents() {
            return eventState;
          },
          close,
          async fork(input) {
            validateForkInput(config, input);
            if (
              stopped ||
              activeRun ||
              configuring ||
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
              input.assertCurrent?.();
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
            assertCurrent();
            assert(!stopped, 409, 'Agent 已停止');
            assert(!activeRun && !steeringPending, 409, 'Agent 已有活动回合或待确认追加指令');
            assert(!configuring, 409, 'Agent 有待确认的模型配置');
            assert(!forking, 409, 'Agent 的原生 Fork 尚未确认');
            const content = promptContent(input, inputCapabilities);
            resolveRunSelection(
              { modelId: input.modelId, modeId: input.modeId },
              currentConfiguration().capabilities,
            );
            const run: Run = {
              binding: binding ? runBindingSchema.parse(binding) : undefined,
              cancelled: false,
              questions: new Map(),
              forkAnchor: new ForkAnchorObservation(),
            };
            activeRun = run;
            try {
              if (input.modelId) await applyModel(input.modelId);
              assertCurrent();
              const choices = currentConfiguration().capabilities;
              currentConfiguration().validateValues(input.configOptionValues ?? {});
              resolveRunSelection(selectionFromInput(input, choices), choices);
              if (input.modeId)
                await bounded(() =>
                  conn.setSessionMode({
                    sessionId: id,
                    modeId: canonicalMode(input.modeId, choices)!,
                  }),
                );
              assertCurrent();
              for (const [configId, value] of Object.entries(input.configOptionValues ?? {})) {
                currentConfiguration().validateValues({ [configId]: value });
                const result = await bounded(() =>
                  conn.setSessionConfigOption({ sessionId: id, configId, value: String(value) }),
                );
                currentConfiguration().replace(result.configOptions);
                assertCurrent();
              }
              assertCurrent();
              const confirmed = currentConfiguration().capabilities;
              currentConfiguration().validateValues(input.configOptionValues ?? {}, true);
              assert(
                !input.modelId ||
                  !confirmed.currentModelId ||
                  input.modelId === confirmed.currentModelId,
                409,
                'Agent 当前模型已变化，请重新选择',
              );
              assert(!run.cancelled && !stopped, 409, '回合在发送前已取消');
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
              throw error;
            } finally {
              acceptingUpdates = false;
              cancelQuestions(run);
              if (activeRun === run) activeRun = undefined;
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
              throw error;
            }
          },
        };
      } catch (error) {
        await close();

        throw error;
      }
    },
  };
  return driver;
}
export const acpDriver = createAcpDriver();
