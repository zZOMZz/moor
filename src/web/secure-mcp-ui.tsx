import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import {
  MCP_LIMITS,
  validateMcpRead,
  type McpReadResult,
  type McpServerView,
} from '../mcp-protocol';
import { productCanonicalJson } from '../security/encrypted-product-catalog';
import { secureTargetSchema, type SecureCliTarget } from '../cli/secure-operation';
import type { SecureMcpDraft } from './secure-mcp';
import type { SecureContentContext } from './secure-controller';

export type SecureMcpPanelProps = {
  target: SecureCliTarget;
  draft: SecureMcpDraft;
  catalog?: McpReadResult;
  busy: boolean;
  online: boolean;
  reason?: string;
  error?: string;
  onRefresh(): Promise<void> | void;
  onApply(expected: SecureMcpDraft, servers: McpServerView[]): Promise<void>;
  onClose(): void;
};
const same = (left: unknown, right: unknown) =>
  productCanonicalJson(left) === productCanonicalJson(right);

/** Pure display of safe metadata. Reads and saves require explicit parent callbacks. */
export function SecureMcpPanel(props: SecureMcpPanelProps) {
  return <McpSelection key={productCanonicalJson([props.target, props.draft])} {...props} />;
}
function McpSelection(p: SecureMcpPanelProps) {
  const [chosen, setChosen] = useState(() => structuredClone(p.draft.review?.servers ?? []));
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const busy = p.busy || working;
  // Preserve previously reviewed text even if a corrupt catalog reuses an ID with changed metadata.
  const options = [
    ...chosen,
    ...(p.catalog?.servers ?? []).filter((server) => !chosen.some((old) => old.id === server.id)),
    ...(p.draft.review?.servers ?? []).filter(
      (server) =>
        !chosen.some((item) => item.id === server.id) &&
        !p.catalog?.servers.some((item) => item.id === server.id),
    ),
  ];
  const available = (server: McpServerView) =>
    p.online && !!p.catalog?.servers.some((item) => same(item, server));
  const work = async (action: () => Promise<void> | void) => {
    setError('');
    setWorking(true);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'MCP 操作未确认，请重新读取。');
    } finally {
      setWorking(false);
    }
  };
  return (
    <Dialog.Root open onOpenChange={(open) => !open && p.onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="session-dialog-backdrop" />
        <Dialog.Popup className="session-dialog mcp-panel secure-mcp-panel">
          <div className="attachment-preview-heading">
            <Dialog.Title>本回合额外 MCP</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="关闭额外 MCP">
              <X />
            </Dialog.Close>
          </div>
          <Dialog.Description>
            为下一条手动指令附加最多 {MCP_LIMITS.selected} 个服务器。这里只控制 Moor 附加项，Agent
            自己的 MCP 设置不会因此关闭。
          </Dialog.Description>
          <p>
            读取目录和保存草稿不会连接服务器或启动
            Agent。发送前会重新核对原版本；后续回合、会话副本和子任务不会自动继承。
          </p>
          {(error || p.error || p.reason || !p.online) && (
            <p role="status">
              {error ||
                p.error ||
                p.reason ||
                '当前离线。已有原版本选择保留，可手动移除；连接后请手动读取目录。'}
            </p>
          )}
          <button
            type="button"
            disabled={busy || !p.online || !!p.reason}
            onClick={() => void work(p.onRefresh)}
          >
            读取项目允许的 MCP
          </button>
          {!p.catalog && <p>尚无当前目录。已有选择保留原版本；发送前需要重新核对。</p>}
          {p.catalog && !p.catalog.servers.length && <p>此项目当前没有可用的额外 MCP。</p>}
          <ul aria-label="额外 MCP 服务器">
            {options.map((server) => {
              const selected = chosen.some((item) => item.id === server.id);
              const unavailable = !available(server);
              return (
                <li key={server.id}>
                  <label>
                    <input
                      type="checkbox"
                      aria-label={`选择 MCP：${server.name}`}
                      checked={selected}
                      disabled={
                        busy ||
                        (!selected &&
                          ((unavailable &&
                            !p.draft.review?.servers.some((saved) => same(saved, server))) ||
                            chosen.length >= MCP_LIMITS.selected))
                      }
                      onChange={(event) => {
                        setError('');
                        setChosen(
                          event.target.checked
                            ? [...chosen, structuredClone(server)]
                            : chosen.filter((item) => item.id !== server.id),
                        );
                      }}
                    />
                    {server.name}
                  </label>
                  <p>{server.description}</p>
                  <p>
                    版本：<code>{server.id}</code> · {server.transport}
                    {unavailable ? ' · 当前不可用或尚未重新核对' : ''}
                  </p>
                </li>
              );
            })}
          </ul>
          <p>
            已选择 {chosen.length} / {MCP_LIMITS.selected} 个。主机确认指令后仅清除此份选择。
          </p>
          {p.draft.delivery && (
            <p>
              原指令 {p.draft.delivery.operationId}{' '}
              {p.draft.delivery.state === 'ending' ? '正在封存' : '结果待确认'}，原 MCP
              选择已固定。此处保存新选择只用于后续手动指令。
            </p>
          )}
          <div className="session-dialog-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const expected = structuredClone(p.draft),
                  selection = structuredClone(chosen);
                void work(() => p.onApply(expected, selection));
              }}
            >
              确认保存 MCP 选择到草稿
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError('');
                setChosen([]);
              }}
            >
              清空待保存选择
            </button>
            <Dialog.Close>关闭</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function SecureMcpDraftCard(p: { draft: SecureMcpDraft; onOpen(): void }) {
  const servers = p.draft.review?.servers ?? [];
  if (!servers.length && !p.draft.delivery) return null;
  return (
    <section aria-label="已保存的 MCP 草稿" className="task-plan-card">
      <button type="button" onClick={p.onOpen}>
        {servers.length
          ? `额外 MCP：${servers.map((server) => server.name).join('、')}`
          : '核对原指令的 MCP 选择'}
      </button>
      <p>仅随下一条手动指令授权当前回合；发送前将重新核对所选原版本。</p>
      {p.draft.delivery && <p>原指令的 MCP 选择已固定，结果待核查。</p>}
    </section>
  );
}

