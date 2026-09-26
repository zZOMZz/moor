# 未使用代码与生产可达性

这两个检查解决不同的问题：`pnpm knip` 检查源码导出、类型及直接依赖的消费者；完整构建后的 `pnpm production:check` 检查实际分发程序引用的模块。测试引用不能证明某个运行模块仍在产品中使用。

```sh
pnpm knip
pnpm knip:production
pnpm build
pnpm production:check
```

## 源码解析

锁定的 Knip 6.35.1 先用 OXC 按 `import`/`require` 条件解析包，再尝试 Knip 的 `paths`。本项目的运行条件指向 `dist`；若构建文件已经存在，直接配置 Knip `paths` 不能覆盖这个成功结果，会把实际使用的源码导出误报为无消费者。

[检查入口](../scripts/validation/check-unused.mjs) 向 OXC 显式传入独立的 [tsconfig.knip.json](../tsconfig.knip.json)。它在运行前核对每个 workspace manifest 的源码导出映射，新增或修改包导出时必须同步映射。这个配置不改变应用的 TypeScript 编译或 Node 运行解析。合成回归分别在 `dist` 存在和不存在时检查同一消费者，确保确实使用的导出不被误报、真正未使用的导出仍能被发现。

[Knip 配置](../knip.jsonc) 不再把全部 `src/**/*.ts` 显式声明为入口，也不关闭包入口导出检查。仍有一个工具限制：Knip 会将 manifest 的通配源码导出自动展开为入口。因此不能用它的“未使用文件为零”证明生产模块清理完成；文件可达性由下面的实际构建图补充验证。

普通检查包含测试，生产模式排除测试和开发依赖。只在测试里使用的接口需要单独判断是否应保留为私有实现，不能根据生产模式输出机械删除安全回归。类型导出与运行值分别分析。

六个内部 `private` 包仅保留实际使用的子路径导出。无任何根包导入消费者的 `src/index.ts` 转导及 manifest 的 `"."` 出口已删除；这不改变已有 `@moor/包名/模块` 导入。根项目仍通过真实子路径测试消费各包，相关 workspace 依赖继续保留。

## 实际构建图

[构建图采集器](../scripts/validation/production-graph.mjs) 读取三组 Node runtime、Web、通知 worker，以及 Electron main/preload/renderer 的真实 esbuild/Rollup 结果。它分别记录已读取的源码和真正写入产物的模块，不能把被 tree-shaking 删除的实现当作生产消费者。实际被加载、只负责导入或转导的模块单列为连接模块；例如桌面入口通过导入加载 CSS 和启动脚本，本身可以没有输出字节。

复制到 Electron 包中的启动脚本和设置脚本也要验证产物与源码逐字相同，才计入入口。采集器只记录正式 `dist` 位置，临时目录测试和开发构建不能覆盖正式图。每份图保存源码与产物的 SHA-256；源码改变、产物缺失或被替换后，检查会要求重新构建。

[生产门禁](../scripts/validation/check-production-reachability.mjs) 遍历当前 `apps/*/src` 和 `packages/*/src`，检查运行模块是否进入上述真实产物。只含类型声明的文件，以及从实际运行模块显式引用的编译期类型依赖单独报告，不把它们当作缺失运行代码。类型引用不能豁免同一文件中未输出的运行实现；必要类型应与旧实现分离。其他未引用模块必须清理或恢复真实消费者，不能通过扩大入口通配符掩盖。已退场的加密、预览和旧任务执行路径即使重新进入构建，也会直接失败。

图保存在 `dist/validation/production-graphs`，属于本机验证结果，不进入 Relay、Host 或 Desktop 分发包。

## 开发性能入口

开发性能面板有两个精确的非生产实现：[performance-panel.ts](../apps/web/src/features/performance/performance-panel.ts) 和 [performance-metrics.ts](../apps/web/src/features/performance/performance-metrics.ts)。门禁将它们单列为 `developmentOnly`，并反向检查所有生产构建图：任意一个实现写入生产产物都会失败。此分类不覆盖整个目录，新模块仍须提供真实消费者。

[desktop-entry.ts](../apps/web/src/app/desktop-entry.ts) 仍是生产样式与启动脚本的连接模块。它只有在真实生产图已加载、顶层除模块连接与类型声明外仅保留精确的 `__MOOR_DEV_PERFORMANCE__` 声明和开发条件块时，才能以零输出字节归入 `linkage`。开发例外还要求该条件块实际动态导入面板，且面板通过运行值导入指标实现；删除这条源码链后，两个实现恢复为无消费者错误。测试引用不参与分类。

[Electron Vite 配置](../electron.vite.config.mjs) 在开发时启用该编译标记，生产时设为 `false`；[实际 Electron 检查](../scripts/validation/check-desktop-vite.mjs) 通过 Vite 开发入口等待面板 DOM 安装，并检查它初始关闭，同时验证生产入口没有面板和开发桥。运行 `pnpm check:desktop:electron` 验证真实开发消费者，运行完整构建和 `pnpm production:check` 验证发行产物未包含开发实现。这些检查使用隔离数据；不代表真实 Agent 账户或用户负载下的性能基准。

## 有限动态入口

Desktop 主进程通过固定的 `workspace-client.mjs` 动态加载三个导出：`DesktopWorkspaceClient`、`accountManagementPlan` 和 `validateAccountManagementResult`。源码中的 `@nativeEntry` 注解说明具体调用方；生产门禁同时核对这个 bundle 的导出集合，避免把任意未使用导出都视为原生入口。

ACP 适配器是固定版本的外部子进程包，按打包与启动路径使用，不是普通静态 `import`。原有精确的依赖例外保留；新增动态入口或例外必须指出调用方和实际产物证据。

回归见 [production-reachability.test.ts](../tests/integration/production-reachability.test.ts)。这些是合成工具和构建验证，不代表真实设备或 Agent 账户验收。
