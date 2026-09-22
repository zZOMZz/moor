import type { TestContext } from 'node:test';
import { HostCommandDispatcher, type HostCommand } from '@moor/host/commands/host-command';
import { AppError } from '@moor/protocol/protocol';
import { validateHostResponse } from '@moor/protocol/host-response';
import type { HostWorkspace } from '@moor/host/sessions/workspace';

/** Exercises the real Host boundary with a deterministic revocable connection guard. */
export async function guardedCommandHost(t: TestContext, workspace: () => HostWorkspace) {
  const dispatcher = new HostCommandDispatcher({
    ready: () => !workspace().closed,
    workspace: (id) => (id === workspace().workspace.id ? workspace() : undefined),
    hasOperation: (id) => workspace().store.journal.has(id),
  });
  return {
    async connect() {
      let active = true;
      const current = () => {
        if (!active) throw new AppError(409, 'Synthetic connection retired');
      };
      t.after(() => {
        active = false;
      });
      return {
        async execute(command: HostCommand, sessionId: string): Promise<any> {
          current();
          if (
            !command.localProjectId ||
            ('sessionId' in command.params && command.params.sessionId !== sessionId)
          )
            throw new AppError(400, 'Synthetic session scope mismatch');
          try {
            const raw = await dispatcher.execute(command, { current });
            current();
            return {
              ok: true,
              result: await validateHostResponse(raw, {
                command,
                workspace: workspace().workspace,
                current,
              }),
            };
          } catch (error) {
            current();
            return { ok: false, error: dispatcher.error(command, error) };
          }
        },
        retire() {
          active = false;
        },
      };
    },
  };
}
