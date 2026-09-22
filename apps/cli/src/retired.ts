import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
  writeFileSync,
  fsyncSync,
  unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { PRIVATE_ENDPOINT_FILE_FORMAT } from '@moor/protocol/private-content';
import { CliError } from './args';
import type { CliState } from './state';

/** Copies an opaque original to a new private file. There is deliberately no import or dispatch. */
export function exportRetiredOperation(
  state: CliState,
  operationId: string,
  output: string,
  current: () => void,
) {
  let file: number | undefined;
  let directory: number | undefined;
  let created: { dev: number; ino: number } | undefined;
  try {
    current();
    if (!isAbsolute(output) || resolve(output) !== output) throw Error();
    const parent = dirname(output);
    const before = lstatSync(parent);
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      (before.mode & 0o777) !== 0o700 ||
      (process.getuid && before.uid !== process.getuid()) ||
      realpathSync(parent) !== parent
    )
      throw Error();
    directory = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = fstatSync(directory);
    if (before.dev !== opened.dev || before.ino !== opened.ino) throw Error();
    const archive = state.retiredArchive(operationId);
    current();
    const content =
      JSON.stringify({ format: PRIVATE_ENDPOINT_FILE_FORMAT, revision: 1, value: archive }) + '\n';
    const parentCurrent = lstatSync(parent);
    if (
      parentCurrent.dev !== before.dev ||
      parentCurrent.ino !== before.ino ||
      parentCurrent.mode !== before.mode ||
      parentCurrent.uid !== before.uid ||
      realpathSync(parent) !== parent
    )
      throw Error();
    file = openSync(
      output,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = fstatSync(file);
    writeFileSync(file, content);
    fsyncSync(file);
    current();
    const saved = lstatSync(output);
    const finalParent = lstatSync(parent);
    if (
      saved.dev !== created.dev ||
      saved.ino !== created.ino ||
      saved.nlink !== 1 ||
      (saved.mode & 0o777) !== 0o600 ||
      finalParent.dev !== before.dev ||
      finalParent.ino !== before.ino ||
      finalParent.mode !== before.mode ||
      finalParent.uid !== before.uid ||
      realpathSync(parent) !== parent
    )
      throw Error();
    fsyncSync(directory);
    return { offline: true, outputFile: output, operationId, records: archive.records.length };
  } catch {
    // Only remove this invocation's incomplete output; never touch an existing or replaced file.
    if (created) {
      try {
        const value = lstatSync(output);
        if (value.dev === created.dev && value.ino === created.ino) unlinkSync(output);
      } catch {}
    }
    throw new CliError(
      'retired-export',
      '离线导出未完成；请保留原私有数据库，使用新的私有文件路径重试。',
      1,
    );
  } finally {
    if (file !== undefined) closeSync(file);
    if (directory !== undefined) closeSync(directory);
  }
}
