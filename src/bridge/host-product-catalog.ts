import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AppError, id } from '../protocol';
import {
  encryptedCatalogSchema,
  type EncryptedCatalog,
} from '../security/encrypted-bridge-protocol';
import type { EncryptedResource } from '../security/e2ee-channel';
import {
  ENCRYPTED_PRODUCT_REJECTED,
  encryptedProductActionSchema,
  encryptedProductAuthoritySchema,
  encryptedProductCatalogSchema,
  encryptedProductTargetSchema,
  productCanonicalJson,
  validateEncryptedProductReceipt,
  type EncryptedProductAction,
  type EncryptedProductAuthority,
  type EncryptedProductCatalog,
  type EncryptedProductInspection,
  type EncryptedProductReceipt,
  type EncryptedProductTarget,
} from '../security/encrypted-product-catalog';
import { hostCommandSchema, type HostCommand } from './host-command';

type Replica = EncryptedProductCatalog['replicas'][number];
const persistedSchema = z
  .object({
    catalog: encryptedProductCatalogSchema,
    hosts: z.record(id, id),
    roots: z.record(id, z.string().max(4096)),
    generations: z.record(id, z.number().int().positive().safe()),
  })
  .strict();
type Persisted = z.infer<typeof persistedSchema>;
type Operation = {
  operationId: string;
  original: unknown;
  recovery: boolean;
  inspection: boolean;
  historical: boolean;
};
type Claim = {
  authority: EncryptedProductAuthority;
  target: EncryptedProductTarget | null;
  workspaceId: string;
  localProjectId: string | null;
  sessionId: string | null;
  method: string;
  original: string;
  runtime: { machineId: string; userId: string; rootPath: string; generation: number };
};
const mappingSchema = z
  .object({
    authority: encryptedProductAuthoritySchema,
    target: encryptedProductTargetSchema,
    workspaceId: id,
    localProjectId: id,
    runtime: z
      .object({
        machineId: id,
        userId: z.string().min(1).max(160),
        rootPath: z.string().min(1).max(4096),
        generation: z.number().int().positive().safe(),
      })
      .strict(),
  })
  .strict();
const fileLeases = new Map<string, Map<string, number>>();
const memoryLeases = new WeakMap<DatabaseSync, Map<string, number>>();
let transactionId = 0;
const digest = (value: unknown) =>
  createHash('sha256').update(productCanonicalJson(value)).digest('hex');
function fail(): never {
  throw new AppError(409, ENCRYPTED_PRODUCT_REJECTED, true);
}
const requireTrue = (value: unknown): void => {
  if (!value) fail();
};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Normalize only explicit protocol recovery wrappers, never arbitrary user documents. */
function operationOf(command: HostCommand): Operation | undefined {
  let method: string = command.method;
  let original = object(command.params)!;
  let recovery = false,
    inspection = false,
    historical = true;
  if (command.method === 'session-operations') {
    method = {
      control: 'session-control',
      mutation: 'mutate',
      metadata: 'session-action',
      attachment: 'attachment-action',
    }[command.params.request.kind];
    original = command.params.request.value;
    recovery = true;
    inspection = command.params.action === 'inspect';
  } else if (
    ['github-write-inspect', 'github-write-abandon', 'preview-inspect', 'preview-close'].includes(
      command.method,
    )
  ) {
    method = command.method.startsWith('github') ? 'github-write-action' : 'preview-action';
    original = object(original.request)!;
    recovery = true;
    inspection = command.method.endsWith('inspect');
  } else if (command.method === 'github-abandon') {
    method = 'github-action';
    recovery = true;
  } else if (command.method === 'roles-action' && 'request' in command.params) {
    original = command.params.request;
    recovery = true;
    inspection = command.params.action === 'inspect';
  } else if (
    command.method === 'tasks-action' &&
    ['inspect', 'abandon'].includes(command.params.action)
  ) {
    // This API carries a task operation reference, not the original tool command.
    // It cannot prove an old product mapping or claim that tool operation's body.
    historical = false;
    recovery = true;
    inspection = command.params.action === 'inspect';
  }
  if (typeof original.operationId !== 'string') return undefined;
  return {
    operationId: original.operationId,
    original: { method, params: original },
    recovery,
    inspection,
    historical,
  };
}
function sessionOf(command: HostCommand): string | null {
  const params = object(command.params)!;
  const request = object(params.request);
  const value = params.sessionId ?? request?.sessionId ?? object(request?.value)?.sessionId;
  return typeof value === 'string' ? value : null;
}

