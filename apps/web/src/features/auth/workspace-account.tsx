import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Account, AccountApi } from '../../platform/account';
import type {
  AccountManagementRequest,
  AccountManagementValue,
} from '@moor/protocol/account-management';
import type { DesktopWorkspaceTarget } from '@moor/client/workspace-protocol';
import { CatalogManagement } from './catalog-management';
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
  const [pair, setPair] = useState<Extract<AccountManagementValue, { action: 'pair' }>>();
  const locked = useRef(false);
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
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setPair(await manage({ action: 'pair', owner: account.owner! }));
              })
            }
          >
            添加电脑
          </button>
          {pair && (
            <div role="status">
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
