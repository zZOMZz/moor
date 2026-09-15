import { z } from 'zod';
import { runSelectionSchema, type RunSelection } from '@moor/protocol/run-config';
import type { SecureCliTarget } from '@moor/client/secure-operation';
import { productCanonicalJson } from '@moor/client/encrypted-product';
import { gitTargetSchema, gitWorkspaceKey } from '../features/git/git-workspace';
import { SecureScopedStorage, secureGitTarget } from './secure-scoped-storage';

const recordSchema = z
  .object({
    target: gitTargetSchema,
    cacheRevision: z.number().int().nonnegative().safe(),
    baseTurnId: z.string().max(300),
    selection: runSelectionSchema,
  })
  .strict();
export type SecureRunOptions = Pick<
  z.infer<typeof recordSchema>,
  'cacheRevision' | 'baseTurnId' | 'selection'
> & { inherited: boolean };
const clean = (input: RunSelection) => runSelectionSchema.parse(JSON.parse(JSON.stringify(input)));
const same = (a: unknown, b: unknown) => productCanonicalJson(a) === productCanonicalJson(b);
const key = (target: SecureCliTarget) =>
  gitWorkspaceKey(secureGitTarget(target)).replace('git-workspace-v1/', 'run-options-v1/');

export class SecureRunOptionsStore {
  constructor(private storage: SecureScopedStorage) {}
  async read(
    target: SecureCliTarget,
    baseTurnId: string,
    fallback: RunSelection,
    current: () => void,
  ): Promise<SecureRunOptions> {
    const raw = await this.storage.read(target, key(target), current);
    const saved = raw === undefined ? undefined : recordSchema.parse(raw);
    return {
      cacheRevision: saved?.cacheRevision ?? 0,
      baseTurnId,
      inherited: saved?.baseTurnId !== baseTurnId,
      selection: saved?.baseTurnId === baseTurnId ? saved.selection : clean(fallback),
    };
  }
  async save(
    target: SecureCliTarget,
    shown: SecureRunOptions,
    selection: RunSelection,
    current: () => void,
  ) {
    return this.storage.exclusive(target, 'run-options', current, async () => {
      const actual = await this.read(target, shown.baseTurnId, shown.selection, current);
      if (!same(actual, shown)) throw Error('模型草稿已在另一页面改变，请重新读取会话。');
      const next = {
        ...shown,
        cacheRevision: shown.cacheRevision + 1,
        selection: clean(selection),
        inherited: false,
      };
      const { inherited: _inherited, ...record } = next;
      if (
        !(await this.storage.compareWrite(
          target,
          key(target),
          shown.cacheRevision,
          { ...record, target: secureGitTarget(target) },
          current,
        ))
      )
        throw Error('模型草稿已改变，请重新读取会话。');
      return next;
    });
  }
  async verify(target: SecureCliTarget, shown: SecureRunOptions, current: () => void) {
    if (!same(await this.read(target, shown.baseTurnId, shown.selection, current), shown))
      throw Error('模型草稿已在另一页面改变，请重新读取后发送。');
  }
}
