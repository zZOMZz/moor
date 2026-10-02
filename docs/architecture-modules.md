# Moor 模块职责与依赖方向

功能声明需要的能力，适配器实现能力，应用入口组装实例与生命周期。会话业务只在共享 core 中实现；UI 保留展示与交互，CLI 保留参数、输入输出及本机状态适配。Host 拥有正文持久化与执行权，Relay 只保存账号、目录、授权及推送路由证据。

| 职责        | 内容                                      | 允许的依赖               |
| ----------- | ----------------------------------------- | ------------------------ |
| contract    | 版本化契约、范围与回执验证                | 纯契约与编码             |
| model       | CRDT、会话模型与文档投影                  | model、contract          |
| core        | 用例、授权、原操作与事务政策及消费方接口  | core、model、contract    |
| adapter     | SQL、文件、传输、有限 IPC、认证与平台能力 | 消费方接口和所属平台 API |
| composition | 应用入口与实例生命周期组装                | 功能与具体实现           |
| ui          | 展示、表单、布局、组件状态及 CLI 交互     | 功能接口和显式 UI 能力   |

数据库连接只进入持久实现与 Node 组装点。账号、目录和推送复用同一连接，Host 原子提交复用同一工作单元。业务得到有范围的提交能力；拆接口不拆事务。连接版本只证明当前连接身份，回执仍须匹配完整原请求并在异步等待后复核授权。

生产运行时显式提供时钟、编号和调度。共享 UI 可以使用 DOM 与 React；桌面桥接、文件导出、登录跳转、偏好存储与通知 API 由平台能力提供。开发性能面板仍由构建旗标限定在开发入口。

下表列出全部生产源码模块。由职责规则生成，包边界检查同时核对源文件、导入及此清单；新增未分类文件或未更新清单会失败。更新清单使用 `pnpm architecture:inventory`，检查使用 `pnpm boundaries`。规则位于 [architecture-roles.mjs](../scripts/validation/architecture-roles.mjs)，构建图另由 `pnpm production:check` 核对。

<details>
<summary>apps/cli（7 个模块）</summary>

| 模块                        | 职责        |
| --------------------------- | ----------- |
| apps/cli/src/args.ts        | ui          |
| apps/cli/src/client.ts      | adapter     |
| apps/cli/src/google-auth.ts | adapter     |
| apps/cli/src/input.ts       | ui          |
| apps/cli/src/main.ts        | composition |
| apps/cli/src/retired.ts     | ui          |
| apps/cli/src/state.ts       | adapter     |

</details>

<details>
<summary>apps/desktop（27 个模块）</summary>

| 模块                                            | 职责        |
| ----------------------------------------------- | ----------- |
| apps/desktop/src/entry.cjs                      | composition |
| apps/desktop/src/main/account.cjs               | adapter     |
| apps/desktop/src/main/agent-settings.cjs        | adapter     |
| apps/desktop/src/main/appearance.cjs            | adapter     |
| apps/desktop/src/main/attachment-save.cjs       | adapter     |
| apps/desktop/src/main/client-assets.cjs         | adapter     |
| apps/desktop/src/main/client-policy.cjs         | adapter     |
| apps/desktop/src/main/client-window.cjs         | adapter     |
| apps/desktop/src/main/content-authority.cjs     | adapter     |
| apps/desktop/src/main/dev-performance.cjs       | adapter     |
| apps/desktop/src/main/dev-runtime.cjs           | adapter     |
| apps/desktop/src/main/device-metadata.cjs       | adapter     |
| apps/desktop/src/main/github-settings.cjs       | adapter     |
| apps/desktop/src/main/google-auth.cjs           | adapter     |
| apps/desktop/src/main/json-input.cjs            | adapter     |
| apps/desktop/src/main/main.cjs                  | composition |
| apps/desktop/src/main/notifications.cjs         | adapter     |
| apps/desktop/src/main/page-loader.cjs           | adapter     |
| apps/desktop/src/main/project-registration.cjs  | adapter     |
| apps/desktop/src/main/recovery.cjs              | adapter     |
| apps/desktop/src/main/skills-settings.cjs       | adapter     |
| apps/desktop/src/main/workspace-bridge.cjs      | adapter     |
| apps/desktop/src/main/workspace-client-entry.ts | composition |
| apps/desktop/src/main/workspace-events.ts       | adapter     |
| apps/desktop/src/preload/preload.cjs            | adapter     |
| apps/desktop/src/preload/workspace-preload.cjs  | adapter     |
| apps/desktop/src/settings/settings.js           | ui          |

