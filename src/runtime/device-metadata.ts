import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  deviceMetadataActionSchema,
  deviceMetadataSchema,
  type DeviceMetadata,
} from '../device-metadata';
import { assert, id } from '../protocol';
import type { RuntimeStore } from './store';

const key = 'device-metadata-v1';
const savedSchema = z
  .object({
    identity: z
      .object({ workspaceId: id, machineId: id, userId: z.string().min(1).max(200) })
      .strict(),
    metadata: deviceMetadataSchema,
  })
  .strict();

/** Host-owned display state. Reading or publishing it never invokes an Agent. */
export class HostDeviceMetadata {
  constructor(
    private store: RuntimeStore,
    initialName: string,
  ) {
    if (!store.load(key))
      this.save(deviceMetadataSchema.parse({ version: 1, name: initialName, revision: 1 }));
    this.read();
  }
  private identity() {
    const { id: workspaceId, machineId, userId } = this.store.workspace;
    return { workspaceId, machineId, userId };
  }
  read(): DeviceMetadata {
    const saved = savedSchema.parse(
      JSON.parse(Buffer.from(this.store.load(key)!).toString('utf8')),
    );
    assert(isDeepStrictEqual(saved.identity, this.identity()), 409, '电脑名称的执行身份已变化');
    return saved.metadata;
  }
  private save(metadata: DeviceMetadata) {
    this.store.save(key, Buffer.from(JSON.stringify({ identity: this.identity(), metadata })));
  }
  handle(input: unknown) {
    const action = deviceMetadataActionSchema.parse(input);
    return this.store.transaction(() => {
      const previous = this.read();
      if (action.action === 'read') return previous;
      assert(
        action.expectedRevision === previous.revision,
        409,
        '电脑名称已更新，请重新读取后保存',
      );
      if (action.name === previous.name) return previous;
      const next = deviceMetadataSchema.parse({
        ...previous,
        name: action.name,
        revision: previous.revision + 1,
      });
      this.save(next);
      return next;
    });
  }
}
