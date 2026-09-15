import { useEffect, useState } from 'react';
import { Folder, Pin, MessageCircle } from 'lucide-react';
import type { WorkspaceController, WorkspaceClientState } from '../workspace/workspace-controller';
import type { DesktopWorkspaceSource } from '@moor/client/workspace-protocol';
import type { SessionMetadata } from '@moor/protocol/session-responses';
import { productCanonicalJson as canonical } from '@moor/client/encrypted-product';

export type NavigationProject = NonNullable<WorkspaceClientState['project']> & {
  source: DesktopWorkspaceSource;
};
export const projectKey = (entry: NavigationProject) => canonical([entry.source, entry.target]);
export const workspaceKey = (entry: NavigationProject) =>
  canonical([
    entry.source,
    entry.target.serverKey,
    entry.target.owner,
    entry.target.catalogWorkspaceId,
  ]);
export function navigationProjects(state: WorkspaceClientState): NavigationProject[] {
  return (['local', 'remote'] as const).flatMap((source) =>
    (state.catalogs[source]?.targets ?? []).map((entry) => ({ ...entry, source })),
  );
}
export function useNavigationSessions(
  controller: WorkspaceController,
  state: WorkspaceClientState,
) {
  const [result, setResult] = useState<{
    catalog: string;
    sessions: Record<string, SessionMetadata[]>;
    unavailable: string[];
  }>({ catalog: '', sessions: {}, unavailable: [] });
  const catalog = canonical([state.catalogs, controller.navigationRevision ?? 0]);
  useEffect(() => {
    let active = true;
    const projects = navigationProjects(state),
      sessions: Record<string, SessionMetadata[]> = {},
      unavailable: string[] = [];
    let cursor = 0;
    async function read() {
      while (active && cursor < projects.length) {
        const entry = projects[cursor++]!;
        try {
          sessions[projectKey(entry)] = await controller.listProjectSessions(
            entry.source,
            entry.target,
          );
        } catch {
          unavailable.push(projectKey(entry));
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, projects.length) }, read)).then(() => {
      if (active) setResult({ catalog, sessions, unavailable });
    });
    return () => {
      active = false;
    };
  }, [controller, catalog]);
  useEffect(() => {
    if (!state.project || !state.scope) return;
    const key = projectKey({ ...state.project, source: state.scope.source });
    setResult((previous) =>
      previous.catalog === catalog && previous.sessions[key] !== state.sessions
        ? { ...previous, sessions: { ...previous.sessions, [key]: state.sessions } }
        : previous,
    );
  }, [catalog, result.catalog, state.project, state.scope, state.sessions]);
  const sessions = result.catalog === catalog ? { ...result.sessions } : {};
  if (state.project && state.scope)
    sessions[projectKey({ ...state.project, source: state.scope.source })] = state.sessions;
  return { sessions, unavailable: result.catalog === catalog ? result.unavailable : [] };
}
export function NavigationSessions({
  entries,
  selected,
  disabled,
  onOpen,
  kind,
}: {
  entries: { project: NavigationProject; session: SessionMetadata }[];
  selected?: string;
  disabled: boolean;
  onOpen(project: NavigationProject, session: SessionMetadata): void;
  kind: 'pinned' | 'recent';
}) {
  return (
    <section
      className={'workspace-navigation-section workspace-' + kind}
      aria-label={kind === 'pinned' ? '置顶会话' : 'Chat'}
    >
      <h2>{kind === 'pinned' ? '置顶' : 'Chat'}</h2>
      <ul>
        {entries.map(({ project, session }) => {
          const key = canonical([projectKey(project), session.id]);
          return (
            <li key={key}>
              <button
                disabled={disabled}
                aria-current={selected === key ? 'page' : undefined}
                onClick={() => onOpen(project, session)}
                title={session.title + ' · ' + project.projectName + ' · ' + project.hostName}
              >
                {kind === 'pinned' ? <Pin size={14} /> : <MessageCircle size={14} />}
                <span>
                  {session.title || '未命名会话'}
                  <small>{project.projectName}</small>
                </span>
                {session.status?.type === 'working' && (
                  <span className="session-working" aria-label="进行中" />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {!entries.length && (
        <p className="workspace-muted">
          {kind === 'pinned' ? '置顶的会话会显示在这里' : '还没有最近会话'}
        </p>
      )}
    </section>
  );
}