</details>

<details>
<summary>apps/host（1 个模块）</summary>

| 模块                  | 职责        |
| --------------------- | ----------- |
| apps/host/src/main.ts | composition |

</details>

<details>
<summary>apps/relay（5 个模块）</summary>

| 模块                                 | 职责        |
| ------------------------------------ | ----------- |
| apps/relay/src/account-recovery.ts   | adapter     |
| apps/relay/src/google-oidc.ts        | adapter     |
| apps/relay/src/main.ts               | composition |
| apps/relay/src/web-push-library.d.ts | adapter     |
| apps/relay/src/web-push.ts           | adapter     |

</details>

<details>
<summary>apps/web（69 个模块）</summary>

| 模块                                                            | 职责        |
| --------------------------------------------------------------- | ----------- |
| apps/web/src/app/bootstrap.ts                                   | composition |
| apps/web/src/app/browser-workspace-app.tsx                      | composition |
| apps/web/src/app/collaboration-app.tsx                          | composition |
| apps/web/src/app/desktop-entry.tsx                              | composition |
| apps/web/src/app/desktop-shell.ts                               | composition |
| apps/web/src/app/web-entry.ts                                   | composition |
| apps/web/src/app/worker-entry.ts                                | composition |
| apps/web/src/app/workspace-app.tsx                              | composition |
| apps/web/src/app/workspace-port.ts                              | composition |
| apps/web/src/components/appearance.tsx                          | ui          |
| apps/web/src/components/content.ts                              | ui          |
| apps/web/src/components/model-menu.tsx                          | ui          |
| apps/web/src/components/ui.tsx                                  | ui          |
| apps/web/src/components/usage-panel.tsx                         | ui          |
| apps/web/src/features/attachments/workspace-attachment-view.tsx | ui          |
| apps/web/src/features/attention/attention-ui.tsx                | ui          |
| apps/web/src/features/attention/workspace-attention-ui.tsx      | ui          |
| apps/web/src/features/auth/browser-account.tsx                  | ui          |
| apps/web/src/features/auth/catalog-management.tsx               | ui          |
| apps/web/src/features/auth/google-login.tsx                     | ui          |
| apps/web/src/features/auth/login-water.ts                       | ui          |
| apps/web/src/features/auth/login.tsx                            | ui          |
| apps/web/src/features/auth/workspace-account.tsx                | ui          |
| apps/web/src/features/collaboration/board.tsx                   | ui          |
| apps/web/src/features/files/project-content-ui.tsx              | ui          |
| apps/web/src/features/files/workspace-content-layout.tsx        | ui          |
| apps/web/src/features/files/workspace-content-ui.tsx            | ui          |
| apps/web/src/features/fork/session-fork-ui.tsx                  | ui          |
| apps/web/src/features/fork/workspace-fork-ui.tsx                | ui          |
| apps/web/src/features/git/git-workspace-ui.tsx                  | ui          |
| apps/web/src/features/git/workspace-git-ui.tsx                  | ui          |
| apps/web/src/features/github/github-session-ui.tsx              | ui          |
| apps/web/src/features/github/github-ui.tsx                      | ui          |
| apps/web/src/features/github/github-write-ui.tsx                | ui          |
| apps/web/src/features/github/workspace-github-ui.tsx            | ui          |
| apps/web/src/features/interactions/information.ts               | ui          |
| apps/web/src/features/interactions/interaction-ui.tsx           | ui          |
| apps/web/src/features/interactions/workspace-interaction-ui.tsx | ui          |
| apps/web/src/features/notifications/notification-navigation.ts  | ui          |
| apps/web/src/features/notifications/notification-ui.tsx         | ui          |
| apps/web/src/features/performance/performance-metrics.ts        | ui          |
| apps/web/src/features/performance/performance-panel.ts          | ui          |
| apps/web/src/features/performance/performance-signals.ts        | ui          |
| apps/web/src/features/sessions/composer-input.tsx               | ui          |
| apps/web/src/features/sessions/session-search-ui.tsx            | ui          |
| apps/web/src/features/sessions/session-timeline.tsx             | ui          |
| apps/web/src/features/sessions/streaming-markdown.tsx           | ui          |
| apps/web/src/features/sessions/workspace-navigation-pages.ts    | ui          |
| apps/web/src/features/sessions/workspace-navigation.tsx         | ui          |
| apps/web/src/features/skills/skills-ui.tsx                      | ui          |
| apps/web/src/features/skills/workspace-skills-ui.tsx            | ui          |
| apps/web/src/features/workspace/workspace-layout.tsx            | ui          |
| apps/web/src/features/workspace/workspace-session-tools.tsx     | ui          |
| apps/web/src/platform/account.ts                                | adapter     |
| apps/web/src/platform/api.ts                                    | adapter     |
| apps/web/src/platform/browser-logout.ts                         | adapter     |
| apps/web/src/platform/browser-storage.ts                        | adapter     |
| apps/web/src/platform/browser-workspace.ts                      | adapter     |
| apps/web/src/platform/browser/collaboration.ts                  | adapter     |
| apps/web/src/platform/browser/notification-storage.ts           | adapter     |
| apps/web/src/platform/browser/notifications.ts                  | adapter     |
| apps/web/src/platform/browser/retired-records.ts                | adapter     |
| apps/web/src/platform/browser/ui-ports.ts                       | adapter     |
| apps/web/src/platform/catalog-data-guard.ts                     | adapter     |
| apps/web/src/platform/deadline.ts                               | adapter     |
| apps/web/src/platform/desktop/startup.ts                        | adapter     |
| apps/web/src/platform/desktop/ui-ports.ts                       | adapter     |
| apps/web/src/platform/indexed-storage.ts                        | adapter     |
| apps/web/src/platform/ui-ports.tsx                              | adapter     |

