import { z } from 'zod';
import { secureTargetSchema, type SecureCliTarget } from '../cli/secure-operation';
import { productCanonicalJson } from '../security/encrypted-product-catalog';
import { gitTargetSchema, gitWorkspaceKey, type GitWorkspaceDependencies } from './git-workspace';
import { SecureStore } from './secure-store';

const canonical = productCanonicalJson;
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const LIMIT_BYTES = 96 * 1024 * 1024;
const prefixes = [
  'git-workspace-v1/',
  'session-fork-v1/',
  'github-binding-v1/',
  'github-write-v1/',
  'project-preview-v1/',
  'preview-annotations-v1/',
  'run-options-v1/',
] as const;
const namespaces = [
  'git',
  'fork',
  'github',
  'github-write',
  'preview',
  'preview-annotations',
  'execution',
  'run-options',
] as const;
type Namespace = (typeof namespaces)[number];
const recordSchema = z
  .object({
    target: secureTargetSchema,
    key: z.string().min(1).max(16000),
    value: z
      .object({ cacheRevision: z.number().int().nonnegative().safe(), target: gitTargetSchema })
      .passthrough(),
  })
  .strict();
const documentSchema = z
  .object({
    revision: z.number().int().nonnegative().safe(),
    records: z.array(recordSchema).max(256),
  })
  .strict();
export type SecureScopedRecord = z.infer<typeof recordSchema>;
export function secureGitTarget(input: SecureCliTarget) {
  const target = secureTargetSchema.parse(input);
  if (!target.product) throw Error('扩展草稿必须绑定已确认的产品副本。');
  return gitTargetSchema.parse({
    owner: target.owner,
    deviceId: target.hostDeviceId,
    userId: target.userId,
    machineId: target.machineId,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId: target.sessionId,
    catalogWorkspaceId: target.product.catalogWorkspaceId,
    replicaId: target.product.replicaId,
  });
}
export function sameSecureRuntime(left: SecureCliTarget, right: SecureCliTarget) {
  const { product: _left, ...a } = secureTargetSchema.parse(left);
  const { product: _right, ...b } = secureTargetSchema.parse(right);
  return same(a, b);
}
export function sameSecureRuntimeProject(left: SecureCliTarget, right: SecureCliTarget) {
  const { product: _left, sessionId: _leftSession, ...a } = secureTargetSchema.parse(left);
  const { product: _right, sessionId: _rightSession, ...b } = secureTargetSchema.parse(right);
  return same(a, b);
}
function authority(target: SecureCliTarget) {
  const { origin, owner, rootKeyId, clientDeviceId } = secureTargetSchema.parse(target);
  return { origin, owner, rootKeyId, clientDeviceId };
}
function storageKey(target: SecureCliTarget) {
  return canonical(['moor-secure-extension-documents-v1', authority(target)]);
}
function validKey(target: SecureCliTarget, key: string) {
  const legacy = gitWorkspaceKey(secureGitTarget(target));
  if (!prefixes.some((prefix) => key === legacy.replace('git-workspace-v1/', prefix)))
    throw Error('扩展记录键不属于此完整执行身份。');
}
function validateRecord(record: SecureScopedRecord) {
  validKey(record.target, record.key);
  const projected = secureGitTarget(record.target);
  if (!same(projected, record.value.target)) throw Error('扩展记录的内外执行身份不一致。');
  const originals: unknown[] = [record.value.pending, record.value.operation];
  if (record.key.startsWith('session-fork-v1/') && Array.isArray(record.value.resources))
    for (const resource of record.value.resources)
      if (resource && typeof resource === 'object' && 'operation' in resource)
        originals.push(resource.operation);
  for (const pending of originals)
    if (
      pending &&
      typeof pending === 'object' &&
      'target' in pending &&
      !same(pending.target, projected)
    )
      throw Error('待确认扩展操作不属于原执行身份。');
}

