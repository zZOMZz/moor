import { build } from 'electron-vite';
import { join } from 'node:path';
import { buildDesktopRuntime } from './desktop-runtime.mjs';
import { repository } from './workspace-sources.mjs';

process.chdir(repository);
await build();
const runtime = await buildDesktopRuntime({ appRoot: join(repository, 'dist/desktop') });
await runtime.dispose();