export type SecureMcpUiHandle = {
  open(expectedTarget: SecureCliTarget): void;
  close(): void;
};
export type SecureMcpUiProps = {
  context(): SecureContentContext;
  draft(): SecureMcpDraft | null;
  readCatalog(target: SecureCliTarget): Promise<McpReadResult>;
  apply(
    target: SecureCliTarget,
    expected: SecureMcpDraft,
    servers: McpServerView[],
    catalog: McpReadResult | undefined,
    current: () => void,
  ): Promise<void>;
  busy?: boolean;
  reason?: string;
};
type OpenMcp = {
  target: SecureCliTarget;
  generation: number;
  online: boolean;
  lifetime: number;
  busy: boolean;
  catalog?: McpReadResult;
  error?: string;
};

/** The panel never survives a connection/selection epoch, including an A → B → A change. */
export const SecureMcpUI = forwardRef<SecureMcpUiHandle, SecureMcpUiProps>(
  function SecureMcpUI(props, ref) {
    const latest = useRef(props);
    latest.current = props;
    const lifetime = useRef(0);
    const actionInFlight = useRef<number | null>(null);
    const [panel, setPanel] = useState<OpenMcp | null>(null);
    const matches = (snapshot: OpenMcp) => {
      const context = latest.current.context(),
        draft = latest.current.draft();
      return (
        snapshot.lifetime === lifetime.current &&
        snapshot.generation === context.generation &&
        snapshot.online === context.online &&
        !!context.target &&
        !!draft &&
        same(snapshot.target, context.target) &&
        same(snapshot.target, draft.target)
      );
    };
    const current = (snapshot: OpenMcp) => {
      if (!matches(snapshot)) throw Error('MCP 面板或执行目标已改变，请重新打开并核对。');
    };
    const close = () => {
      lifetime.current++;
      setPanel(null);
    };
    const contextKey = productCanonicalJson(props.context());
    useLayoutEffect(() => {
      if (panel && !matches(panel)) close();
    }, [contextKey, panel]);
    useLayoutEffect(
      () => () => {
        lifetime.current++;
      },
      [],
    );
    useImperativeHandle(ref, () => ({
      open(input) {
        const target = secureTargetSchema.parse(input),
          context = latest.current.context(),
          draft = latest.current.draft();
        if (
          !context.target ||
          !draft ||
          !same(context.target, target) ||
          !same(draft.target, target)
        )
          return;
        setPanel({
          target,
          generation: context.generation,
          online: context.online,
          lifetime: ++lifetime.current,
          busy: false,
        });
      },
      close,
    }));
    const shown = panel && matches(panel) ? panel : null;
    const draft = shown ? props.draft() : null;
    if (!shown || !draft) return null;
    const work = async (
      action: (snapshot: OpenMcp, guard: () => void) => Promise<Partial<OpenMcp> | void>,
    ) => {
      const snapshot = shown;
      current(snapshot);
      if (actionInFlight.current === snapshot.lifetime) return;
      actionInFlight.current = snapshot.lifetime;
      setPanel({ ...snapshot, busy: true, error: undefined });
      try {
        const result = await action(snapshot, () => current(snapshot));
        current(snapshot);
        setPanel({ ...snapshot, ...result, busy: false, error: undefined });
      } catch (error) {
        if (matches(snapshot))
          setPanel({
            ...snapshot,
            busy: false,
            error: error instanceof Error ? error.message : 'MCP 操作未确认。',
          });
      } finally {
        if (actionInFlight.current === snapshot.lifetime) actionInFlight.current = null;
      }
    };
    return (
      <SecureMcpPanel
        target={shown.target}
        draft={draft}
        catalog={shown.catalog}
        busy={!!props.busy || shown.busy}
        online={shown.online}
        reason={props.reason}
        error={shown.error}
        onClose={close}
        onRefresh={() =>
          work(async (snapshot, guard) => {
            if (!snapshot.online) throw Error('请连接后手动读取 MCP 目录。');
            guard();
            const catalog = validateMcpRead(
              await latest.current.readCatalog(structuredClone(snapshot.target)),
              {
                mcpVersion: 1,
                workspaceId: snapshot.target.workspaceId,
                localProjectId: snapshot.target.localProjectId,
                sessionId: snapshot.target.sessionId,
              },
            );
            guard();
            return { catalog };
          })
        }
        onApply={(expected, servers) =>
          work(async (snapshot, guard) => {
            guard();
            await latest.current.apply(
              structuredClone(snapshot.target),
              structuredClone(expected),
              structuredClone(servers),
              snapshot.catalog,
              guard,
            );
            guard();
          })
        }
      />
    );
  },
);
