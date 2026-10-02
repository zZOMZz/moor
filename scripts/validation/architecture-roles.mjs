import { relative } from 'node:path';

/** Roles cover production directories, never migration exceptions. */
const rules = [
  [/^packages\/protocol\/src\//, 'contract'],
  [/^packages\/session\/src\//, 'model'],
  [/^packages\/local-state\/src\//, 'adapter'],
  [/^packages\/(client|host|gateway)\/src\/(features|operations)\//, 'core'],
  [/^packages\/(client|host|gateway|sync)\/src\/adapters\//, 'adapter'],
  [/^packages\/sync\/src\/document\//, 'core'],
  [/^apps\/web\/src\/app\//, 'composition'],
  [/^apps\/web\/src\/(features|components|styles)\//, 'ui'],
  [/^apps\/web\/src\/platform\//, 'adapter'],
  [
    /^apps\/desktop\/src\/(entry\.cjs|main\/main\.cjs|main\/workspace-client-entry\.ts)$/,
    'composition',
  ],
  [/^apps\/desktop\/src\/(main|preload)\//, 'adapter'],
  [/^apps\/desktop\/src\/settings\//, 'ui'],
  [/^apps\/(cli|host|relay)\/src\/main\.ts$/, 'composition'],
  [/^apps\/cli\/src\/(client|state|google-auth)\.ts$/, 'adapter'],
  [/^apps\/cli\/src\/(args|input|retired)\.ts$/, 'ui'],
  [
    /^apps\/relay\/src\/(account-recovery|google-oidc|web-push|web-push-library\.d)\.ts$/,
    'adapter',
  ],
];
export function architectureRole(root, file) {
  const name = relative(root, file).replaceAll('\\', '/');
  return rules.find(([pattern]) => pattern.test(name))?.[1];
}
export const pureRoles = new Set(['core', 'contract', 'model']);

export function moduleInventory(root, files) {
  const rows = files
    .filter((file) => /\/(apps|packages)\/[^/]+\/src\//.test(file))
    .map((file) => [relative(root, file).replaceAll('\\', '/'), architectureRole(root, file)])
    .sort(([a], [b]) => a.localeCompare(b));
  return rows;
}

export function inventoryMarkdown(rows) {
  const groups = new Map();
  for (const [file, role] of rows) {
    const key = file.split('/').slice(0, 2).join('/');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push([file, role]);
  }
  return `# Moor 模块职责与依赖方向

功能声明需要的能力，适配器实现能力，应用入口组装实例与生命周期。会话业务只在共享 core 中实现；UI 保留展示与交互，CLI 保留参数、输入输出及本机状态适配。Host 拥有正文持久化与执行权，Relay 只保存账号、目录、授权及推送路由证据。

| 职责 | 内容 | 允许的依赖 |
| --- | --- | --- |
| contract | 版本化契约、范围与回执验证 | 纯契约与编码 |
| model | CRDT、会话模型与文档投影 | model、contract |
| core | 用例、授权、原操作与事务政策及消费方接口 | core、model、contract |
| adapter | SQL、文件、传输、有限 IPC、认证与平台能力 | 消费方接口和所属平台 API |
| composition | 应用入口与实例生命周期组装 | 功能与具体实现 |
| ui | 展示、表单、布局、组件状态及 CLI 交互 | 功能接口和显式 UI 能力 |

数据库连接只进入持久实现与 Node 组装点。账号、目录和推送复用同一连接，Host 原子提交复用同一工作单元。业务得到有范围的提交能力；拆接口不拆事务。连接版本只证明当前连接身份，回执仍须匹配完整原请求并在异步等待后复核授权。

生产运行时显式提供时钟、编号和调度。共享 UI 可以使用 DOM 与 React；桌面桥接、文件导出、登录跳转、偏好存储与通知 API 由平台能力提供。开发性能面板仍由构建旗标限定在开发入口。

下表列出全部生产源码模块。由职责规则生成，包边界检查同时核对源文件、导入及此清单；新增未分类文件或未更新清单会失败。更新清单使用 \`pnpm architecture:inventory\`，检查使用 \`pnpm boundaries\`。规则位于 [architecture-roles.mjs](../scripts/validation/architecture-roles.mjs)，构建图另由 \`pnpm production:check\` 核对。

${[...groups].map(([group, modules]) => `<details>\n<summary>${group}（${modules.length} 个模块）</summary>\n\n| 模块 | 职责 |\n| --- | --- |\n${modules.map(([file, role]) => `| ${file} | ${role ?? 'unclassified'} |`).join('\n')}\n\n</details>`).join('\n\n')}
`;
}
