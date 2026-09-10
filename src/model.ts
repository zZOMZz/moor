import { LoroDoc, VersionVector } from 'loro-crdt';
import { Flock } from '@loro-dev/flock-wasm/base64';
import { Mirror } from 'loro-mirror';
import { sessionDocSchema } from '@lody/shared';
export { LoroDoc, VersionVector, Flock };
export const encode = (bytes: Uint8Array): string => {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
};
export const decode = (s: string): Uint8Array =>
  typeof Buffer !== 'undefined'
    ? new Uint8Array(Buffer.from(s, 'base64'))
    : Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const vv = (d: LoroDoc) => encode(d.version().encode());
export function delta(d: LoroDoc, version?: string) {
  return encode(
    d.export({
      mode: 'update',
      from: version ? VersionVector.decode(decode(version)) : new VersionVector(new Map()),
    }),
  );
}
export function mirror(doc: LoroDoc, sessionId: string) {
  return new Mirror({
    doc,
    schema: sessionDocSchema,
    ignoreUnknownProperties: true,
    initialState: { session: { id: sessionId as never }, history: [] },
  });
}
export function metas(flock: Flock): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const row of flock.scan({ prefix: ['m'] })) {
    const [, docId, field] = row.key;
    if (typeof docId === 'string' && typeof field === 'string' && row.value !== undefined)
      (result[docId] ??= {})[field] = row.value;
  }
  return result;
}
export function putMeta(flock: Flock, docId: string, fields: Record<string, unknown>) {
  flock.set(['e', docId], true);
  for (const [k, v] of Object.entries(fields))
    if (v !== undefined) flock.set(['m', docId, k], v as never);
  flock.commit();
}
