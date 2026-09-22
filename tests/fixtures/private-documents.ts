import { writeFileSync } from 'node:fs';
import { PRIVATE_ENDPOINT_FILE_FORMAT } from '@moor/protocol/private-content';

/** Synthetic retained formats. No keys, credentials, accounts or security runtime are created. */
export function writePrivateDocument(path: string, value: unknown) {
  writeFileSync(
    path,
    JSON.stringify({ format: PRIVATE_ENDPOINT_FILE_FORMAT, revision: 1, value }),
    {
      mode: 0o600,
    },
  );
}

export function writePrivateArtifacts(device: string, code: string, capsule: string) {
  writePrivateDocument(device, {
    kind: 'synthetic-retired-device',
    privateKey: 'SYNTHETIC_PRIVATE',
  });
  writePrivateDocument(code, { kind: 'synthetic-retired-code', recoveryCode: 'SYNTHETIC_PRIVATE' });
  writePrivateDocument(capsule, {
    kind: 'synthetic-retired-capsule',
    capsule: 'SYNTHETIC_PRIVATE',
  });
}