</details>

<details>
<summary>packages/client（86 个模块）</summary>

| 模块                                                                | 职责    |
| ------------------------------------------------------------------- | ------- |
| packages/client/src/adapters/browser/http.ts                        | adapter |
| packages/client/src/adapters/browser/workspace-client.ts            | adapter |
| packages/client/src/adapters/node/error.ts                          | adapter |
| packages/client/src/adapters/node/http.ts                           | adapter |
| packages/client/src/adapters/node/targets.ts                        | adapter |
| packages/client/src/adapters/node/workspace-client.ts               | adapter |
| packages/client/src/adapters/shared/runtime.ts                      | adapter |
| packages/client/src/adapters/shared/workspace-transport.ts          | adapter |
| packages/client/src/features/attachments/attachments.ts             | core    |
| packages/client/src/features/attachments/export.ts                  | core    |
| packages/client/src/features/attachments/workspace-attachments.ts   | core    |
| packages/client/src/features/attention/attention.ts                 | core    |
| packages/client/src/features/attention/workspace-attention.ts       | core    |
| packages/client/src/features/auth/google-auth.ts                    | core    |
| packages/client/src/features/collaboration/client.ts                | core    |
| packages/client/src/features/collaboration/page.ts                  | core    |
| packages/client/src/features/files/file-content.ts                  | core    |
| packages/client/src/features/files/project-content-controller.ts    | core    |
| packages/client/src/features/files/project-content.ts               | core    |
| packages/client/src/features/files/scoped-project-content-cache.ts  | core    |
| packages/client/src/features/files/view.ts                          | core    |
| packages/client/src/features/files/workspace-content-cache.ts       | core    |
| packages/client/src/features/fork/session-fork.ts                   | core    |
| packages/client/src/features/fork/workspace-fork.ts                 | core    |
| packages/client/src/features/git/git-workspace.ts                   | core    |
| packages/client/src/features/git/workspace-git.ts                   | core    |
| packages/client/src/features/github/github-session.ts               | core    |
| packages/client/src/features/github/github-write.ts                 | core    |
| packages/client/src/features/github/github.ts                       | core    |
| packages/client/src/features/github/workspace-github.ts             | core    |
| packages/client/src/features/interactions/interactions.ts           | core    |
| packages/client/src/features/interactions/workspace-interactions.ts | core    |
| packages/client/src/features/mcp/mcp.ts                             | core    |
| packages/client/src/features/mcp/workspace-mcp.ts                   | core    |
| packages/client/src/features/notifications/local-state.ts           | core    |
| packages/client/src/features/notifications/notifications.ts         | core    |
| packages/client/src/features/notifications/worker.ts                | core    |
| packages/client/src/features/preview/annotation.ts                  | core    |
| packages/client/src/features/preview/project-preview.ts             | core    |
| packages/client/src/features/preview/workspace-preview.ts           | core    |
| packages/client/src/features/roles/roles.ts                         | core    |
| packages/client/src/features/roles/workspace-roles.ts               | core    |
| packages/client/src/features/sessions/session-actions.ts            | core    |
| packages/client/src/features/sessions/session-intent.ts             | core    |
| packages/client/src/features/sessions/session-search.ts             | core    |
| packages/client/src/features/skills/skills.ts                       | core    |
| packages/client/src/features/tasks/tasks.ts                         | core    |
| packages/client/src/features/tasks/workspace-tasks.ts               | core    |
| packages/client/src/features/workspace/attachments.ts               | core    |
| packages/client/src/features/workspace/attention.ts                 | core    |
| packages/client/src/features/workspace/catalog-safety.ts            | core    |
| packages/client/src/features/workspace/catalog.ts                   | core    |
| packages/client/src/features/workspace/commands.ts                  | core    |
| packages/client/src/features/workspace/compose.ts                   | core    |
| packages/client/src/features/workspace/context.ts                   | core    |
| packages/client/src/features/workspace/drafts.ts                    | core    |
| packages/client/src/features/workspace/feature-context.ts           | core    |
| packages/client/src/features/workspace/files.ts                     | core    |
| packages/client/src/features/workspace/fork.ts                      | core    |
| packages/client/src/features/workspace/git.ts                       | core    |
| packages/client/src/features/workspace/github.ts                    | core    |
| packages/client/src/features/workspace/interactions.ts              | core    |
| packages/client/src/features/workspace/model.ts                     | core    |
| packages/client/src/features/workspace/retired-records.ts           | core    |
| packages/client/src/features/workspace/sessions.ts                  | core    |
| packages/client/src/features/workspace/skills.ts                    | core    |
| packages/client/src/features/workspace/sync.ts                      | core    |
| packages/client/src/features/workspace/workspace-records.ts         | core    |
| packages/client/src/features/workspace/workspace-session-cache.ts   | core    |
| packages/client/src/features/workspace/workspace-session-pages.ts   | core    |
| packages/client/src/operations/request-rejection.ts                 | core    |
| packages/client/src/operations/session-operation.ts                 | core    |
| packages/client/src/operations/storage.ts                           | core    |
| packages/client/src/operations/workspace/attachments.ts             | core    |
| packages/client/src/operations/workspace/attention.ts               | core    |
| packages/client/src/operations/workspace/cache.ts                   | core    |
| packages/client/src/operations/workspace/compose.ts                 | core    |
| packages/client/src/operations/workspace/drafts.ts                  | core    |
| packages/client/src/operations/workspace/fork.ts                    | core    |
| packages/client/src/operations/workspace/git.ts                     | core    |
| packages/client/src/operations/workspace/github.ts                  | core    |
| packages/client/src/operations/workspace/interactions.ts            | core    |
| packages/client/src/operations/workspace/ledger.ts                  | core    |
| packages/client/src/operations/workspace/model.ts                   | core    |
| packages/client/src/operations/workspace/operations.ts              | core    |
| packages/client/src/operations/workspace/retired.ts                 | core    |