/** Isolated records for finite controllers. Legacy cache keys never address legacy storage. */
export class SecureScopedStorage {
  constructor(readonly store: SecureStore) {}
  async #load(target: SecureCliTarget, current: () => void) {
    current();
    const key = storageKey(target),
      raw = (await this.store.backend.read(key)) ?? null;
    current();
    if (new TextEncoder().encode(canonical(raw)).byteLength > LIMIT_BYTES)
      throw Error('本机扩展草稿存储超出限制，请先整理已完成记录。');
    const document = raw === null ? { revision: 0, records: [] } : documentSchema.parse(raw);
    const seen = new Set<string>();
    for (const record of document.records) {
      validateRecord(record);
      const id = canonical([record.target, record.key]);
      if (!same(authority(target), authority(record.target)) || seen.has(id))
        throw Error('本机扩展记录身份或唯一性校验失败。');
      seen.add(id);
    }
    return { key, raw, document };
  }
  async list(input: SecureCliTarget, current: () => void): Promise<SecureScopedRecord[]> {
    const target = secureTargetSchema.parse(input);
    const loaded = await this.#load(target, current);
    current();
    return structuredClone(
      loaded.document.records.filter((record) => sameSecureRuntime(record.target, target)),
    );
  }
  /** A Fork's original source row also protects its child within the same runtime project. */
  async listProject(input: SecureCliTarget, current: () => void): Promise<SecureScopedRecord[]> {
    const target = secureTargetSchema.parse(input);
    const loaded = await this.#load(target, current);
    current();
    return structuredClone(
      loaded.document.records.filter((record) => sameSecureRuntimeProject(record.target, target)),
    );
  }
  async read(input: SecureCliTarget, key: string, current: () => void): Promise<unknown> {
    const target = secureTargetSchema.parse(input);
    validKey(target, key);
    const loaded = await this.#load(target, current);
    current();
    return structuredClone(
      loaded.document.records.find((record) => same(record.target, target) && record.key === key)
        ?.value,
    );
  }
  async compareWrite<T extends { cacheRevision: number }>(
    input: SecureCliTarget,
    key: string,
    expectedRevision: number,
    value: T,
    current: () => void,
  ): Promise<boolean> {
    const target = secureTargetSchema.parse(input);
    validKey(target, key);
    const record = recordSchema.parse({ target, key, value: structuredClone(value) });
    validateRecord(record);
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      record.value.cacheRevision !== expectedRevision + 1
    )
      throw Error('扩展记录版本不连续。');
    current();
    return this.store.backend.exclusive(
      canonical(['moor-secure-extension-save-v1', authority(target)]),
      current,
      async () => {
        const loaded = await this.#load(target, current);
        const index = loaded.document.records.findIndex(
          (row) => same(row.target, target) && row.key === key,
        );
        if (
          (index < 0 ? 0 : loaded.document.records[index].value.cacheRevision) !== expectedRevision
        )
          return false;
        const records = loaded.document.records.slice();
        if (index < 0) records.push(record);
        else records[index] = record;
        const next = documentSchema.parse({ revision: loaded.document.revision + 1, records });
        if (new TextEncoder().encode(canonical(next)).byteLength > LIMIT_BYTES)
          throw Error('本机扩展草稿存储超出限制，尚未派发。');
        current();
        await this.store.backend.compareAndSet(loaded.key, loaded.raw, next, current);
        current();
        return true;
      },
    );
  }
  forTarget(
    input: SecureCliTarget,
    current: () => void,
  ): Pick<GitWorkspaceDependencies, 'read' | 'compareWrite'> {
    const target = secureTargetSchema.parse(input);
    secureGitTarget(target);
    return {
      read: (key) => this.read(target, key, current),
      compareWrite: (key, revision, value, alive) =>
        this.compareWrite(target, key, revision, value, () => {
          current();
          if (!alive()) throw Error('扩展面板或执行范围已改变，未保存迟到结果。');
        }),
    };
  }
  exclusive<T>(
    input: SecureCliTarget,
    namespace: Namespace,
    current: () => void,
    task: () => Promise<T>,
  ): Promise<T> {
    const target = secureTargetSchema.parse(input);
    secureGitTarget(target);
    if (!namespaces.includes(namespace)) throw Error('不支持的扩展操作锁。');
    const { product: _product, ...runtime } = target;
    return this.store.backend.exclusive(
      canonical(['moor-secure-extension-lock-v1', runtime, namespace]),
      current,
      task,
    );
  }
}
