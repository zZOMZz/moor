import test from 'node:test';
import assert from 'node:assert/strict';
import {
  logicalProjectGroups,
  navigationProjects,
  navigationSessionQuery,
} from '../../apps/web/src/features/sessions/workspace-navigation-pages';
import { paginationFixture } from '../fixtures/workspace-pagination';

test('logical project grouping requires the exact source, account, service and workspace identity', async (t) => {
  const f = await paginationFixture(t);
  const [a, b] = navigationProjects(f.controller.state);
  const first = { ...a!, projectName: 'Same name', hostName: 'Mac A' };
  const second = {
    ...b!,
    projectName: 'Same name',
    hostName: 'Mac B',
    target: { ...b!.target, catalogProjectId: first.target.catalogProjectId },
  };
  const otherScopes = [
    { ...second, source: 'remote' as const },
    { ...second, target: { ...second.target, owner: 'another-owner' } },
    { ...second, target: { ...second.target, serverKey: 'https://other.invalid' } },
    { ...second, target: { ...second.target, catalogWorkspaceId: 'another-workspace' } },
    { ...second, target: { ...second.target, catalogProjectId: 'another-logical-project' } },
  ];
  const projects = [first, second, ...otherScopes],
    original = structuredClone(projects);
  const groups = logicalProjectGroups(projects);
  assert.deepEqual(
    groups.map((group) => group.projects.length),
    [2, 1, 1, 1, 1, 1],
  );
  assert.deepEqual(
    groups[0]!.projects.map((project) => project.target.replicaId),
    ['replica-project-a', 'replica-project-b'],
  );
  assert.deepEqual(projects, original, 'grouping never rewrites a target or merges saved data');
});

test('project and computer search chooses bounded summaries while other queries remain server title/id searches', async (t) => {
  const f = await paginationFixture(t);
  const project = {
    ...navigationProjects(f.controller.state)[0]!,
    projectName: 'Moor Client',
    hostName: 'Home Mac',
  };
  for (const query of ['Moor', 'home mac', 'Client Mac'])
    assert.equal(navigationSessionQuery(project, query), '');
  for (const query of ['Needle', 'session-094', 'not on this computer'])
    assert.equal(navigationSessionQuery(project, query), query);
});
