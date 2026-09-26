// Independent, deterministic ACP-shaped output producer. No models or project access.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const plan = JSON.parse(process.env.MOOR_STREAM_PLAN);
const now = () => performance.timeOrigin + performance.now();
const count = Math.max(1, Math.round((plan.durationMs * plan.rate) / 1000));
const start = now();
let sequence = 0;
let text = '';
const events = [];
function produce() {
  const due = Math.min(count, Math.floor(((now() - start) * plan.rate) / 1000) + 1);
  while (sequence < due) {
    sequence++;
    const number = String(sequence).padStart(6, '0');
    const prefix = `// SEQ:${number}\nexport const item${number} = "`;
    const boundary = sequence > 1 && (sequence - 1) % 64 === 0 ? '\n```\n\n```ts\n' : '';
    const chunk =
      boundary + prefix + 'x'.repeat(Math.max(0, plan.chunkBytes - prefix.length - 3)) + '";\n';
    text += chunk;
    const event = {
      type: 'chunk',
      sequence,
      plannedAt: start + ((sequence - 1) * 1000) / plan.rate,
      producedAt: now(),
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } },
    };
    events.push({ sequence, plannedAt: event.plannedAt, producedAt: event.producedAt });
    process.send(event);
  }
  if (sequence === count) {
    const done = {
      type: 'done',
      count,
      producedAt: now(),
      sha256: createHash('sha256').update(text).digest('hex'),
    };
    writeFileSync(
      process.env.MOOR_STREAM_PRODUCER_REPORT,
      JSON.stringify({ plan, start, events, ...done }),
    );
    process.send(done, (error) => {
      if (error) throw error;
      process.disconnect();
    });
    return;
  }
  // Fixed schedule: no acknowledgement or renderer result influences production.
  setTimeout(produce, Math.max(0, start + (sequence * 1000) / plan.rate - now()));
}
produce();
