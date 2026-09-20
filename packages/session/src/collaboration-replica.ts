import { z } from 'zod';
import {
  collaborationKey,
  collaborationOperationSchema,
  taskStateSchema,
  type CollaborationScope,
  type CollaborationOperation,
  type TaskState,
} from '@moor/protocol/collaboration-protocol';
import { LoroDoc, decode, encode, delta, vv } from './model';

/** Moor TaskDoc v1: shared authoring, durable intents and Host-authored execution projections. */
export class CollaborationReplica {
  readonly doc = new LoroDoc();
  constructor(
    readonly scope: CollaborationScope,
    snapshot?: string,
    peerId?: string,
  ) {
    try {
      if (snapshot) this.import(snapshot);
      if (peerId) this.doc.setPeerId(peerId as `${number}`);
      const identity = this.doc.getMap('identity');
      if (identity.get('scope') === undefined) {
        identity.set('scope', collaborationKey(scope));
        identity.set('schemaVersion', 1);
        this.doc.commit();
      }
      this.view();
    } catch (error) {
      this.doc.free();
      throw error;
    }
  }
  get peerId() {
    return this.doc.peerIdStr;
  }
  get version() {
    return vv(this.doc);
  }
  snapshot() {
    return encode(this.doc.export({ mode: 'snapshot' }));
  }
  export(version?: string) {
    return { schemaVersion: 1 as const, update: delta(this.doc, version), version: this.version };
  }
  import(update: string) {
    if (this.doc.import(decode(update)).pending?.size) throw Error('协作文档增量缺少前置版本');
  }
  close() {
    this.doc.free();
  }
  view() {
    if (
      Object.keys(this.doc.toJSON()).some(
        (key) => !['identity', 'operations', 'tasks', 'admissions'].includes(key),
      )
    )
      throw Error('协作文档包含不支持的字段');
    const identity = this.doc.getMap('identity');
    if (
      identity.get('scope') !== collaborationKey(this.scope) ||
      identity.get('schemaVersion') !== 1
    )
      throw Error('协作文档的版本或身份不匹配');
    const operations = Object.entries(this.doc.getMap('operations').toJSON())
      .map(([key, value]) => {
        const operation = collaborationOperationSchema.parse(JSON.parse(z.string().parse(value)));
        if (
          operation.operationId !== key ||
          collaborationKey(operation.scope) !== collaborationKey(this.scope)
        )
          throw Error('协作文档包含其他范围的输入');
        return operation;
      })
      .sort((a, b) => (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0));
    const tasks = Object.entries(this.doc.getMap('tasks').toJSON()).map(([key, value]) => {
      const task = taskStateSchema.parse(JSON.parse(z.string().parse(value)));
      if (task.taskId !== key || collaborationKey(task.scope) !== collaborationKey(this.scope))
        throw Error('协作文档包含其他范围的执行状态');
      return task;
    });
    const admissions = z
      .record(z.number().int().positive().safe())
      .parse(this.doc.getMap('admissions').toJSON());
    const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
    if (
      Object.keys(admissions).some((id) => !byId.has(id)) ||
      tasks.some((task) => byId.get(task.taskId)?.kind !== 'submit')
    )
      throw Error('协作文档的执行状态或接受记录缺少原意图');
    return { operations, tasks: tasks.sort((a, b) => a.sequence - b.sequence), admissions };
  }
  append(raw: CollaborationOperation, sequence?: number) {
    const operation = collaborationOperationSchema.parse(raw);
    if (collaborationKey(operation.scope) !== collaborationKey(this.scope))
      throw Error('协作输入范围不匹配');
    const map = this.doc.getMap('operations'),
      existing = map.get(operation.operationId),
      json = JSON.stringify(operation);
    if (existing !== undefined && existing !== json) throw Error('协作操作编号对应不同内容');
    if (existing === undefined) map.set(operation.operationId, json);
    if (sequence !== undefined) {
      const admissions = this.doc.getMap('admissions'),
        before = admissions.get(operation.operationId);
      if (before !== undefined && before !== sequence) throw Error('协作输入的接受顺序不匹配');
      if (before === undefined) admissions.set(operation.operationId, sequence);
    }
    this.doc.commit();
  }
  publishExecution(raw: TaskState) {
    const task = taskStateSchema.parse(raw);
    if (collaborationKey(task.scope) !== collaborationKey(this.scope))
      throw Error('执行状态范围不匹配');
    const map = this.doc.getMap('tasks'),
      existing = map.get(task.taskId);
    if (existing !== undefined) {
      const previous = taskStateSchema.parse(JSON.parse(z.string().parse(existing)));
      if (task.revision < previous.revision) return;
      if (task.revision === previous.revision) {
        if (JSON.stringify(task) !== JSON.stringify(previous))
          throw Error('同一执行版本对应不同内容');
        return;
      }
    }
    map.set(task.taskId, JSON.stringify(task));
    this.doc.commit();
  }
}
