import type { WorkspaceGraph } from '@moor/client/features/workspace/compose';

type Selection = { [Group in keyof WorkspaceGraph]?: readonly (keyof WorkspaceGraph[Group])[] };
export type WorkspacePort<S extends Selection> = {
  [Group in keyof S & keyof WorkspaceGraph]: Pick<
    WorkspaceGraph[Group],
    Extract<NonNullable<S[Group]>[number], keyof WorkspaceGraph[Group]>
  >;
};
const cache = new WeakMap<object, WeakMap<object, object>>();

/** UI consumers declare their own selection; assembly copies only those capabilities. */
export function bindWorkspacePort<S extends Selection>(
  graph: WorkspacePort<S>,
  selection: S,
): WorkspacePort<S> {
  let bindings = cache.get(graph);
  if (!bindings) {
    bindings = new WeakMap();
    cache.set(graph, bindings);
  }
  const existing = bindings.get(selection);
  if (existing) return existing as WorkspacePort<S>;
  const port = {};
  for (const [name, fields] of Object.entries(selection)) {
    const owner = Reflect.get(graph, name);
    const group = {};
    for (const field of fields!)
      Object.defineProperty(group, field, {
        enumerable: true,
        get: () => Reflect.get(owner, field),
      });
    Object.defineProperty(port, name, { enumerable: true, value: Object.freeze(group) });
  }
  Object.freeze(port);
  bindings.set(selection, port);
  return port as WorkspacePort<S>;
}
