import { buildRuntime } from './runtime-build.mjs';

const target = process.argv[2] ?? 'all';
if (!['all', 'relay', 'host', 'client'].includes(target))
  throw Error('Choose all, relay, host or client');
await buildRuntime(target === 'all' ? ['relay', 'host', 'client'] : [target]);
if (target === 'all' || target === 'relay') await import('./build-web.mjs');
