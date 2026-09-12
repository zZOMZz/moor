# 开发与验证

Moor 的主要约束集中在执行边界：谁可以提交操作、何时算送达，以及断线后会不会重复执行。开发时先确定受影响的行为，再选择对应的合成测试。

## 准备与日常检查

需要 Node.js 24+、Corepack 和项目锁定的 pnpm 10.20.0。依赖从仓库锁文件安装，无需准备外部运行时源码。

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm test
corepack pnpm build
corepack pnpm format:check
```

四项检查分别验证类型、行为、构建产物和格式，提交前都要通过。`pnpm test` 先用 esbuild 打包测试，再交给 Node 测试运行器；构建生成的 `dist` 不提交。

只改文档时可以先定向格式化，再检查链接、术语与图示。避免运行全仓库 `format` 时顺手改动其他人的代码。

```sh
corepack pnpm exec prettier --write docs README.md deploy/README.md
```

## 从行为找到实现

下面是阅读入口；具体语义以专题文档和行为测试共同说明，文件名不代替设计解释。

| 要理解或修改的行为     | 主要入口                                                                                                                                | 对应测试                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 会话结构与文档操作     | [session-schema](../src/session-schema.ts)、[model](../src/model.ts)                                                                    | [host](../tests/host.test.ts)、[runtime](../tests/runtime.test.ts)                                          |
| 接受、去重、审批与取消 | [HostWorkspace](../src/bridge/host-workspace.ts)、[校验器](../src/bridge/validate-mutation.ts)、[RuntimeStore](../src/runtime/store.ts) | [host](../tests/host.test.ts)                                                                               |
| 项目归组与跨主机路由   | [Catalog](../src/relay/catalog.ts)、[HTTP 入口](../src/relay/http.ts)                                                                   | [catalog](../tests/catalog.test.ts)、[relay](../tests/relay.test.ts)                                        |
| Agent 接入与运行设置   | [AgentDriver](../src/runtime/agent.ts)、[ACP 实现](../src/runtime/acp.ts)、[运行选项](../src/run-config.ts)                             | [acp](../tests/acp.test.ts)、[runtime](../tests/runtime.test.ts)、[run-config](../tests/run-config.test.ts) |
| 导航、缓存与输出阅读   | [Web 应用](../src/web/app.ts)、[缓存](../src/web/cache.ts)、[内容展示](../src/web/content.ts)                                           | [web](../tests/web.test.ts)、[ui](../tests/ui.test.ts)、[startup](../tests/startup.test.ts)                 |
| 进程恢复与主机独占     | [恢复控制](../src/desktop/recovery.cjs)、[所有权锁](../src/runtime/lock.ts)                                                             | [recovery](../tests/recovery.test.ts)、[runtime-lock](../tests/runtime-lock.test.ts)                        |
| 打包与中转发布         | [程序包](../scripts/relay-package.mjs)、[部署入口](../scripts/deploy-relay.mjs)                                                         | [package](../tests/package.test.ts)、[deploy](../tests/deploy.test.ts)                                      |

## 用合成信号验证故障

单测可以注入 AgentDriver，明确控制何时输出、请求审批、结束或失败。需要验证进程协议时，使用仓库的合成 stdio ACP Agent；它执行真实握手与加载流程，但不会调用真实模型或读取真实 Agent 账号。

例如，验证“保存失败不执行”，应让数据库在写快照时确定性失败：

```text
安装一个写快照就报错的测试触发器
提交合法用户操作
断言提交失败
断言会话和 operation 凭据均未写入
断言 Agent prompt 调用次数为 0
```

验证审批竞争，则先等待合成 Agent 明确发出请求，再提交两个不同选择。验证恢复重试时注入计时器，主动推进时间。不要使用真实账号、私人项目或 `sleep` 猜测异步操作是否完成。

现有测试覆盖了事务回滚、重复编号、并发发送、重启不重放、精确审批与取消、跨项目隔离、真实 stdio 合成会话恢复，以及打包时保留操作者数据且不把数据放进归档。测试通过只证明这些覆盖到的行为。

## 增加能力时先守住边界

增加一个远程操作，应先定义它的请求范围和主机校验规则。会话写入经过 HostWorkspace；只有执行主机导入并持久接受用户 CRDT 操作。不要让中转或新客户端直接保存主机会话。

接入新的 Agent 时，在 AgentDriver 后实现启动、能力读取、输出、审批、取消和恢复。启动路径与凭据留在本机；共享文档只能带允许的输入。依赖版本保持锁定，更新时保留第三方许可证与来源说明。

修改会话格式或桥接协议时，需同时考虑浏览器缓存、主机持久化和旧连接的处理。当前旧运行时升级采用独立数据名称与拒绝旧协议的方式；不能因为能读取某个旧文件，就自动导入待确认操作。

## 发布与真实设备验证

macOS 包需在目标架构的 Mac 上构建；中转包应只包含打包后的程序文件。发布步骤与数据备份见[项目首页](../README.md)和[部署与迁移](../deploy/README.md)，不要把会话记录、凭据、数据库、生成包或内部任务记录提交进 Git。提交主题使用 Conventional Commits，例如 `docs: explain session delivery and recovery`。

真实 Codex/Claude 登录、模型调用、双 Mac + iPhone 的跨设备行为，以及目标服务器的证书与网关仍需在相应环境验收。合成测试、浏览器截图和本机构建都不能替代这些验证；发布说明应明确哪些设备实际测过，哪些尚未测试。

返回[文档目录](README.md)。
