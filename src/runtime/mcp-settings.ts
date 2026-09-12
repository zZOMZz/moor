import { randomUUID } from 'node:crypto';
import { accessSync, constants, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { contentScopeSchema } from '../content-protocol';
import {
  MCP_LIMITS,
  mcpServerIdsSchema,
  mcpServerViewSchema,
  type McpServerView,
} from '../mcp-protocol';
import { AppError, assert, id, localProjectSchema } from '../protocol';
import type { AgentMcpServer } from './agent';
import type { AttachmentScope, RuntimeStore } from './store';

const revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const text = z.string().regex(/^[^\x00-\x1f\x7f]*$/u);
const argument = z
  .string()
  .max(4096)
  .refine((value) => !value.includes('\0'));
const envName = z
  .string()
  .max(100)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const headerName = z
  .string()
  .max(100)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/);
const envSchema = z
  .record(
    envName,
    z
      .string()
      .max(8192)
      .refine((value) => !value.includes('\0')),
  )
  .refine((value) => Object.keys(value).length <= 32);
const headersSchema = z.record(headerName, text.max(8192)).superRefine((value, ctx) => {
  const names = Object.keys(value).map((name) => name.toLowerCase());
  if (
    names.length > 32 ||
    new Set(names).size !== names.length ||
    names.some((name) =>
      [
        'host',
        'content-length',
        'transfer-encoding',
        'connection',
        'upgrade',
        'proxy-authorization',
        'proxy-connection',
      ].includes(name),
    )
  )
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'MCP 请求头无效' });
});
const urlSchema = text
  .min(1)
  .max(4096)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.href === value &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  });
const connectionSchema = z.discriminatedUnion('transport', [
  z
    .object({
      transport: z.literal('stdio'),
      command: text.min(1).max(4096),
      args: z.array(argument).max(128),
      env: envSchema.optional(),
    })
    .strict(),
  z
    .object({
      transport: z.enum(['http', 'sse']),
      url: urlSchema,
      headers: headersSchema.optional(),
    })
    .strict(),
]);
const projectIdsSchema = z
  .array(id)
  .min(1)
  .max(100)
  .refine((values) => new Set(values).size === values.length);
export const mcpSettingsActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }).strict(),
  z
    .object({
      action: z.literal('save'),
      expectedRevision: revision,
      id: id.optional(),
      name: mcpServerViewSchema.shape.name,
      description: text.max(2000),
      projectIds: projectIdsSchema,
      enabled: z.boolean().default(false),
      connection: connectionSchema,
    })
    .strict(),
  z
    .object({ action: z.literal('enabled'), expectedRevision: revision, id, enabled: z.boolean() })
    .strict(),
  z.object({ action: z.literal('remove'), expectedRevision: revision, id }).strict(),
]);
export type McpSettingsAction = z.infer<typeof mcpSettingsActionSchema>;
type Connection = z.infer<typeof connectionSchema>;
export type McpSettingsPreset = {
  id: string;
  versionId: string;
  name: string;
  description: string;
  projectIds: string[];
  enabled: boolean;
  connection:
    | { transport: 'stdio'; command: string; args: string[]; envNames: string[] }
    | { transport: 'http' | 'sse'; url: string; headerNames: string[] };
};
export type McpSettingsState = {
  revision: number;
  projects: Array<{ id: string; name: string }>;
  presets: McpSettingsPreset[];
};
const identitySchema = z
  .object({ workspaceId: id, userId: z.string().min(1).max(200), machineId: id })
  .strict();
const scopeSchema = contentScopeSchema
  .extend({ userId: identitySchema.shape.userId, machineId: id })
  .strict();
const rootSchema = z
  .object({
    id,
    rootPath: text.min(1).max(4096),
    dev: z.string().regex(/^\d+$/),
    ino: z.string().regex(/^\d+$/),
  })
  .strict();
type ProjectRoot = z.infer<typeof rootSchema>;
const versionSchema = z
  .object({
    id: z.string().regex(/^mcpv_[a-f0-9]{32}$/),
    presetId: id,
    name: mcpServerViewSchema.shape.name,
    description: text.max(2000),
    projects: z.array(rootSchema).min(1).max(100),
    connection: connectionSchema,
  })
  .strict();
type Version = z.infer<typeof versionSchema>;
const presetSchema = z
  .object({
    id,
    versionId: versionSchema.shape.id,
    enabled: z.boolean(),
    removed: z.boolean(),
    generation: revision,
  })
  .strict();
type Preset = z.infer<typeof presetSchema>;
const savedSchema = z
  .object({
    version: z.literal(1),
    identity: identitySchema,
    revision,
    presets: z.array(presetSchema).max(500),
    versions: z.array(versionSchema).max(500),
  })
  .strict();
