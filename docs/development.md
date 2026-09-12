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

| 要理解或修改的行为     | 主要入口                                                                                                                                                              | 对应测试                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 会话结构与文档操作     | [session-schema](../src/session-schema.ts)、[model](../src/model.ts)                                                                                                  | [host](../tests/host.test.ts)、[runtime](../tests/runtime.test.ts)                                                                                                                         |
| 接受、去重、审批与取消 | [HostWorkspace](../src/bridge/host-workspace.ts)、[校验器](../src/bridge/validate-mutation.ts)、[RuntimeStore](../src/runtime/store.ts)                               | [host](../tests/host.test.ts)                                                                                                                                                              |
| 项目归组与跨主机路由   | [Catalog](../src/relay/catalog.ts)、[HTTP 入口](../src/relay/http.ts)                                                                                                 | [catalog](../tests/catalog.test.ts)、[relay](../tests/relay.test.ts)                                                                                                                       |
| Agent 接入与运行设置   | [AgentDriver](../src/runtime/agent.ts)、[ACP 实现](../src/runtime/acp.ts)、[运行选项](../src/run-config.ts)                                                           | [acp](../tests/acp.test.ts)、[runtime](../tests/runtime.test.ts)、[run-config](../tests/run-config.test.ts)                                                                                |
| 导航、缓存与输出阅读   | [Web 应用](../src/web/app.ts)、[缓存](../src/web/cache.ts)、[内容展示](../src/web/content.ts)                                                                         | [web](../tests/web.test.ts)、[ui](../tests/ui.test.ts)、[startup](../tests/startup.test.ts)                                                                                                |
| 文件范围与内容版本     | [内容协议](../src/content-protocol.ts)、[主机文件读取](../src/runtime/project-files.ts)、[文件缓存](../src/web/file-content.ts)                                       | [协议](../tests/content-protocol.test.ts)、[文件主机](../tests/project-files-host.test.ts)、[文件路由](../tests/file-content-relay.test.ts)、[文件缓存](../tests/file-content-web.test.ts) |
| GitHub 读取与会话关联  | [协议](../src/github-protocol.ts)、[GitHub 客户端](../src/runtime/github-client.ts)、[会话关联](../src/runtime/session-github.ts)、[Web 控制器](../src/web/github.ts) | [客户端](../tests/github-client.test.ts)、[主机](../tests/session-github.test.ts)、[中转](../tests/github-relay.test.ts)、[Web](../tests/github-web.test.ts)                               |
| GitHub 本机私有配置    | [配置](../src/runtime/github-config.ts)、[桌面 IPC](../src/desktop/github-settings.cjs)、[主机入口](../src/bridge/host-main.ts)                                       | [配置](../tests/github-config.test.ts)、[桌面设置](../tests/desktop-github-settings.test.ts)、[真实 CLI/IPC](../tests/github-config-host.test.ts)                                          |
| 进程恢复与主机独占     | [恢复控制](../src/desktop/recovery.cjs)、[所有权锁](../src/runtime/lock.ts)                                                                                           | [recovery](../tests/recovery.test.ts)、[runtime-lock](../tests/runtime-lock.test.ts)                                                                                                       |
| 打包与中转发布         | [程序包](../scripts/relay-package.mjs)、[部署入口](../scripts/deploy-relay.mjs)                                                                                       | [package](../tests/package.test.ts)、[deploy](../tests/deploy.test.ts)                                                                                                                     |

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

会话整理测试覆盖主机确认、元数据版本竞争、响应丢失后的原编号重试和重启后去重；旧格式缺少版本或置顶字段时使用兼容默认值。归档不能绕过活动回合校验，已归档会话拒绝新 prompt，恢复不得调用 Agent。测试同时检查会话正文和原生会话映射没有被整理操作改变，并将关闭后的合成数据库复制到新目录，验证身份、元数据、去重凭据与原生会话 ID 保留。

浏览器待确认请求先持久化再发送，刷新恢复只读取请求，手动重试沿用原操作内容和 operationId。产品工作区归属变化时，路由可以更新，但必须先核对账号、设备、执行工作区、本地项目和会话身份未变；合成测试验证其中任意身份改变都会被拒绝。导航使用 2,000 条合成会话验证首批渲染上限和当前选择保留，不据此推断真实手机性能。

文件读取测试使用临时合成项目，覆盖路径穿越、符号链接与文件替换、大小限制和读取中增长；通过注入检查点产生竞争，不使用等待猜测文件状态。中转测试验证范围变更和权限失效时不返回内容，缓存测试验证摘要、离线版本隔离和晚到响应。协议能力及普通 Node 文件接口的隔离限制见[文件与内容协议](content.md)。

