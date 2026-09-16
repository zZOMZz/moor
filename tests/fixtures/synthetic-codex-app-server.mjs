// Native Codex App Server test peer. Never accesses an agent account or user files.
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const models = [
  {
    id: 'a',
    model: 'a',
    displayName: 'Model A',
    description: 'Synthetic A',
    isDefault: true,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }],
  },
  {
    id: 'b',
    model: 'b',
    displayName: 'Model B',
    description: 'Synthetic B',
    isDefault: false,
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: [
      { reasoningEffort: 'high', description: 'High' },
      { reasoningEffort: 'max', description: 'Max' },
    ],
  },
];
let turn = 0;
const bucket = {
  limitId: 'codex',
  limitName: 'Codex',
  primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 2_000_000_000 },
  secondary: { usedPercent: 65, windowDurationMins: 10080, resetsAt: 2_000_400_000 },
};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line),
    { id, method, params } = message;
  if (process.env.MOOR_SYNTHETIC_LOG)
    appendFileSync(process.env.MOOR_SYNTHETIC_LOG, JSON.stringify(message) + '\n');
  if (id === undefined) return;
  let result;
  switch (method) {
    case 'initialize':
      result = { userAgent: 'synthetic', platformFamily: 'unix', platformOs: 'synthetic' };
      break;
    case 'account/read':
      result = {
        requiresOpenaiAuth: true,
        account: process.env.MOOR_SYNTHETIC_SIGNED_OUT
          ? null
          : { type: 'chatgpt', email: 'synthetic@example.invalid', planType: 'plus' },
      };
      break;
    case 'account/rateLimits/read':
      result = { rateLimits: bucket, rateLimitsByLimitId: { codex: bucket } };
      break;
    case 'config/read':
      result = { config: {}, origins: {}, layers: [] };
      break;
    case 'skills/list':
      result = { data: [] };
      break;
    case 'skills/extraRoots/set':
      result = {};
      break;
    case 'model/list':
      result = { data: models, nextCursor: null };
      break;
    case 'thread/start':
      result = {
        thread: { id: 'synthetic-thread', turns: [] },
        model: 'a',
        reasoningEffort: 'low',
        modelProvider: 'openai',
      };
      break;
    case 'turn/start': {
      const active = {
        id: 'synthetic-turn-' + ++turn,
        status: 'inProgress',
        items: [],
        error: null,
      };
      send({ id, result: { turn: active } });
      send({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: params.threadId,
          turnId: active.id,
          tokenUsage: {
            modelContextWindow: 1000,
            last: {
              totalTokens: 410,
              inputTokens: 400,
              cachedInputTokens: 50,
              outputTokens: 10,
              reasoningOutputTokens: 0,
            },
            total: {
              totalTokens: 410 * turn,
              inputTokens: 400 * turn,
              cachedInputTokens: 50 * turn,
              outputTokens: 10 * turn,
              reasoningOutputTokens: 0,
            },
          },
        },
      });
      send({
        method: 'account/rateLimits/updated',
        params: { rateLimits: { ...bucket, primary: { ...bucket.primary, usedPercent: 29 } } },
      });
      send({
        method: 'turn/completed',
        params: { threadId: params.threadId, turn: { ...active, status: 'completed' } },
      });
      return;
    }
    default:
      send({ id, error: { code: -32601, message: 'Unsupported synthetic method: ' + method } });
      return;
  }
  send({ id, result });
});
