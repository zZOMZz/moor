// Only Moor's known, identity-scoped cache namespaces. No arbitrary IDB key API.
const gitNamespaces = [
  'git-workspace-v1',
  'session-fork-v1',
  'github-binding-v1',
  'github-write-v1',
  'project-preview-v1',
  'preview-annotations-v1',
  'roles-outbox-v1',
  'role-applied-v1',
  'task-draft-v1',
  'skills-v1',
];
const contentNamespaces = [
  'attachment-draft-v1',
  'interaction-v1',
  'project-content-v1',
  'file-content-v1',
];
const prefix = (namespace, parts) => namespace + '/' + JSON.stringify(parts).slice(0, -1) + ',';
function legacyExtensionPrefixes(target) {
  const content = [target.owner, target.deviceId, target.workspaceId, target.localProjectId];
  const git = [
    target.owner,
    target.deviceId,
    target.userId,
    target.machineId,
    target.workspaceId,
    target.localProjectId,
  ];
  return [
    ...contentNamespaces.map((name) => prefix(name, content)),
    ...gitNamespaces.map((name) => prefix(name, git)),
    prefix('mcp-draft-v1', [
      target.owner,
      target.deviceId,
      target.userId,
      target.machineId,
      target.workspaceId,
      target.catalogWorkspaceId,
      target.replicaId,
      target.localProjectId,
    ]),
  ];
}
function legacyAttentionPrefix(target, origin, actor) {
  if (!actor || actor.accountId !== target.owner) return;
  const scope = JSON.stringify([
    'attention-v1',
    origin,
    JSON.stringify([actor.kind, actor.authorityId, actor.accountId]),
    target.machineId,
    target.workspaceId,
    target.localProjectId,
  ]);
  return JSON.stringify([scope]).slice(0, -1) + ',';
}
function legacyCachePrefixes(target, origin, actor) {
  const attention = legacyAttentionPrefix(target, origin, actor);
  return [
    [target.owner, target.deviceId, target.workspaceId, ''].join('/'),
    ...legacyExtensionPrefixes(target),
    'attachment-session-v1/' +
      JSON.stringify([target.owner, target.deviceId, target.workspaceId, target.localProjectId]),
    ...(attention ? [attention] : []),
  ];
}
function legacySessionExtensionKeys(target, sessionId) {
  return legacyExtensionPrefixes(target).map((key) => key + JSON.stringify(sessionId) + ']');
}
module.exports = { legacyCachePrefixes, legacySessionExtensionKeys, legacyAttentionPrefix };

const legacySessionId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
function legacyReadSelection(target, origin, actor, selection) {
  const attention = legacyAttentionPrefix(target, origin, actor);
  if (!selection) return { prefixes: legacyCachePrefixes(target, origin, actor) };
  const root = [target.owner, target.deviceId, target.workspaceId, ''].join('/');
  const sessionPrefixes = [...legacyExtensionPrefixes(target), ...(attention ? [attention] : [])];
  const actionPrefix = root + target.localProjectId + '/';
  if (selection.kind === 'session' && legacySessionId(selection.sessionId))
    return {
      prefixes: [
        root + selection.sessionId + '/',
        actionPrefix + selection.sessionId + '/session-action',
        ...sessionPrefixes.map((prefix) => prefix + JSON.stringify(selection.sessionId)),
      ],
    };
  if (selection.kind !== 'new') throw Error('Unknown legacy selection');
  const reservationKey =
    'attachment-session-v1/' +
    JSON.stringify([target.owner, target.deviceId, target.workspaceId, target.localProjectId]);
  return {
    prefixes: [root + 'new/', reservationKey],
    newDraft: {
      reservationKey,
      pendingKey: root + 'new/pending',
      sessionPrefixes,
      actionPrefix,
    },
  };
}
function legacyInventory(target, origin, actor, keys) {
  const attention = legacyAttentionPrefix(target, origin, actor);
  const root = [target.owner, target.deviceId, target.workspaceId, ''].join('/');
  const prefixes = [...legacyExtensionPrefixes(target), ...(attention ? [attention] : [])];
  const allowed = legacyCachePrefixes(target, origin, actor);
  const ids = new Set();
  let hasNew = false;
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.some((prefix) => key.startsWith(prefix)))
      throw Error('Foreign legacy key');
    if (key.startsWith('attachment-session-v1/')) {
      hasNew = true;
      continue;
    }
    if (key.startsWith(root)) {
      const parts = key.slice(root.length).split('/');
      if (parts[0] === 'new') {
        hasNew = true;
        continue;
      }
      const id =
        parts.at(-1) === 'session-action'
          ? parts.length === 3 && parts[0] === target.localProjectId
            ? parts[1]
            : undefined
          : parts[0];
      if (legacySessionId(id)) ids.add(id);
      continue;
    }
    for (const prefix of prefixes) {
      if (!key.startsWith(prefix)) continue;
      const match = /^("(?:[^"\\]|\\.)*")(?=[,\]])/.exec(key.slice(prefix.length));
      if (match) {
        const id = JSON.parse(match[1]);
        if (legacySessionId(id)) ids.add(id);
      }
    }
  }
  return { sessionIds: [...ids].sort(), hasNew };
}
module.exports.legacyReadSelection = legacyReadSelection;
module.exports.legacyInventory = legacyInventory;
