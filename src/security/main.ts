import { isAbsolute } from 'node:path';
import {
  DEVICE_SECURITY_FAILED,
  DEVICE_SECURITY_MAX_BYTES,
  runDeviceSecurityCommand,
} from './commands';

async function main() {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--data-file' || !isAbsolute(args[1])) throw new Error();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > DEVICE_SECURITY_MAX_BYTES) throw new Error();
      chunks.push(bytes);
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(chunks),
    );
    const result = await runDeviceSecurityCommand(JSON.parse(text), { dataFile: args[1] });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    process.stderr.write(DEVICE_SECURITY_FAILED + '\n');
    process.exitCode = 1;
  }
}

await main();