通知测试使用注入时间、合成 IPC/WS 与推送传输，覆盖主机事务、旧连接失效、去重、退出登录、订阅权限、加密请求和密钥文件保护。桌面通知与附件保存测试运行真实模块并注入系统事件和对话框，不接触真实通知中心或 Agent 账号。系统权限、实际文件落盘和 PWA 后台送达仍需[专项设备验收](validation.md#m25-通知专项步骤)。

GitHub 测试使用注入的 HTTP 响应、临时项目和虚构 token，不读取真实 GitHub 凭据，也不调用真实 API。真实主机子进程验证 stdin/私有 IPC、主机锁、文件权限、token 不回显和退出不重放。客户端、主机及页面测试分别覆盖数字仓库身份、fork PR 的 head/base、精确 SHA 的 CI、有限分页、权限撤销、旧响应失效、原编号确认和正文明确加入草稿。文件测试还验证私有配置不能通过项目读取或快照泄露；这些保护不等于原生 Agent 的系统沙箱。

## 增加能力时先守住边界

增加一个远程操作，应先定义它的请求范围和主机校验规则。会话写入经过 HostWorkspace；只有执行主机导入并持久接受用户 CRDT 操作。不要让中转或新客户端直接保存主机会话。

接入新的 Agent 时，在 AgentDriver 后实现启动、能力读取、输出、审批、取消和恢复。启动路径与凭据留在本机；共享文档只能带允许的输入。依赖版本保持锁定，更新时保留第三方许可证与来源说明。

修改会话格式或桥接协议时，需同时考虑浏览器缓存、主机持久化和旧连接的处理。当前旧运行时升级采用独立数据名称与拒绝旧协议的方式；不能因为能读取某个旧文件，就自动导入待确认操作。

GitHub 配置入口只属于本机。远端读取接受类型化的项目与会话请求，不接受 token、任意服务地址、原始 HTTP 路径或 shell。provider 正文只存在于当前读取响应和页面内存，显式加入草稿才按普通会话规则持久化。撤权后确认旧关联操作只返回脱敏回执，不借去重返回旧上下文；外部写操作应在 M4.4 单独设计授权与重试语义。当前范围见[GitHub 文档](github.md)。

网页预览的默认测试不启动图形应用，4 项原生专项明确跳过。有可用图形会话的开发机可执行 `MOOR_TEST_ELECTRON_PREVIEW=1 node --import tsx --test tests/preview-renderer.test.ts tests/desktop-entry.test.ts`；也可设置 `MOOR_TEST_PREVIEW_WORKER` 为最终构建的绝对 worker 路径。专项只启动锁定 Electron 和回环合成 HTTP/WS/TCP/UDP 服务，用事件信号检查输入画面、视口、节点变化与网络隔离，不访问真实网页、凭据或 Agent。包入口测试在 macOS 临时克隆的 Electron.app 中加载合成主模块与 worker，验证固定入口选择，不读取 Moor 用户数据。宿主环境若不允许 Electron 自身沙箱启动，应报告该环境不可用，不能关闭 Chromium 沙箱来使测试通过。实现入口及测试文件见[项目网页预览](preview.md)。

## 发布与真实设备验证

macOS 包需在目标架构的 Mac 上构建；中转包应只包含打包后的程序文件。发布步骤与数据备份见[项目首页](../README.md)和[部署与迁移](../deploy/README.md)，不要把会话记录、凭据、数据库、生成包或内部任务记录提交进 Git。提交主题使用 Conventional Commits，例如 `docs: explain session delivery and recovery`。

第一轮完整真机验收安排在 M0 回归基线与 M1 会话管理实现完成、四项检查通过之后，进入 M2 开发前。第二轮在 M2/M3 各自的可交付流程完成后，重点检查附件、文件预览、通知和 Agent 能力兼容性。涉及休眠、退出、Keychain、PWA 后台或系统权限的改动，应在对应实现完成后提前做一次专项人工检查。步骤与通过条件见[设备验收](validation.md)。

真实 Codex/Claude 登录与模型调用只能由操作者在专用测试项目中人工验收；自动测试不得读取真实 Agent 账号。双 Mac + iPhone 的跨设备行为，以及目标服务器的证书与网关仍需在相应环境验收。合成测试、浏览器截图和本机构建都不能替代这些验证；发布说明应明确哪些设备实际测过，哪些尚未测试。

真实 GitHub 授权、组织限制及 API 状态也须由操作者在专用仓库中另行验收。本批使用合成 HTTP 的检查不证明真实账号已连通，更不表示完成推送、评论或 PR 写入。M4.3 专项步骤见[设备验收](validation.md#m43-github-只读集成专项步骤)。

主机停机备份、恢复与原生 Agent 状态的边界见[运行与恢复](runtime.md#主机停机备份与恢复)。仅恢复会话正文无法保留身份和请求去重；浏览器缓存也不能替代主机备份。

### macOS 正式分发准备

当前 [打包脚本](../scripts/package.mjs) 只执行 ad-hoc 签名并生成 ZIP，没有开发者证书选择、公证提交或票据装订流程。正式分发前需由发布操作者准备 Developer ID 身份和公证凭据，另行实现并审核嵌套可执行文件签名、运行权限配置、公证及验证步骤。证书、私钥和公证凭据不进入仓库、日志或程序包；准备文档不意味着已访问 Keychain 或完成签名。

在干净的目标架构 Mac 上验证下载包的首次打开、Agent 启动、升级后原数据可读和退出行为，记录应用版本、系统/架构、Agent 与锁定适配器版本及未通过项。签名与公证、真机验收未完成时继续标记为开发预览版，不据合成本地测试宣称可正式分发。

返回[文档目录](README.md)。
