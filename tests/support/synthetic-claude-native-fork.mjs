// Runs installed Claude ACP + SDK against an isolated, owned synthetic store.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { forkSession } = await import('@agentclientprotocol/claude-agent-acp/dist/fork-session.js');
const { ClaudeAcpAgent, messageIdForGrouping } =
  await import('@agentclientprotocol/claude-agent-acp/dist/acp-agent.js');
const agentRequire = createRequire(
  require.resolve('@agentclientprotocol/claude-agent-acp/dist/lib.js'),
);
const { getSessionMessages } = await import(
  pathToFileURL(agentRequire.resolve('@anthropic-ai/claude-agent-sdk')).href
);
const [sourceCwd, targetCwd] = process.argv.slice(2);
const sessionId = randomUUID(),
  userOne = randomUUID(),
  assistantOne = randomUUID(),
  userTwo = randomUUID(),
  assistantTwo = randomUUID();
const projectDir = join(
  process.env.CLAUDE_CONFIG_DIR,
  'projects',
  sourceCwd.replace(/[^a-zA-Z0-9]/g, '-'),
);
mkdirSync(projectDir, { recursive: true });
const rows = [
  {
    type: 'user',
    uuid: userOne,
    parentUuid: null,
    message: { role: 'user', content: 'Synthetic first request' },
  },
  {
    type: 'assistant',
    uuid: assistantOne,
    parentUuid: userOne,
    message: {
      id: 'msg-first',
      role: 'assistant',
      model: 'synthetic-model',
      content: [{ type: 'text', text: 'Synthetic first answer' }],
    },
  },
  {
    type: 'user',
    uuid: userTwo,
    parentUuid: assistantOne,
    message: { role: 'user', content: 'Synthetic later request' },
  },
  {
    type: 'assistant',
    uuid: assistantTwo,
    parentUuid: userTwo,
    message: {
      id: 'msg-later',
      role: 'assistant',
      model: 'synthetic-model',
      content: [{ type: 'text', text: 'Synthetic later answer' }],
    },
  },
].map((row) => ({
  ...row,
  sessionId,
  cwd: sourceCwd,
  timestamp: '2026-01-01T00:00:00Z',
  isSidechain: false,
}));
const sourcePath = join(projectDir, sessionId + '.jsonl'),
  original = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
writeFileSync(sourcePath, original);
const logger = { log() {}, warn() {}, error() {} };
const forked = await forkSession(
  {
    sessionId,
    cwd: sourceCwd,
    _meta: { jetbrains: { air: { fork: { version: 1, messageId: 'msg-first' } } } },
  },
  {
    logger,
    messageIdForGrouping,
  },
);
assert.notEqual(forked.sessionId, sessionId);
const history = await getSessionMessages(forked.sessionId, { dir: sourceCwd });
assert.equal(history.length, 2);
assert.equal(history[1].message.id, 'msg-first');
assert.notEqual(history[1].uuid, assistantOne);
const childPath = join(projectDir, forked.sessionId + '.jsonl'),
  beforeLoad = readFileSync(childPath, 'utf8');
const replay = [];
const agent = new ClaudeAcpAgent(
  {
    sessionUpdate: async (value) => replay.push(value),
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  },
  logger,
);
try {
  await agent.loadSession({ sessionId: forked.sessionId, cwd: targetCwd, mcpServers: [] });
  assert.equal(agent.sessions[forked.sessionId].cwd, targetCwd);
  const launch = readFileSync(process.env.MOOR_SYNTHETIC_CLI_REPORT, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  const call = launch.find((row) => row.kind === 'launch');
  assert.equal(call.cwd, targetCwd);
  assert(call.args.includes('--resume=' + forked.sessionId));
  assert(!call.args.includes('--resume=' + sessionId));
  assert.equal(
    launch.some((row) => row.kind === 'unexpected-prompt'),
    false,
  );
  const messages = replay.filter((row) => row.update.sessionUpdate === 'agent_message_chunk');
  assert(messages.some((row) => row.update.messageId === 'msg-first'));
  assert(!messages.some((row) => row.update.messageId === 'msg-later'));
  assert(replay.every((row) => row.sessionId === forked.sessionId));
  assert.equal(readFileSync(sourcePath, 'utf8'), original);
  assert.equal(readFileSync(childPath, 'utf8'), beforeLoad);
  process.stdout.write(
    JSON.stringify({
      nativeFork: true,
      inclusiveCutoff: true,
      targetLoad: true,
      sourceUnchanged: true,
      noPrompt: true,
    }),
  );
} finally {
  for (const id of Object.keys(agent.sessions)) await agent.teardownSession(id);
}
