import { open } from 'node:fs/promises';
import { CliError, type CliArgs } from './args';
export async function cliInput(
  args: CliArgs,
  stdin: AsyncIterable<Uint8Array | string>,
  limit = 1024 * 1024,
  required = true,
) {
  let source: AsyncIterable<Uint8Array | string>,
    file: Awaited<ReturnType<typeof open>> | undefined;
  if (args.flags.file) {
    file = await open(String(args.flags.file), 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) {
      await file.close();
      throw new CliError('input', '输入必须是限制大小内的普通文件。');
    }
    source = file.createReadStream({ autoClose: false });
  } else if (args.flags.stdin) source = stdin;
  else {
    if (required) throw new CliError('input', '请通过 --stdin 或 --file 明确提供正文。');
    return undefined;
  }
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of source) {
      const value = Buffer.from(chunk);
      size += value.length;
      if (size > limit) throw new CliError('input', '输入超过允许的大小。');
      chunks.push(value);
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      throw new CliError('input', '输入必须为 UTF-8 文本。');
    }
  } finally {
    await file?.close();
  }
}
