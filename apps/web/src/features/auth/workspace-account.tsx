import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Account, AccountApi } from '../../platform/account';
import type {
  AccountManagementRequest,
  AccountManagementValue,
} from '@moor/protocol/account-management';
import type { DesktopWorkspaceTarget } from '@moor/client/workspace-protocol';
import { CatalogManagement, type ManagedWorkspace } from './catalog-management';
import type { WorkspaceScope } from '../workspace/workspace-store';
import { GoogleStart } from './google-login';
import {
  readRetiredSecureRecords,
  readRetiredWebRecords,
  exportRetiredRecords,
  type RetiredRecord,
} from '../../platform/retired-records';

export function WorkspaceAccountPanel({
  accountApi,
  onAccountVerified,
  onBeforeLogout,
  onBack,
  openSettings,
  extras,
  activeTarget,
  beforeMove,
  endView,
  visible = true,
  pairingScope,
}: {
  accountApi: AccountApi;
  onAccountVerified(value: Account | null): void;
  onBeforeLogout(): Promise<void>;
  onBack(): void;
  openSettings?: () => void;
  extras?: ReactNode;
  activeTarget?: DesktopWorkspaceTarget;
  beforeMove?(): Promise<void>;
  endView?(): Promise<void>;
  visible?: boolean;
  pairingScope?: WorkspaceScope;
}) {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [recordKind, setRecordKind] = useState<'moor-retired-secure-v1' | 'moor-retired-web-v1'>(
    'moor-retired-secure-v1',
  );
  const [records, setRecords] = useState<RetiredRecord[]>();
  const [devices, setDevices] =
    useState<Extract<AccountManagementValue, { action: 'devices' }>['devices']>();
  const [pair, setPair] = useState<
    Extract<AccountManagementValue, { action: 'pair' }> & { workspaceName?: string }
  >();
  const [pairing, setPairing] = useState<{
    account: Account & { owner: string };
    workspaces: ManagedWorkspace[];
    selected: string;
  }>();
  const locked = useRef(false);
  const latest = useRef({ account, visible, pairingScope, active: true });
  latest.current = { ...latest.current, account, visible, pairingScope };
  useEffect(() => {
    latest.current.active = true;
    return () => {
      latest.current.active = false;
    };
  }, []);
  useEffect(() => {
    setPair(undefined);
    setPairing(undefined);
  }, [account?.origin, account?.owner]);
  useEffect(() => {
    let current = true;
    void accountApi({ action: 'status' })
      .then((result) => {
        if (!current) return;
        if (!result.ok) throw Error(result.error.message);
        if (!('origin' in result.value)) throw Error('账号状态未确认。');
        setAccount(result.value);
        onAccountVerified(result.value);
      })
      .catch((reason) => {
        if (current) {
          setError(reason instanceof Error ? reason.message : '账号状态未确认。');
          onAccountVerified(null);
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [accountApi, onAccountVerified]);
  const run = async (work: () => Promise<unknown>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作未完成，请重试。');
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const manage = async <T extends AccountManagementRequest>(
    request: T,
  ): Promise<Extract<AccountManagementValue, { action: T['action'] }>> => {
    const result = await accountApi(request);
    if (!result.ok) throw Error(result.error.message);
    if (!('action' in result.value) || result.value.action !== request.action)
      throw Error('账号管理结果未确认，请重新读取后核对。');
    return result.value as Extract<AccountManagementValue, { action: T['action'] }>;
  };
  const changed = () => window.dispatchEvent(new Event('moor:catalog-changed'));
  const assertPairCurrent = (reviewed: Account) => {
    const current = latest.current;
    if (
      !current.active ||
      !current.visible ||
      current.account?.owner !== reviewed.owner ||
      current.account.origin !== reviewed.origin
    )
      throw Error('账号或页面已改变，本次没有继续创建配对码。');
  };
  const createPair = async (
    reviewed: Account & { owner: string },
    workspace?: ManagedWorkspace,
  ) => {
    assertPairCurrent(reviewed);
    const value = await manage({
      action: 'pair',
      owner: reviewed.owner,
      ...(workspace ? { workspaceId: workspace.id } : {}),
    });
    assertPairCurrent(reviewed);
    setPair({ ...value, workspaceName: workspace?.name });
    setPairing(undefined);
  };
  const beginPair = async () => {
    if (!account?.owner) return;
    const reviewed = { ...account, owner: account.owner };
    setPair(undefined);
    setPairing(undefined);
    const workspaces = (await manage({ action: 'catalog', owner: reviewed.owner })).workspaces;
    assertPairCurrent(reviewed);
    if (workspaces.length <= 1) return createPair(reviewed, workspaces[0]);
    const preferred = latest.current.pairingScope;
    const selected =
      preferred?.source === 'remote' &&
      preferred.target.owner === reviewed.owner &&
      preferred.target.serverKey === reviewed.origin &&
      workspaces.some((workspace) => workspace.id === preferred.target.catalogWorkspaceId)
        ? preferred.target.catalogWorkspaceId
        : '';
    setPairing({ account: reviewed, workspaces, selected });
  };
  return (
    <section className="workspace-account-panel">
      <h1>账号与连接</h1>
      <button onClick={onBack}>返回工作区</button>
      {loading ? (
        <p role="status">正在读取账号…</p>
      ) : account?.owner ? (
        <>
          <p>已连接 {account.origin}</p>
          <p>其他电脑的项目会出现在工作区中。</p>
          <button disabled={busy} onClick={() => void run(beginPair)}>
            添加电脑
          </button>
          {pairing && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const chosen = pairing.workspaces.find(
                  (workspace) => workspace.id === pairing.selected,
                );
                if (chosen) void run(() => createPair(pairing.account, chosen));
              }}
            >
              <label>
                新电脑加入的工作区
                <select
                  aria-label="配对工作区"
                  required
                  disabled={busy}
                  value={pairing.selected}
                  onChange={(event) => setPairing({ ...pairing, selected: event.target.value })}
                >
                  <option value="">选择工作区</option>
                  {pairing.workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
              </label>
              <button disabled={busy || !pairing.selected}>生成配对码</button>
              <button type="button" disabled={busy} onClick={() => setPairing(undefined)}>
                取消配对
              </button>
            </form>
          )}
          {pair && (
            <div role="status">
              {pair.workspaceName && <p>新电脑将加入：{pair.workspaceName}</p>}
              <p>
                在另一台电脑的 Moor 连接设置中输入服务器地址与配对码。配对码有效期 {pair.expiresIn}{' '}
                秒。
              </p>
              <p>{account.origin}</p>
              <output aria-label="电脑配对码">{pair.code}</output>
            </div>
          )}
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setDevices((await manage({ action: 'devices', owner: account.owner! })).devices);
              })
            }
          >
            已连接电脑
          </button>
          {devices && (
            <ul>
              {devices.map((device) => (
                <li key={device.id}>
                  <span>
                    {device.name} · {device.online ? '在线' : '离线'}
                  </span>
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`撤销“${device.name}”的远程访问授权？`)) return;
                      void run(async () => {
                        await manage({
                          action: 'revoke',
                          owner: account.owner!,
                          deviceId: device.id,
                        });
                        changed();
                        setDevices(
                          (await manage({ action: 'devices', owner: account.owner! })).devices,
                        );
                      });
                    }}
                  >
                    撤销授权
                  </button>
                </li>
              ))}
            </ul>
          )}
          {activeTarget && endView && (
            <button disabled={busy} onClick={() => void run(endView)}>
              结束当前查看
            </button>
          )}
          <CatalogManagement
            key={account.owner}
            owner={account.owner}
            origin={account.origin}
            activeTarget={activeTarget}
            beforeMove={beforeMove}
            onChanged={changed}
            visible={visible}
            actions={{
              read: async () =>
                (await manage({ action: 'catalog', owner: account.owner! })).workspaces,
              createWorkspace: (name) =>
                manage({ action: 'create-workspace', owner: account.owner!, name }),
              renameWorkspace: (workspaceId, name) =>
                manage({ action: 'rename-workspace', owner: account.owner!, workspaceId, name }),
              createProject: (workspaceId, name, source) =>
                manage({
                  action: 'create-project',
                  owner: account.owner!,
                  workspaceId,
                  name,
                  source,
                }),
              moveHost: (workspaceId, hostId, targetWorkspaceId) =>
                manage({
                  action: 'move-host',
                  owner: account.owner!,
                  workspaceId,
                  hostId,
                  targetWorkspaceId,
                }),
              assignReplica: (workspaceId, replicaId, projectId) =>
                manage({
                  action: 'assign-replica',
                  owner: account.owner!,
                  workspaceId,
                  replicaId,
                  projectId,
                }),
            }}
          />
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const owner = account.owner!;
                await onBeforeLogout();
                const result = await accountApi({ action: 'logout', owner });
                if (!result.ok) throw Error(result.error.message);
                setAccount(null);
                onAccountVerified(null);
                location.reload();
              })
            }
          >
            退出账号
          </button>
        </>
      ) : (
        <>
          <p>本机项目可独立使用。登录个人中转账号后，可连接其他电脑。</p>
          {account?.google.enabled && (
            <GoogleStart mode={account.needsSetup ? 'setup' : 'login'} disabled={busy} />
          )}
          {openSettings && <button onClick={openSettings}>配置中转地址</button>}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {extras}
      <details>
        <summary>历史本机数据</summary>
        <p>
          加密连接已停止提供。已有本机记录保持原样；读取与导出不会连接主机或执行原请求。结果待确认的操作仍需保留原编号与原目标。
        </p>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setRecordKind('moor-retired-secure-v1');
              setRecords(await readRetiredSecureRecords());
            })
          }
        >
          读取历史加密记录
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setRecordKind('moor-retired-web-v1');
              setRecords(await readRetiredWebRecords());
            })
          }
        >
          读取旧版网页记录
        </button>
        {records && (
          <>
            <p role="status">
              找到 {records.length} 条本机记录。导出文件包含历史正文，请保存在自己的设备上。
            </p>
            {records.length > 0 && (
              <button
                disabled={busy}
                onClick={() => void run(() => exportRetiredRecords(records, recordKind))}
              >
                导出历史记录
              </button>
            )}
          </>
        )}
      </details>
    </section>
  );
}