</details>

<details>
<summary>packages/gateway（22 个模块）</summary>

| 模块                                                       | 职责    |
| ---------------------------------------------------------- | ------- |
| packages/gateway/src/adapters/composition/accounts.ts      | adapter |
| packages/gateway/src/adapters/composition/notifications.ts | adapter |
| packages/gateway/src/adapters/crypto/credentials.ts        | adapter |
| packages/gateway/src/adapters/crypto/push-subscription.ts  | adapter |
| packages/gateway/src/adapters/http/commands.ts             | adapter |
| packages/gateway/src/adapters/http/google.ts               | adapter |
| packages/gateway/src/adapters/http/server.ts               | adapter |
| packages/gateway/src/adapters/http/static.ts               | adapter |
| packages/gateway/src/adapters/persistence/accounts.ts      | adapter |
| packages/gateway/src/adapters/persistence/catalog.ts       | adapter |
| packages/gateway/src/adapters/persistence/push.ts          | adapter |
| packages/gateway/src/features/accounts/ports.ts            | core    |
| packages/gateway/src/features/accounts/service.ts          | core    |
| packages/gateway/src/features/attention/forward.ts         | core    |
| packages/gateway/src/features/auth/google.ts               | core    |
| packages/gateway/src/features/authority/routing.ts         | core    |
| packages/gateway/src/features/catalog/records.ts           | core    |
| packages/gateway/src/features/catalog/service.ts           | core    |
| packages/gateway/src/features/collaboration/forward.ts     | core    |
| packages/gateway/src/features/commands/forward.ts          | core    |
| packages/gateway/src/features/notifications/ports.ts       | core    |
| packages/gateway/src/features/notifications/service.ts     | core    |

