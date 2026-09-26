# 开发与验证

优先通过用户流程验证 Moor：客户端提交操作，经真实 HTTP/WebSocket 到达 Host，由合成 ACP Agent 返回结果，再从客户端确认持久化与恢复。只在端到端流程难以稳定制造的事务失败、权限竞争、路径校验等边界补充集成或单元测试。

## 准备与提交检查

需要 Node.js 24+、Corepack 和锁定的 pnpm 10.20.0；安装始终使用锁文件。不需要其他应用源码、数据库或真实 Agent 账号。

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm test
corepack pnpm build
corepack pnpm format:check
```

`pnpm test` 先构建并运行 E2E，再运行集成与包内测试。Electron 是必需测试运行时，不能通过缺少显示环境而跳过图形流程。Linux 无桌面环境时使用 `xvfb-run --auto-servernum corepack pnpm test`，CI 使用同一入口并安装锁定的 Electron 二进制。

## E2E 入口与覆盖

```sh
corepack pnpm test:e2e
```

这个命令先构建 workspace、Host/CLI 和 Web，再串行运行 [tests/e2e](../tests/e2e/README.md)。失败返回非零；测试使用临时项目、独立账号库和浏览器 profile，退出时清理，不读取用户日常数据。

| 用户流程   | 实际经过的边界                                            | 验证内容                                                                           |
| ---------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 本机会话   | 构建后的 CLI → 本机 HTTP → 独立 Host → stdio ACP          | 登录、空会话、发送/等待、原编号去重、停止、整理、重启读取与退出登录                |
| 远程会话   | 构建后的 CLI → 生产 Relay HTTP/WS → 独立 Host → stdio ACP | 合成账号配对、同一会话闭环与主机重启后的历史/回执；Relay 使用真实应用和独立 SQLite |
| 浏览器恢复 | 构建后的 Web → Chromium/IndexedDB → 合成 HTTP API         | 打开会话、草稿事务落盘、归组保护、离线重开、禁止自动发送、401 回到登录             |
| 工作区界面 | 当前 React/CSS → Chromium → 内存控制器夹具                | 有界分页、项目/电脑选择、主题、侧栏、390px 抽屉和空项目流程                        |

后两项验证浏览器边界，API 或控制器由夹具提供，不构成浏览器到真实 Host 的完整执行证明。精确审批、身份撤销、丢回执、附件、Git/Fork 和共享队列目前主要由集成测试覆盖；新增相关用户流程时优先补到 E2E。真实双 Mac、iPhone/PWA、系统权限、模型服务和正式发布另见[设备验收](validation.md)。

已有构建可定向运行 `node scripts/validation/test.mjs --e2e`，但不能用陈旧产物作为本次修改的验收依据。日常完整入口仍是 `pnpm test:e2e`。

## 集成与边界回归

```sh
corepack pnpm test:integration
corepack pnpm --filter @moor/host test
```

前者运行 `tests/integration` 和各 workspace 的测试；后者只检查所属包。两者适合定位失败，不能代替提交时的 `pnpm test`。

保留以下自动化边界：

- Host 接受事务、同编号去重、审批的活动回合/原请求绑定、停止与重启不重放。
- 账号、设备、工作区、项目、会话隔离，以及撤销后的迟到响应拒绝。
- IndexedDB 多记录 CAS、未确认请求与新草稿不互相覆盖、旧数据只读保留。
- 文件路径与符号链接、容量限制、附件确认、历史 diff 冻结、凭据隔离。
- 程序包白名单、第三方许可、重打包保留 operator 数据与生产可达性。

故障通过明确事件或注入检查点制造：等待 Agent 发出审批后再竞争提交；让数据库在写入时失败后断言没有 prompt；等待 IndexedDB 事务完成后再重载。使用注入计时器控制恢复，不用 `sleep` 猜测异步完成。超时只用于失败截止。

删除测试前确认其执行路径确已移除，或已有更高层流程覆盖同一结果。已退场功能的历史格式、原操作核查与数据保留仍有生产消费者，相关回归继续保留。避免只断言源码字符串、私有函数调用顺序或重复每层相同用例。

## 独立构建与源码边界

| 命令                                      | 交付物                                                |
| ----------------------------------------- | ----------------------------------------------------- |
| `pnpm build:relay`                        | Relay 服务、Web/PWA 及对应许可                        |
| `pnpm build:host`                         | Host 和会话 CLI 的 Node bundle                        |
| `pnpm build:web`                          | Web/PWA、通知 Worker、WASM 和浏览器许可               |
| `pnpm build:desktop`                      | Electron 主进程、preload、页面、Host 与客户端运行组件 |
| `pnpm build`                              | 所有 workspace 和交付物                               |
| `pnpm package:relay` / `pnpm package:mac` | 构建相应交付物后组装分发包                            |

应用入口位于 `apps/{web,desktop,host,relay,cli}`，共享边界位于 `packages/{protocol,session,client,gateway,host,sync}`。`pnpm boundaries` 检查依赖方向；只有 Host 导入并持久接受用户 CRDT 操作，Relay 不保存正文。新增请求必须绑定完整身份，不暴露原始 shell/socket 代理。

开发模式从 workspace manifest 的 `exports.types` 解析源码；Node 构建入口统一在 [runtime-build.mjs](../scripts/build/runtime-build.mjs)，生产构建与开发 watch 共用。每个运行组件按实际依赖生成许可。生成的 `dist`、临时数据库、截图、会话和日志不提交。

桌面开发使用 `pnpm dev:desktop`；修改 Vite、HMR 或原生启动器时，另跑 `pnpm check:desktop:electron`。该专项使用合成 IPC 和隔离空主机，不属于日常会话 E2E，也不证明正式包已通过设备验收。

## 包内与发布检查

对最终 macOS 包运行同一个 CLI 场景：

```sh
MOOR_TEST_PACKAGED_APP=/absolute/release/macos-arm64/Moor.app \
  corepack pnpm exec tsx --test tests/e2e/cli-host.test.ts
```

测试从源码目录之外启动包内 Electron Node、Host 和 CLI，并复制独立合成 ACP。不会修改日常 Moor profile。Relay 仍由测试进程创建；此流程不验证整个包内桌面 UI、Developer ID、公证或真实账号。

```sh
corepack pnpm knip
corepack pnpm knip:production
corepack pnpm build
corepack pnpm production:check
```

Knip 检查源码消费者，生产门禁检查真实构建图及复制资源；测试引用不能证明代码仍在产品使用。不要在运行子进程测试时并行重建 workspace 的 `dist`。细节见[未使用代码与生产可达性](dead-code-checks.md)。

文档和验收记录以当前实现、可运行命令及明确覆盖范围为准。已完成的迁移计划、删除脚本的旧通过数量和截图对比留在 Git 历史，不再作为当前操作指南。