type Saved = z.infer<typeof savedSchema>;
const key = 'mcp-settings-v1';
const versionId = () => 'mcpv_' + randomUUID().replaceAll('-', '');

/** Private local configuration only. Reading or authorizing never launches an MCP process. */
export class McpSettings {
  private readonly identity: z.infer<typeof identitySchema>;
  constructor(
    private readonly store: RuntimeStore,
    private readonly changed: () => void = () => {},
  ) {
    this.identity = this.currentIdentity();
  }
  private currentIdentity() {
    return {
      workspaceId: this.store.workspace.id,
      userId: this.store.workspace.userId,
      machineId: this.store.workspace.machineId,
    };
  }
  private assertIdentity() {
    assert(
      isDeepStrictEqual(this.identity, this.currentIdentity()),
      409,
      '本机 MCP 设置范围已改变',
    );
  }
  private load(): Saved {
    this.assertIdentity();
    const bytes = this.store.load(key);
    let saved: Saved;
    try {
      assert(!bytes || bytes.byteLength <= 40 * 1024 * 1024, 409, '本机 MCP 设置过大');
      saved = bytes
        ? savedSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))
        : { version: 1, identity: { ...this.identity }, revision: 0, presets: [], versions: [] };
    } catch {
      throw new AppError(409, '本机 MCP 设置无法安全读取');
    }
    assert(isDeepStrictEqual(saved.identity, this.identity), 409, '本机 MCP 设置属于其他主机身份');
    assert(
      new Set(saved.presets.map((p) => p.id)).size === saved.presets.length &&
        new Set(saved.versions.map((v) => v.id)).size === saved.versions.length &&
        saved.presets.filter((p) => !p.removed).length <= MCP_LIMITS.servers,
      409,
      '本机 MCP 设置记录无效',
    );
    for (const preset of saved.presets)
      assert(
        saved.versions.some((v) => v.id === preset.versionId && v.presetId === preset.id),
        409,
        '本机 MCP 配置版本不匹配',
      );
    for (const version of saved.versions)
      assert(
        saved.presets.some((p) => p.id === version.presetId) &&
          new Set(version.projects.map((p) => p.id)).size === version.projects.length,
        409,
        '本机 MCP 配置范围无效',
      );
    return saved;
  }
  private project(projectId: string): ProjectRoot {
    const parsed = localProjectSchema.safeParse(
      this.store.machine.get(['localProject', projectId]),
    );
    assert(parsed.success && parsed.data.id === projectId, 404, '本机 MCP 项目不存在');
    const rootPath = parsed.data.rootPath;
    try {
      const stat = lstatSync(rootPath, { bigint: true });
      assert(
        isAbsolute(rootPath) &&
          resolve(rootPath) === rootPath &&
          realpathSync(rootPath) === rootPath &&
          stat.isDirectory(),
        409,
        '本机 MCP 项目目录已改变',
      );
      return { id: projectId, rootPath, dev: String(stat.dev), ino: String(stat.ino) };
    } catch {
      throw new AppError(409, '本机 MCP 项目目录不可用或已改变');
    }
  }
  private projectCurrent(project: ProjectRoot) {
    assert(
      isDeepStrictEqual(this.project(project.id), project),
      409,
      '本机 MCP 项目目录身份已改变，请重新保存授权',
    );
  }
  private assertScope(scope: AttachmentScope) {
    this.assertIdentity();
    assert(
      scopeSchema.safeParse(scope).success &&
        scope.workspaceId === this.identity.workspaceId &&
        scope.userId === this.identity.userId &&
        scope.machineId === this.identity.machineId,
      404,
      'MCP 不属于当前执行主机',
    );
    this.project(scope.localProjectId);
    assert(this.store.attachmentScopeMatches(scope), 404, 'MCP 会话不属于当前项目');
    const metaId = 'session-' + scope.sessionId;
    if (
      this.store.meta.get(['e', metaId]) !== undefined ||
      this.store.meta.scan({ prefix: ['m', metaId] }).length ||
      this.store.searchSource(scope.sessionId)
    ) {
      const project = this.store.meta.get(['m', metaId, 'project']) as
        | { kind?: unknown; localProjectId?: unknown }
        | undefined;
      assert(
        this.store.meta.get(['m', metaId, 'id']) === scope.sessionId &&
          this.store.meta.get(['m', metaId, 'userId']) === scope.userId &&
          this.store.meta.get(['m', metaId, 'machineId']) === scope.machineId &&
          project?.kind === 'local' &&
          project.localProjectId === scope.localProjectId,
        404,
        'MCP 会话不属于当前项目',
      );
    }
  }
  private validCommand(command: string) {
    try {
      assert(
        isAbsolute(command) &&
          resolve(command) === command &&
          realpathSync(command) === command &&
          lstatSync(command).isFile(),
        400,
        'MCP 程序必须是本机普通可执行文件',
      );
      accessSync(command, constants.X_OK);
    } catch {
      throw new AppError(400, 'MCP 程序必须是本机普通可执行文件');
    }
  }
  private version(saved: Saved, preset: Preset) {
    const version = saved.versions.find(
      (v) => v.id === preset.versionId && v.presetId === preset.id,
    );
    assert(version, 409, '本机 MCP 配置版本不匹配');
    return version;
  }
  private view(saved: Saved): McpSettingsState {
    const projects = this.store.machine.scan({ prefix: ['localProject'] }).flatMap((row) => {
      const project = localProjectSchema.safeParse(row.value);
      return project.success && row.key[1] === project.data.id
        ? [{ id: project.data.id, name: project.data.name }]
        : [];
    });
    return {
      revision: saved.revision,
      projects,
      presets: saved.presets
        .filter((p) => !p.removed)
        .map((preset) => {
          const version = this.version(saved, preset),
            connection = version.connection;
          return {
            id: preset.id,
            versionId: version.id,
            name: version.name,
            description: version.description,
            projectIds: version.projects.map((project) => project.id),
            enabled: preset.enabled,
            connection:
              connection.transport === 'stdio'
                ? {
                    transport: 'stdio',
                    command: connection.command,
                    args: [...connection.args],
                    envNames: Object.keys(connection.env ?? {}).sort(),
                  }
                : {
                    transport: connection.transport,
                    url: connection.url,
                    headerNames: Object.keys(connection.headers ?? {}).sort(),
                  },
          };
        }),
    };
  }
  read(): McpSettingsState {
    return this.view(this.load());
  }
  catalog(scope: AttachmentScope): McpServerView[] {
    const saved = this.load();
    this.assertScope(scope);
    return saved.presets.flatMap((preset) => {
      if (!preset.enabled || preset.removed) return [];
      const version = this.version(saved, preset),
        project = version.projects.find((p) => p.id === scope.localProjectId);
      if (!project) return [];
      try {
        this.projectCurrent(project);
        if (version.connection.transport === 'stdio') this.validCommand(version.connection.command);
      } catch {
        return [];
      }
      return [
        {
          id: version.id,
          name: version.name,
          description: version.description,
          transport: version.connection.transport,
        },
      ];
    });
  }
  authorize(
    scope: AttachmentScope,
    serverIds: string[],
  ): { servers: AgentMcpServer[]; redact: string[]; assertCurrent(): void } {
    const selected = mcpServerIdsSchema.safeParse(serverIds);
    assert(selected.success, 400, 'MCP 选择无效');
    const snapshot = structuredClone(scope),
      ids = [...selected.data];
    const saved = this.load();
    this.assertScope(snapshot);
    const root = this.project(snapshot.localProjectId);
    const records = ids.map((id) => {
      const preset = saved.presets.find((p) => p.versionId === id && p.enabled && !p.removed);
      assert(preset, 409, 'MCP 配置版本已停用或改变，请重新选择');
      const version = this.version(saved, preset),
        project = version.projects.find((p) => p.id === snapshot.localProjectId);
      assert(project, 403, 'MCP 未授权给当前项目');
      this.projectCurrent(project);
      if (version.connection.transport === 'stdio') this.validCommand(version.connection.command);
      return { preset, version, project };
    });
    const redact = new Set<string>();
    const servers = records.map(({ version }): AgentMcpServer => {
      const name = 'moor_mcp_' + version.id,
        connection = version.connection;
      if (connection.transport === 'stdio') {
        redact.add(connection.command);
        for (const value of connection.args) {
          if (value) redact.add(value);
          const match = /^--?[^=]+=(.+)$/s.exec(value);
          if (match?.[1]) redact.add(match[1]);
        }
        for (const value of Object.values(connection.env ?? {})) if (value) redact.add(value);
        return {
          name,
          command: connection.command,
          args: [...connection.args],
          env: Object.entries(connection.env ?? {}).map(([name, value]) => ({ name, value })),
        };
      }
      redact.add(connection.url);
      for (const value of Object.values(connection.headers ?? {})) {
        if (value) redact.add(value);
        const bearer = /^(?:Bearer|Basic)\s+(\S+)$/i.exec(value);
        if (bearer) redact.add(bearer[1]);
      }
      return {
        type: connection.transport,
        name,
        url: connection.url,
        headers: Object.entries(connection.headers ?? {}).map(([name, value]) => ({ name, value })),
      };
    });
    const serverSnapshot = structuredClone(servers);
    return {
      servers,
      redact: [...redact].sort((a, b) => b.length - a.length),
      assertCurrent: () => {
        assert(
          isDeepStrictEqual(scope, snapshot) &&
            isDeepStrictEqual(serverIds, ids) &&
            isDeepStrictEqual(servers, serverSnapshot),
          409,
          'MCP 执行授权已改变',
        );
        const current = this.load();
        this.assertScope(snapshot);
        this.projectCurrent(root);
        for (const record of records) {
          const preset = current.presets.find((p) => p.id === record.preset.id);
          assert(
            preset &&
              preset.enabled &&
              !preset.removed &&
              preset.versionId === record.version.id &&
              preset.generation === record.preset.generation &&
              isDeepStrictEqual(this.version(current, preset), record.version),
            409,
            'MCP 执行授权已撤销或改变',
          );
          this.projectCurrent(record.project);
          if (record.version.connection.transport === 'stdio')
            this.validCommand(record.version.connection.command);
        }
      },
    };
  }
  async handle(input: unknown): Promise<McpSettingsState> {
    let parsed: ReturnType<typeof mcpSettingsActionSchema.safeParse>;
    try {
      assert(
        Buffer.byteLength(JSON.stringify(input), 'utf8') <= MCP_LIMITS.requestBytes,
        400,
        '本机 MCP 设置请求过大',
      );
      parsed = mcpSettingsActionSchema.safeParse(input);
    } catch {
      throw new AppError(400, '本机 MCP 设置请求无效');
    }
    assert(parsed.success, 400, '本机 MCP 设置请求无效');
    const action = parsed.data;
    if (action.action === 'read') return this.read();
    this.store.transaction(() => {
      const saved = this.load();
      assert(saved.revision === action.expectedRevision, 409, '本机 MCP 设置已改变，请重新读取');
      const preset =
        'id' in action && action.id
          ? saved.presets.find((p) => p.id === action.id && !p.removed)
          : undefined;
      assert(!('id' in action) || !action.id || preset, 404, '本机 MCP 预设不存在');
      if (action.action === 'save') {
        const projects = action.projectIds
          .map((id) => this.project(id))
          .sort((a, b) => a.id.localeCompare(b.id));
        const previous = preset ? this.version(saved, preset) : undefined;
        const connection: Connection = structuredClone(action.connection);
        if (connection.transport === 'stdio') {
          this.validCommand(connection.command);
          connection.env ??=
            previous?.connection.transport === 'stdio' ? { ...previous.connection.env } : {};
        } else
          connection.headers ??=
            previous?.connection.transport === connection.transport
              ? { ...previous.connection.headers }
              : {};
        const candidate = {
          name: action.name,
          description: action.description,
          projects,
          connection,
        };
        const unchanged =
          previous &&
          isDeepStrictEqual(
            {
              name: previous.name,
              description: previous.description,
              projects: previous.projects,
              connection: previous.connection,
            },
            candidate,
          );
        const next = unchanged
          ? previous
          : {
              ...candidate,
              id: versionId(),
              presetId: preset?.id ?? 'mcp_' + randomUUID().replaceAll('-', ''),
            };
        if (!unchanged) {
          assert(saved.versions.length < 500, 409, 'MCP 保留版本已达上限');
          saved.versions.push(next);
        }
        if (preset) {
          preset.versionId = next.id;
          if (!unchanged || preset.enabled !== action.enabled) preset.generation++;
          preset.enabled = action.enabled;
        } else {
          assert(
            saved.presets.filter((p) => !p.removed).length < MCP_LIMITS.servers,
            409,
            'MCP 预设已达上限',
          );
          saved.presets.push({
            id: next.presetId,
            versionId: next.id,
            enabled: action.enabled,
            removed: false,
            generation: 0,
          });
        }
      } else {
        assert(preset, 404, '本机 MCP 预设不存在');
        if (action.action === 'enabled') {
          if (action.enabled) {
            const version = this.version(saved, preset);
            for (const project of version.projects) this.projectCurrent(project);
            if (version.connection.transport === 'stdio')
              this.validCommand(version.connection.command);
          }
          if (preset.enabled !== action.enabled) preset.generation++;
          preset.enabled = action.enabled;
        } else {
          preset.enabled = false;
          preset.removed = true;
          preset.generation++;
        }
      }
      saved.revision++;
      savedSchema.parse(saved);
      const bytes = Buffer.from(JSON.stringify(saved));
      assert(bytes.length <= 40 * 1024 * 1024, 409, '本机 MCP 设置已达大小上限');
      this.store.save(key, bytes);
    });
    try {
      this.changed();
    } catch {
      /* Configuration already committed; notification cannot roll it back. */
    }
    return this.read();
  }
}
