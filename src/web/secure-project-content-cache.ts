import { secureTargetSchema, type SecureCliTarget } from '../cli/secure-operation';
import { ScopedProjectContentCache } from './scoped-project-content-cache';
import { IndexedSecureStorage, type SecureStorageBackend } from './secure-store';

export class SecureProjectContentCache extends ScopedProjectContentCache<SecureCliTarget> {
  constructor(backend: SecureStorageBackend = new IndexedSecureStorage()) {
    super(
      {
        namespace: 'moor-secure-project-content-v1',
        parseTarget(input) {
          const target = secureTargetSchema.parse(input);
          if (!target.product) throw Error('文件缓存必须绑定已确认的项目副本。');
          return target;
        },
        authority(target) {
          const { origin, owner, rootKeyId, clientDeviceId } = target;
          return { origin, owner, rootKeyId, clientDeviceId };
        },
      },
      backend,
    );
  }
}