</details>

<details>
<summary>packages/host（93 个模块）</summary>

| 模块                                                       | 职责    |
| ---------------------------------------------------------- | ------- |
| packages/host/src/adapters/acp/attachment-input.ts         | adapter |
| packages/host/src/adapters/acp/capabilities.ts             | adapter |
| packages/host/src/adapters/acp/driver.ts                   | adapter |
| packages/host/src/adapters/acp/elicitation.ts              | adapter |
| packages/host/src/adapters/acp/events.ts                   | adapter |
| packages/host/src/adapters/acp/fork.ts                     | adapter |
| packages/host/src/adapters/acp/local-codex.ts              | adapter |
| packages/host/src/adapters/acp/program.ts                  | adapter |
| packages/host/src/adapters/acp/usage.ts                    | adapter |
| packages/host/src/adapters/composition/collaboration.ts    | adapter |
| packages/host/src/adapters/composition/identity.ts         | adapter |
| packages/host/src/adapters/composition/workspace.ts        | adapter |
| packages/host/src/adapters/config/agents.ts                | adapter |
| packages/host/src/adapters/config/github.ts                | adapter |
| packages/host/src/adapters/config/skills.ts                | adapter |
| packages/host/src/adapters/files/read.ts                   | adapter |
| packages/host/src/adapters/files/registration.ts           | adapter |
| packages/host/src/adapters/files/skills-sources.ts         | adapter |
| packages/host/src/adapters/files/skills.ts                 | adapter |
| packages/host/src/adapters/files/snapshot.ts               | adapter |
| packages/host/src/adapters/git/worktree.ts                 | adapter |
| packages/host/src/adapters/git/write.ts                    | adapter |
| packages/host/src/adapters/github/read-client.ts           | adapter |
| packages/host/src/adapters/github/write-client.ts          | adapter |
| packages/host/src/adapters/notifications/dispatch.ts       | adapter |
| packages/host/src/adapters/persistence/agent.ts            | adapter |
| packages/host/src/adapters/persistence/attention.ts        | adapter |
| packages/host/src/adapters/persistence/device-metadata.ts  | adapter |
| packages/host/src/adapters/persistence/execution.ts        | adapter |
| packages/host/src/adapters/persistence/fork.ts             | adapter |
| packages/host/src/adapters/persistence/github.ts           | adapter |
| packages/host/src/adapters/persistence/journal.ts          | adapter |
| packages/host/src/adapters/persistence/notifications.ts    | adapter |
| packages/host/src/adapters/persistence/project-history.ts  | adapter |
| packages/host/src/adapters/persistence/retired-roles.ts    | adapter |
| packages/host/src/adapters/persistence/retired-tasks.ts    | adapter |
| packages/host/src/adapters/persistence/search-index.ts     | adapter |
| packages/host/src/adapters/persistence/session-metadata.ts | adapter |
| packages/host/src/adapters/persistence/task-ledger.ts      | adapter |
| packages/host/src/adapters/persistence/workspace.ts        | adapter |
| packages/host/src/features/agents/config.ts                | core    |
| packages/host/src/features/agents/driver.ts                | core    |
| packages/host/src/features/agents/fork-model.ts            | core    |
| packages/host/src/features/agents/program-model.ts         | core    |
| packages/host/src/features/agents/run-preferences.ts       | core    |
| packages/host/src/features/agents/usage-cache.ts           | core    |
| packages/host/src/features/attachments/agent-output.ts     | core    |
| packages/host/src/features/attachments/model.ts            | core    |
| packages/host/src/features/collaboration/coordinator.ts    | core    |
| packages/host/src/features/collaboration/execution.ts      | core    |
| packages/host/src/features/collaboration/service.ts        | core    |
| packages/host/src/features/collaboration/task-ledger.ts    | core    |
| packages/host/src/features/collaboration/task-queue.ts     | core    |
| packages/host/src/features/commands/dispatcher.ts          | core    |
| packages/host/src/features/files/model.ts                  | core    |
| packages/host/src/features/fork/manager.ts                 | core    |
| packages/host/src/features/fork/model.ts                   | core    |
| packages/host/src/features/git/execution-model.ts          | core    |
| packages/host/src/features/git/execution.ts                | core    |
| packages/host/src/features/git/model.ts                    | core    |
| packages/host/src/features/git/port.ts                     | core    |
| packages/host/src/features/git/write-model.ts              | core    |
| packages/host/src/features/git/write-port.ts               | core    |
| packages/host/src/features/github/failure.ts               | core    |
| packages/host/src/features/github/operation-body.ts        | core    |
| packages/host/src/features/github/ports.ts                 | core    |
| packages/host/src/features/github/session.ts               | core    |
| packages/host/src/features/github/write-session.ts         | core    |
| packages/host/src/features/persistence/agent.ts            | core    |
| packages/host/src/features/persistence/attention.ts        | core    |
| packages/host/src/features/persistence/execution.ts        | core    |
| packages/host/src/features/persistence/fork.ts             | core    |
| packages/host/src/features/persistence/github.ts           | core    |
| packages/host/src/features/persistence/history.ts          | core    |
| packages/host/src/features/persistence/journal.ts          | core    |
| packages/host/src/features/persistence/metadata.ts         | core    |
| packages/host/src/features/persistence/notifications.ts    | core    |
| packages/host/src/features/persistence/retired-roles.ts    | core    |
| packages/host/src/features/persistence/search.ts           | core    |
| packages/host/src/features/persistence/tasks.ts            | core    |
| packages/host/src/features/persistence/workspace.ts        | core    |
| packages/host/src/features/runtime/environment.ts          | core    |
| packages/host/src/features/runtime/workspace.ts            | core    |
| packages/host/src/features/sessions/control.ts             | core    |
| packages/host/src/features/sessions/interactions.ts        | core    |
| packages/host/src/features/sessions/page.ts                | core    |
| packages/host/src/features/sessions/prepare-intent.ts      | core    |
| packages/host/src/features/sessions/retired.ts             | core    |
| packages/host/src/features/sessions/search.ts              | core    |
| packages/host/src/features/sessions/validate-mutation.ts   | core    |
| packages/host/src/features/skills/ports.ts                 | core    |
| packages/host/src/features/skills/session.ts               | core    |
| packages/host/src/features/tasks/retired-model.ts          | core    |

