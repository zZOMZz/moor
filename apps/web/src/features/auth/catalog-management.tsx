import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { z } from 'zod';
import type { workspaceCatalogSchema } from '@moor/protocol/workspace-catalog';
import type { DesktopWorkspaceTarget } from '@moor/client/workspace-protocol';
import { projectSourceSchema, type ProjectSource } from '@moor/protocol/catalog';
import { assertCatalogDataSettled, type CatalogDataScope } from '../../platform/catalog-data-guard';

export type ManagedWorkspace = z.infer<typeof workspaceCatalogSchema>[number];
export type CatalogManagementActions = {
  read(): Promise<ManagedWorkspace[]>;
  createWorkspace(name: string): Promise<unknown>;
  renameWorkspace(workspaceId: string, name: string): Promise<unknown>;
  createProject(workspaceId: string, name: string, source?: ProjectSource): Promise<unknown>;
  moveHost(workspaceId: string, hostId: string, targetWorkspaceId: string): Promise<unknown>;
  assignReplica(workspaceId: string, replicaId: string, projectId: string): Promise<unknown>;
};
export function CatalogManagement({
  actions,
  activeTarget,
  beforeMove,
  onChanged,
  owner,
  origin,
  visible = true,
}: {
  actions: CatalogManagementActions;
  activeTarget?: DesktopWorkspaceTarget;
  beforeMove?(): Promise<void>;
  onChanged(): void;
  owner: string;
  origin: string;
  visible?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [workspaces, setWorkspaces] = useState<ManagedWorkspace[]>([]),
    [selected, setSelected] = useState('');
  const [gitSource, setGitSource] = useState(false);
  const locked = useRef(false),
    alive = useRef(true),
    view = useRef({ visible, activeTarget });
  view.current = { visible, activeTarget };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const current = workspaces.find((workspace) => workspace.id === selected) ?? workspaces[0];
  const refresh = async () => {
    const value = await actions.read();
    if (alive.current) setWorkspaces(value);
  };
  const run = (work: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    void work()
      .catch((reason) => {
        if (alive.current)
          setError(reason instanceof Error ? reason.message : '更改未确认，请重新读取后核对。');
      })
      .finally(() => {
        locked.current = false;
        if (alive.current) setBusy(false);
      });
  };
  const submit = (
    event: FormEvent<HTMLFormElement>,
    action: (data: FormData) => Promise<unknown>,
  ) => {
    event.preventDefault();
    const form = event.currentTarget,
      values = new FormData(form);
    run(async () => {
      const result = await action(values);
      if (result === false) return;
      onChanged();
      await refresh();
      form.reset();
    });
  };
  const move = async (scope: CatalogDataScope, message: string, action: () => Promise<unknown>) => {
    await beforeMove?.();
    await assertCatalogDataSettled(scope);
    if (!alive.current || !view.current.visible) throw Error('管理页面已关闭，本次没有更改分组。');
    const target = view.current.activeTarget;
    if (
      target?.owner === scope.owner &&
      target.serverKey === scope.origin &&
      target.deviceId === scope.deviceId &&
      target.workspaceId === scope.workspaceId &&
      (!scope.replicaId || target.replicaId === scope.replicaId)
    )
      throw Error(
        '这个执行范围仍在当前会话中查看。请先处理未发送草稿和原请求，再结束当前查看后调整分组。',
      );
    if (!window.confirm(message)) return false;
    return action();
  };
  return (
    <section className="workspace-catalog-management">
      <button
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          if (!open) run(refresh);
        }}
      >
        高级分组管理
      </button>
      {open && (
        <>
          <p>
            这里调整工作区名称、电脑归属和项目分组。文件与会话继续由原电脑保存。有未发送草稿、附件或待确认操作的范围，须先回到原会话处理后才能调整归组。
          </p>
          <button disabled={busy} onClick={() => run(refresh)}>
            重新读取分组
          </button>
          {error && <p role="alert">{error}</p>}
          <fieldset disabled={busy}>
            <legend>工作区</legend>
            <form
              onSubmit={(event) =>
                submit(event, (data) => actions.createWorkspace(String(data.get('name') ?? '')))
              }
            >
              <label>
                新工作区名称
                <input name="name" required maxLength={100} />
              </label>
              <button>创建工作区</button>
            </form>
            {current && (
              <>
                <label>
                  管理的工作区
                  <select value={current.id} onChange={(event) => setSelected(event.target.value)}>
                    {workspaces.map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        {workspace.name}
                      </option>
                    ))}
                  </select>
                </label>
                <form
                  key={'rename:' + current.id + ':' + current.name}
                  onSubmit={(event) =>
                    submit(event, (data) =>
                      actions.renameWorkspace(current.id, String(data.get('name') ?? '')),
                    )
                  }
                >
                  <label>
                    当前工作区名称
                    <input name="name" required maxLength={100} defaultValue={current.name} />
                  </label>
                  <button>保存工作区名称</button>
                </form>
                <h3>电脑归属</h3>
                {current.hosts.map((host) => (
                  <form
                    key={host.id}
                    onSubmit={(event) =>
                      submit(event, (data) => {
                        const destination = String(data.get('workspaceId') ?? '');
                        if (destination === current.id) return Promise.resolve(false);
                        return move(
                          {
                            owner,
                            origin,
                            deviceId: host.deviceId,
                            machineId: host.machineId,
                            workspaceId: host.runtimeWorkspaceId,
                            catalogWorkspaceId: current.id,
                            catalogProjectIds: current.replicas
                              .filter((replica) => replica.hostId === host.id)
                              .map((replica) => replica.projectId),
                          },
                          `将“${host.name}”及其项目分组移到所选工作区？`,
                          () => actions.moveHost(current.id, host.id, destination),
                        );
                      })
                    }
                  >
                    <label>
                      {host.name}
                      <select name="workspaceId" defaultValue={current.id}>
                        {workspaces.map((workspace) => (
                          <option key={workspace.id} value={workspace.id}>
                            {workspace.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button>更改归属</button>
                  </form>
                ))}
                <h3>项目分组</h3>
                <form
                  onSubmit={(event) =>
                    submit(event, (data) =>
                      actions.createProject(
                        current.id,
                        String(data.get('name') ?? ''),
                        projectSourceSchema.parse(
                          gitSource
                            ? { kind: 'git', provider: data.get('provider'), url: data.get('url') }
                            : { kind: 'local' },
                        ),
                      ),
                    )
                  }
                >
                  <label>
                    新项目分组名称
                    <input name="name" required maxLength={200} />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={gitSource}
                      onChange={(event) => setGitSource(event.target.checked)}
                    />
                    记录 Git 来源
                  </label>
                  {gitSource && (
                    <>
                      <label>
                        仓库服务
                        <select name="provider" defaultValue="github">
                          <option value="github">GitHub</option>
                          <option value="gitlab">GitLab</option>
                          <option value="other">其他</option>
                        </select>
                      </label>
                      <label>
                        仓库地址
                        <input
                          name="url"
                          type="url"
                          required
                          maxLength={2048}
                          placeholder="https://github.com/owner/repository"
                        />
                      </label>
                      <p>来源仅用于描述项目分组。不会克隆仓库或连接 Git 服务。</p>
                    </>
                  )}
                  <button>创建项目分组</button>
                </form>
                {current.replicas.map((replica) => (
                  <form
                    key={replica.id + ':' + replica.projectId}
                    onSubmit={(event) =>
                      submit(event, (data) => {
                        const projectId = String(data.get('projectId') ?? '');
                        if (projectId === replica.projectId) return Promise.resolve(false);
                        const host = current.hosts.find((host) => host.id === replica.hostId);
                        if (!host) throw Error('执行电脑关联已经改变，请重新读取。');
                        return move(
                          {
                            owner,
                            origin,
                            deviceId: host.deviceId,
                            machineId: host.machineId,
                            workspaceId: host.runtimeWorkspaceId,
                            replicaId: replica.id,
                            localProjectId: replica.localProjectId,
                            catalogWorkspaceId: current.id,
                            catalogProjectIds: [replica.projectId],
                          },
                          '将此本地项目归入所选项目分组？',
                          () => actions.assignReplica(current.id, replica.id, projectId),
                        );
                      })
                    }
                  >
                    <label>
                      {current.hosts.find((host) => host.id === replica.hostId)?.name ?? '执行电脑'}{' '}
                      ·{' '}
                      {current.projects.find((project) => project.id === replica.projectId)?.name ??
                        replica.localProjectId}
                      <select name="projectId" defaultValue={replica.projectId}>
                        {current.projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button>保存项目归组</button>
                  </form>
                ))}
              </>
            )}
          </fieldset>
        </>
      )}
    </section>
  );
}