/** Host-owned product identity. No relay directory or network data enters this store. */
export class HostProductCatalog {
  readonly authority: EncryptedProductAuthority;
  private readonly db: DatabaseSync;
  private readonly authorityKey: string;
  private readonly runtimeSource: () => EncryptedCatalog;
  private readonly leases: Map<string, number>;
  constructor(options: {
    db: DatabaseSync;
    authority: EncryptedProductAuthority;
    runtime: () => EncryptedCatalog;
  }) {
    this.db = options.db;
    this.authority = Object.freeze(encryptedProductAuthoritySchema.parse(options.authority));
    this.authorityKey = productCanonicalJson(this.authority);
    this.runtimeSource = options.runtime;
    const location = this.db.location();
    let leases = location ? fileLeases.get(location) : memoryLeases.get(this.db);
    if (!leases) {
      leases = new Map();
      if (location) fileLeases.set(location, leases);
      else memoryLeases.set(this.db, leases);
    }
    this.leases = leases;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS encrypted_product_catalog(authority TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS encrypted_product_receipt(operation_id TEXT PRIMARY KEY, authority TEXT NOT NULL, request TEXT NOT NULL, receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS encrypted_product_operation(operation_id TEXT PRIMARY KEY, authority TEXT NOT NULL, fingerprint TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS encrypted_product_mapping(authority TEXT NOT NULL, target TEXT NOT NULL, fingerprint TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(authority,target));
    `);
  }
  private transaction<T>(run: () => T): T {
    const name = `encrypted_product_${++transactionId}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = run();
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    }
  }
  private stableId(kind: string, ...scope: string[]) {
    return `product_${kind}_${digest([this.authority, ...scope])}`;
  }
  private load(): Persisted {
    const row = this.db
      .prepare('SELECT revision,value FROM encrypted_product_catalog WHERE authority=?')
      .get(this.authorityKey);
    if (!row)
      return {
        catalog: {
          version: 1,
          authority: this.authority,
          revision: 0,
          workspaces: [],
          projects: [],
          replicas: [],
        },
        hosts: {},
        roots: {},
        generations: {},
      };
    const state = persistedSchema.parse(JSON.parse(String(row.value)));
    requireTrue(
      state.catalog.revision === row.revision &&
        productCanonicalJson(state.catalog.authority) === this.authorityKey,
    );
    return state;
  }
  private save(state: Persisted, previousRevision: number) {
    persistedSchema.parse(state);
    requireTrue(state.catalog.revision <= Number.MAX_SAFE_INTEGER);
    const row = this.db
      .prepare('SELECT revision FROM encrypted_product_catalog WHERE authority=?')
      .get(this.authorityKey);
    if (row) {
      const result = this.db
        .prepare(
          'UPDATE encrypted_product_catalog SET revision=?,value=? WHERE authority=? AND revision=?',
        )
        .run(state.catalog.revision, JSON.stringify(state), this.authorityKey, previousRevision);
      requireTrue(result.changes === 1);
    } else {
      requireTrue(previousRevision === 0);
      this.db
        .prepare('INSERT INTO encrypted_product_catalog VALUES(?,?,?)')
        .run(this.authorityKey, state.catalog.revision, JSON.stringify(state));
    }
    this.recordMappings(state);
  }
  /** Host-authored mapping evidence is committed before a catalog can be published. */
  private recordMappings(state: Persisted): void {
    for (const replica of state.catalog.replicas) {
      if (!replica.available) continue;
      const mapping = mappingSchema.parse({
        authority: this.authority,
        target: {
          catalogWorkspaceId: replica.catalogWorkspaceId,
          projectId: replica.projectId,
          replicaId: replica.id,
          revision: replica.revision,
        },
        workspaceId: replica.runtimeWorkspaceId,
        localProjectId: replica.localProjectId,
        runtime: {
          machineId: replica.machineId,
          userId: replica.userId,
          rootPath: state.roots[replica.id],
          generation: state.generations[replica.id],
        },
      });
      const target = productCanonicalJson(mapping.target),
        fingerprint = digest(mapping);
      const previous = this.db
        .prepare(
          'SELECT fingerprint,value FROM encrypted_product_mapping WHERE authority=? AND target=?',
        )
        .get(this.authorityKey, target);
      if (previous) {
        requireTrue(
          previous.fingerprint === fingerprint &&
            digest(mappingSchema.parse(JSON.parse(String(previous.value)))) === fingerprint,
        );
      } else {
        this.db
          .prepare('INSERT INTO encrypted_product_mapping VALUES(?,?,?,?)')
          .run(this.authorityKey, target, fingerprint, JSON.stringify(mapping));
      }
    }
  }
  runtime(): EncryptedCatalog {
    // Parse into an independent projection before any persistent reconciliation.
    return encryptedCatalogSchema.parse(this.runtimeSource());
  }
  synchronize(): EncryptedProductCatalog {
    const runtime = this.runtime();
    return this.transaction(() => {
      const state = this.load(),
        catalog = state.catalog;
      const previous = productCanonicalJson(state),
        previousRevision = catalog.revision;
      const active = new Set<string>();
      for (const workspace of runtime.workspaces) {
        const hostKey = this.stableId('runtime', workspace.id);
        let workspaceId = state.hosts[hostKey];
        if (!workspaceId) {
          workspaceId = this.stableId('workspace', workspace.id);
          requireTrue(!catalog.workspaces.some((entry) => entry.id === workspaceId));
          catalog.workspaces.push({ id: workspaceId, name: workspace.name.trim() || workspace.id });
          state.hosts[hostKey] = workspaceId;
        }
        requireTrue(catalog.workspaces.some((entry) => entry.id === workspaceId));
        for (const project of workspace.projects) {
          const replicaId = this.stableId('replica', workspace.id, project.id);
          active.add(replicaId);
          let replica = catalog.replicas.find((entry) => entry.id === replicaId);
          if (!replica) {
            const projectId = this.stableId('project', workspace.id, project.id);
            requireTrue(!catalog.projects.some((entry) => entry.id === projectId));
            catalog.projects.push({
              id: projectId,
              workspaceId,
              name: project.name.trim() || project.id,
              source: { kind: 'local' },
            });
            replica = {
              id: replicaId,
              catalogWorkspaceId: workspaceId,
              projectId,
              revision: 1,
              runtimeWorkspaceId: workspace.id,
              localProjectId: project.id,
              machineId: workspace.machineId,
              userId: workspace.userId,
              available: true,
            };
            catalog.replicas.push(replica);
            state.generations[replicaId] = 1;
          } else {
            requireTrue(
              replica.runtimeWorkspaceId === workspace.id &&
                replica.localProjectId === project.id &&
                replica.catalogWorkspaceId === workspaceId,
            );
            if (
              !replica.available ||
              replica.machineId !== workspace.machineId ||
              replica.userId !== workspace.userId ||
              state.roots[replicaId] !== project.rootPath
            ) {
              replica.revision++;
              state.generations[replicaId]!++;
              replica.available = true;
              replica.machineId = workspace.machineId;
              replica.userId = workspace.userId;
            }
          }
          state.roots[replicaId] = project.rootPath;
        }
      }
      for (const replica of catalog.replicas)
        if (replica.available && !active.has(replica.id)) {
          replica.available = false;
          replica.revision++;
          state.generations[replica.id]!++;
        }
      if (previous !== productCanonicalJson(state)) {
        catalog.revision++;
        this.save(state, previousRevision);
      }
      // On upgrade, only the current Host mapping is recorded; absent historical evidence is not invented.
      this.recordMappings(state);
      return encryptedProductCatalogSchema.parse(catalog);
    });
  }
  read(): EncryptedProductCatalog {
    return this.synchronize();
  }
  private receipt(request: EncryptedProductAction): EncryptedProductReceipt | undefined {
    const row = this.db
      .prepare(
        'SELECT authority,request,receipt FROM encrypted_product_receipt WHERE operation_id=?',
      )
      .get(request.operationId);
    if (!row) return undefined;
    requireTrue(
      row.authority === this.authorityKey && row.request === productCanonicalJson(request),
    );
    return validateEncryptedProductReceipt(
      JSON.parse(String(row.receipt)),
      this.authority,
      request,
    );
  }
  private hasLegacyOperation(operationId: string): boolean {
    // These fixed Host tables can reserve an operation before its main receipt exists.
    for (const [table, column] of [
      ['operation', 'id'],
      ['task_operation', 'id'],
      ['task_revocation', 'id'],
      ['session_fork', 'operation_id'],
    ] as const) {
      if (
        this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) &&
        this.db.prepare(`SELECT 1 FROM ${table} WHERE ${column}=?`).get(operationId)
      )
        return true;
    }
    return false;
  }
  private saveReceipt(
    request: EncryptedProductAction,
    status: EncryptedProductReceipt['status'],
    revision: number,
  ): EncryptedProductReceipt {
    requireTrue(
      !this.hasLegacyOperation(request.operationId) &&
        !this.db
          .prepare('SELECT 1 FROM encrypted_product_operation WHERE operation_id=?')
          .get(request.operationId),
    );
    const receipt: EncryptedProductReceipt = {
      version: 1,
      authority: this.authority,
      confirmed: true,
      operationId: request.operationId,
      request,
      status,
      revision,
    };
    validateEncryptedProductReceipt(receipt, this.authority, request);
    this.db
      .prepare('INSERT INTO encrypted_product_receipt VALUES(?,?,?,?)')
      .run(
        request.operationId,
        this.authorityKey,
        productCanonicalJson(request),
        JSON.stringify(receipt),
      );
    if (
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='operation'").get()
    )
      this.db
        .prepare('INSERT INTO operation(id,fingerprint,phase,result) VALUES(?,?,?,?)')
        .run(
          request.operationId,
          digest([this.authority, request]),
          'product-catalog',
          JSON.stringify(receipt),
        );
    return receipt;
  }
  action(raw: EncryptedProductAction): EncryptedProductReceipt {
    const request = encryptedProductActionSchema.parse(raw);
    this.synchronize();
    return this.transaction(() => {
      const prior = this.receipt(request);
      if (prior) return prior;
      requireTrue(!this.leases.get(this.authorityKey));
      const state = this.load(),
        catalog = state.catalog;
      requireTrue(catalog.revision === request.expectedRevision);
      if (request.action === 'create-workspace') {
        requireTrue(!catalog.workspaces.some((entry) => entry.id === request.id));
        catalog.workspaces.push({ id: request.id, name: request.name });
      } else if (request.action === 'rename-workspace') {
        const workspace = catalog.workspaces.find((entry) => entry.id === request.workspaceId);
        if (!workspace) fail();
        workspace.name = request.name;
      } else if (request.action === 'create-project') {
        requireTrue(
          catalog.workspaces.some((entry) => entry.id === request.workspaceId) &&
            !catalog.projects.some((entry) => entry.id === request.id),
        );
        catalog.projects.push({
          id: request.id,
          workspaceId: request.workspaceId,
          name: request.name,
          source: request.source,
        });
      } else if (request.action === 'assign-replica') {
        const replica = catalog.replicas.find((entry) => entry.id === request.replicaId);
        const project = catalog.projects.find((entry) => entry.id === request.projectId);
        if (!replica || !project) fail();
        requireTrue(
          replica.revision === request.expectedReplicaRevision &&
            project.workspaceId === replica.catalogWorkspaceId,
        );
        replica.projectId = project.id;
        replica.revision++;
      } else {
        requireTrue(
          state.hosts[this.stableId('runtime', request.runtimeWorkspaceId)] &&
            catalog.workspaces.some((entry) => entry.id === request.targetWorkspaceId),
        );
        if (
          state.hosts[this.stableId('runtime', request.runtimeWorkspaceId)] !==
          request.targetWorkspaceId
        ) {
          for (const replica of catalog.replicas.filter(
            (entry) => entry.runtimeWorkspaceId === request.runtimeWorkspaceId,
          )) {
            const original = catalog.projects.find((entry) => entry.id === replica.projectId)!;
            const projectId = this.stableId(
              'moved_project',
              original.id,
              request.targetWorkspaceId,
            );
            const existing = catalog.projects.find((entry) => entry.id === projectId);
            if (existing)
              requireTrue(
                existing.workspaceId === request.targetWorkspaceId &&
                  productCanonicalJson(existing.source) === productCanonicalJson(original.source),
              );
            else
              catalog.projects.push({
                ...original,
                id: projectId,
                workspaceId: request.targetWorkspaceId,
              });
            replica.catalogWorkspaceId = request.targetWorkspaceId;
            replica.projectId = projectId;
            replica.revision++;
          }
          state.hosts[this.stableId('runtime', request.runtimeWorkspaceId)] =
            request.targetWorkspaceId;
        }
      }
      catalog.revision++;
      this.save(state, request.expectedRevision);
      return this.saveReceipt(request, 'accepted', catalog.revision);
    });
  }
  inspect(raw: EncryptedProductAction): EncryptedProductInspection {
    const request = encryptedProductActionSchema.parse(raw);
    return this.transaction(() => {
      const receipt = this.receipt(request);
      const result = {
        version: 1 as const,
        authority: this.authority,
        confirmed: true as const,
        request,
      };
      if (receipt) return { ...result, found: true, receipt };
      requireTrue(
        !this.hasLegacyOperation(request.operationId) &&
          !this.db
            .prepare('SELECT 1 FROM encrypted_product_operation WHERE operation_id=?')
            .get(request.operationId),
      );
      return { ...result, found: false };
    });
  }
  abandon(raw: EncryptedProductAction): EncryptedProductReceipt {
    const request = encryptedProductActionSchema.parse(raw);
    return this.transaction(
      () =>
        this.receipt(request) ??
        this.saveReceipt(request, 'abandoned', this.load().catalog.revision),
    );
  }
  private runtimeEvidence(command: HostCommand): Claim['runtime'] {
    const workspace = this.runtime().workspaces.find((entry) => entry.id === command.workspaceId);
    const project = workspace?.projects.find((entry) => entry.id === command.localProjectId);
    if (!workspace || !project) return fail();
    const state = this.load();
    const replicaId = this.stableId('replica', workspace.id, project.id);
    const generation = state.generations[replicaId];
    if (!generation) return fail();
    return {
      machineId: workspace.machineId,
      userId: workspace.userId,
      rootPath: project.rootPath,
      generation,
    };
  }
  private makeClaim(
    target: EncryptedProductTarget | null,
    command: HostCommand,
    operation: Operation,
  ): Claim {
    return {
      authority: this.authority,
      target,
      workspaceId: command.workspaceId,
      localProjectId: command.localProjectId ?? null,
      sessionId: sessionOf(command),
      method: String(object(operation.original)?.method),
      original: digest(operation.original),
      runtime: this.runtimeEvidence(command),
    };
  }
  private currentTarget(target: EncryptedProductTarget, command: HostCommand): Replica | undefined {
    return this.read().replicas.find(
      (entry) =>
        entry.id === target.replicaId &&
        entry.catalogWorkspaceId === target.catalogWorkspaceId &&
        entry.projectId === target.projectId &&
        entry.revision === target.revision &&
        entry.runtimeWorkspaceId === command.workspaceId &&
        entry.localProjectId === command.localProjectId &&
        entry.available,
    );
  }
  private assertTarget(target: EncryptedProductTarget, command: HostCommand): void {
    if (this.currentTarget(target, command)) return;
    const operation = operationOf(command);
    if (!operation?.recovery || !operation.historical) fail();
    const row = this.db
      .prepare('SELECT authority,fingerprint FROM encrypted_product_operation WHERE operation_id=?')
      .get(operation.operationId);
    const claim = this.makeClaim(target, command, operation);
    if (row) {
      requireTrue(row.authority === this.authorityKey && row.fingerprint === digest(claim));
      return;
    }
    // A session frame may never have reached this Host. Only immutable evidence written
    // when the Host published that exact mapping can authorize inspecting or sealing it.
    // This grants no execution and cannot replace an existing operation claim.
    requireTrue(
      [
        'session-operations',
        'github-write-inspect',
        'github-write-abandon',
        'github-abandon',
        'preview-inspect',
        'preview-close',
      ].includes(command.method),
    );
    const historical = this.db
      .prepare(
        'SELECT fingerprint,value FROM encrypted_product_mapping WHERE authority=? AND target=?',
      )
      .get(this.authorityKey, productCanonicalJson(target));
    if (!historical) fail();
    const mapping = mappingSchema.parse(JSON.parse(String(historical.value)));
    requireTrue(
      historical.fingerprint === digest(mapping) &&
        digest(mapping) ===
          digest({
            authority: this.authority,
            target,
            workspaceId: command.workspaceId,
            localProjectId: command.localProjectId,
            runtime: claim.runtime,
          }),
    );
  }
  acquire(
    rawTarget: EncryptedProductTarget,
    rawCommand: HostCommand,
    resource?: EncryptedResource,
  ): { current(): void; release(): void } {
    const target = encryptedProductTargetSchema.parse(rawTarget),
      command = hostCommandSchema.parse(rawCommand);
    if (resource)
      requireTrue(
        resource.kind !== 'catalog' &&
          resource.workspaceId === command.workspaceId &&
          resource.projectId === command.localProjectId &&
          resource.catalogWorkspaceId === target.catalogWorkspaceId &&
          resource.replicaId === target.replicaId &&
          resource.sessionId === sessionOf(command),
      );
    this.assertTarget(target, command);
    this.leases.set(this.authorityKey, (this.leases.get(this.authorityKey) ?? 0) + 1);
    let released = false;
    return {
      current: () => {
        requireTrue(!released);
        this.assertTarget(target, command);
      },
      release: () => {
        if (released) return;
        released = true;
        const count = (this.leases.get(this.authorityKey) ?? 1) - 1;
        if (count) this.leases.set(this.authorityKey, count);
        else this.leases.delete(this.authorityKey);
      },
    };
  }
  /** A turn or preview outlives one response, but never its exact active execution mapping. */
  executionCurrent(rawTarget: EncryptedProductTarget, rawCommand: HostCommand): () => void {
    const target = encryptedProductTargetSchema.parse(rawTarget),
      command = hostCommandSchema.parse(rawCommand);
    requireTrue(
      (command.method === 'mutate' && command.params.kind === 'turn') ||
        (command.method === 'preview-action' && command.params.action === 'open'),
    );
    requireTrue(this.currentTarget(target, command));
    const runtime = this.runtimeEvidence(command);
    const current = () => {
      requireTrue(this.currentTarget(target, command));
      requireTrue(digest(runtime) === digest(this.runtimeEvidence(command)));
    };
    current();
    return current;
  }
  /** A permanent scope claim, not a delivery receipt or evidence that Agent work began. */
  bindOperation(rawTarget: EncryptedProductTarget | null, rawCommand: HostCommand): void {
    const target = rawTarget === null ? null : encryptedProductTargetSchema.parse(rawTarget);
    const command = hostCommandSchema.parse(rawCommand),
      operation = operationOf(command);
    if (!operation) return;
    if (target) this.assertTarget(target, command);
    else requireTrue(command.method === 'session-operations');
    const claim = this.makeClaim(target, command, operation),
      fingerprint = digest(claim);
    this.transaction(() => {
      requireTrue(
        !this.db
          .prepare('SELECT 1 FROM encrypted_product_receipt WHERE operation_id=?')
          .get(operation.operationId),
      );
      const previous = this.db
        .prepare(
          'SELECT authority,fingerprint,value FROM encrypted_product_operation WHERE operation_id=?',
        )
        .get(operation.operationId);
      if (!operation.historical) {
        // Task inspection/abandon carries only the already-authorized tool's
        // operation reference. TaskManager checks its complete persisted grant
        // and tool scope; a recovery query must not overwrite that original body.
        if (previous) {
          const prior = JSON.parse(String(previous.value)) as Claim;
          requireTrue(
            previous.authority === this.authorityKey &&
              prior.method === 'tasks-action' &&
              digest({ ...prior, original: '' }) === digest({ ...claim, original: '' }),
          );
        }
        return;
      }
      if (previous) {
        requireTrue(
          previous.authority === this.authorityKey && previous.fingerprint === fingerprint,
        );
        return;
      }
      if (target) requireTrue(!this.hasLegacyOperation(operation.operationId));
      if (operation.inspection) return;
      this.db
        .prepare('INSERT INTO encrypted_product_operation VALUES(?,?,?,?)')
        .run(operation.operationId, this.authorityKey, fingerprint, JSON.stringify(claim));
    });
  }
}