</details>

<details>
<summary>packages/local-state（3 个模块）</summary>

| 模块                                             | 职责    |
| ------------------------------------------------ | ------- |
| packages/local-state/src/exclusive-lock.ts       | adapter |
| packages/local-state/src/private-connection.ts   | adapter |
| packages/local-state/src/private-project-path.ts | adapter |

</details>

<details>
<summary>packages/protocol（45 个模块）</summary>

| 模块                                               | 职责     |
| -------------------------------------------------- | -------- |
| packages/protocol/src/account-management.ts        | contract |
| packages/protocol/src/agent-controls.ts            | contract |
| packages/protocol/src/agent-errors.ts              | contract |
| packages/protocol/src/agent-usage.ts               | contract |
| packages/protocol/src/attachment-protocol.ts       | contract |
| packages/protocol/src/attention-response.ts        | contract |
| packages/protocol/src/attention.ts                 | contract |
| packages/protocol/src/binary.ts                    | contract |
| packages/protocol/src/canonical-json.ts            | contract |
| packages/protocol/src/catalog.ts                   | contract |
| packages/protocol/src/collaboration-protocol.ts    | contract |
| packages/protocol/src/connection-authority.ts      | contract |
| packages/protocol/src/content-protocol.ts          | contract |
| packages/protocol/src/device-metadata.ts           | contract |
| packages/protocol/src/fork-protocol.ts             | contract |
| packages/protocol/src/git-protocol.ts              | contract |
| packages/protocol/src/github-protocol.ts           | contract |
| packages/protocol/src/github-write-protocol.ts     | contract |
| packages/protocol/src/host-command-contract.ts     | contract |
| packages/protocol/src/host-command.ts              | contract |
| packages/protocol/src/host-response.ts             | contract |
| packages/protocol/src/interaction-protocol.ts      | contract |
| packages/protocol/src/mcp-protocol.ts              | contract |
| packages/protocol/src/notification-protocol.ts     | contract |
| packages/protocol/src/permission-review.ts         | contract |
| packages/protocol/src/preview-protocol.ts          | contract |
| packages/protocol/src/private-content.ts           | contract |
| packages/protocol/src/project-content-protocol.ts  | contract |
| packages/protocol/src/protocol.ts                  | contract |
| packages/protocol/src/request-failure.ts           | contract |
| packages/protocol/src/role-protocol.ts             | contract |
| packages/protocol/src/run-config.ts                | contract |
| packages/protocol/src/search-protocol.ts           | contract |
| packages/protocol/src/session-control-protocol.ts  | contract |
| packages/protocol/src/session-events.ts            | contract |
| packages/protocol/src/session-intent-protocol.ts   | contract |
| packages/protocol/src/session-page.ts              | contract |
| packages/protocol/src/session-responses.ts         | contract |
| packages/protocol/src/skills-protocol.ts           | contract |
| packages/protocol/src/task-protocol.ts             | contract |
| packages/protocol/src/value-equality.ts            | contract |
| packages/protocol/src/workspace-attention.ts       | contract |
| packages/protocol/src/workspace-catalog.ts         | contract |
| packages/protocol/src/workspace-client-protocol.ts | contract |
| packages/protocol/src/workspace-target.ts          | contract |

</details>

<details>
<summary>packages/session（9 个模块）</summary>

| 模块                                            | 职责  |
| ----------------------------------------------- | ----- |
| packages/session/src/client-session-replica.ts  | model |
| packages/session/src/collaboration-document.ts  | model |
| packages/session/src/collaboration-replica.ts   | model |
| packages/session/src/model.ts                   | model |
| packages/session/src/session-events.ts          | model |
| packages/session/src/session-operations.ts      | model |
| packages/session/src/session-output.ts          | model |
| packages/session/src/session-schema.ts          | model |
| packages/session/src/session-search-document.ts | model |

</details>

<details>
<summary>packages/sync（3 个模块）</summary>

| 模块                                      | 职责    |
| ----------------------------------------- | ------- |
| packages/sync/src/adapters/sqlite.ts      | adapter |
| packages/sync/src/document/documents.ts   | core    |
| packages/sync/src/document/persistence.ts | core    |

</details>
