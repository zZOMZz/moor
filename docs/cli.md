# 会话 CLI

Moor CLI 通过与 Web 相同的主机接口创建、读取、发送和整理会话。主机确认后才报告送达；空会话创建、阅读、配置查看和恢复查询都不会启动 Agent。需要 Node.js 24+，运行 `pnpm build` 后可用 `node dist/cli.mjs` 或 `pnpm cli`。

macOS 程序包同时包含 `Moor.app/Contents/Resources/app/runtime/cli.mjs`。可用 Node.js 24+ 执行，也可使用包内 Electron 的 Node 模式，无需另装 Node：

```sh
ELECTRON_RUN_AS_NODE=1 /Applications/Moor.app/Contents/MacOS/Electron \
  /Applications/Moor.app/Contents/Resources/app/runtime/cli.mjs --help
```

将 `--help` 换成下文的 CLI 参数即可。独立主机同样可用包内可执行文件运行 `runtime/bridge.mjs --local`；配置和数据必须放在程序包外的私有目录，已有桌面主机运行时直接连接它。CLI 不会安装全局命令，也不依赖其他应用的数据或源码。中转程序包只包含中转所需程序。

## 连接执行主机

本机 CLI 连接正在运行的桌面主机，或独立启动的本机主机。连接描述文件位于实际 `--config` 路径后加 `.cli.json`；例如 `/absolute/private-moor/bridge-v3.json.cli.json`。不要猜测旧安装的桌面数据目录，使用实际配置位置。

没有桌面窗口时，可在单独终端运行：

```sh
node dist/bridge.mjs --local \
  --config /absolute/private-moor/bridge-v3.json \
  --runtime-data /absolute/private-moor/runtime-v1.sqlite \
  --project /absolute/test-project --builtin-agent codex
```

`--local` 明确只启动本机服务，不需要配对，也不沿用以前的远程连接。它不能与 `--desktop`、`--server`、`--pair` 或只处理配置的命令组合。已有主机运行时直接连接，不再打开同一个数据库。登记和修改 Agent 的本机命令见[Agent 配置](agent-roles.md)。

```sh
node dist/cli.mjs --connection /absolute/private-moor/bridge-v3.json.cli.json auth login
node dist/cli.mjs targets list --json
node dist/cli.mjs targets use --workspace PRODUCT_WORKSPACE_ID --replica REPLICA_ID
```

`targets list` 返回产品工作区、副本、执行电脑与当前可用 Agent 的编号和安全配置；`targets use` 保存明确的目标。选择时同时提供工作区和副本编号。会话命令也可同时传入 `--workspace`、`--replica` 覆盖当前目标；已有会话用位置参数或 `--session`，两处不能重复。

描述文件是当前用户独占的 `0600` 文件，必须位于项目和程序包之外。客户端先使用随机挑战验证主机持有该连接的密钥，再发送登录凭据和正文；每次请求仍核对原实例、账号与执行范围。正常退出删除本次连接文件，重启生成新凭据。CLI 保存的是描述文件路径，重启后重新读取；不把旧端口当作原主机。

本机路径不符合保护规则时，独立 `--local` 启动失败。已有桌面工作区可继续使用，其本机设置会显示 CLI 不可用；操作者需另行安排私有数据目录，程序不会自动迁移数据库。本机 `auth logout` 清除 CLI 的登录选择和目标，保留原操作记录，不撤销桌面或其他本机客户端的连接。

远程使用明确的 HTTPS 中转 origin 登录。凭据由 stdin 或私有文件提供，不接受密码/token 命令行参数；不要把凭据写进 shell 历史。以下 `login.json` 由操作者放在项目外的私有目录中，包含 `email`、`password` 两个字段：

```sh
node dist/cli.mjs auth login --server https://moor.example.com --file /absolute/private/login.json
node dist/cli.mjs auth status
node dist/cli.mjs targets list --json
```

远程退出登录会请求中转撤销该 CLI 的登录凭据；请求失败仍清除客户端保存的登录，不能据此声称服务器已撤销。HTTPS 校验始终开启，不跟随重定向。HTTP 只允许明确的本机回环地址用于本机服务或隔离开发环境。

已经关联 Google 的个人账号也可通过系统浏览器登录：

```sh
node dist/cli.mjs auth google-start --server https://moor.example.com
```

手动打开返回的 `data.browserUrl`，在浏览器核对服务、邮箱及与 CLI 相同的 `data.code` 并确认。回到同一个 CLI 状态目录，再明确执行：

```sh
node dist/cli.mjs auth google-review
node dist/cli.mjs auth google-confirm --stdin <<'JSON'
{"expectedEmail":"owner@example.com","expectedCode":"AB12-CD34"}
JSON
```

只有 `google-review` 返回 `status:"ready"` 后才确认；将示例替换为刚核对的完整邮箱与大写确认码。输入严格只有 `expectedEmail`、`expectedCode`，不接受 `--file` 或参数中的凭据。取消使用 `auth google-cancel`。这些命令不自动打开浏览器、轮询或重试；CLI 仅提供既有账号登录，建号和绑定在浏览器或 Mac 设置完成。

接续密钥和登录 Cookie 只保存在私有 CLI 状态，URL 不含这些值。最终 POST 前先保存 `finishing`，未知结果不会重复提交；若已保存 Cookie 为 `issued`，在有效期和原状态内手动再次确认只重读 `/api/me`。取消结果的 `serverConfirmed` 区分本机清理与中转确认，完整步骤及未知结果处理见[Google CLI 接续](google-login.md#cli-系统浏览器接续)。

## 导出设备信任连接

`auth export-trust` 与设备安全命令已退场，不再导出登录 Cookie 或生成、配对、撤销、发布设备信任。普通登录、本机连接与账号恢复继续使用各自原有边界；登录成功不表示启用了端到端加密。

## 显式加密连接

独立加密主机、`secure` 执行命令和 `security.mjs` 已退场。旧 `--secure-endpoint`、`--secure-connection` 启动参数在读取配置、设备材料或连接网络前明确失败，不会自动切换到普通 v3 连接。Relay 的旧 v4 和公开信任分发端点返回已退场。

已有设备文件、恢复码、恢复包、Host journal 和映射历史均保留；升级不删除、不重新签名、不执行或封存旧操作。加密传输的旧 CLI 原记录仍留在原私有数据库的 `secure_outbox` 与 `secure_catalog_outbox` 中，不复制到普通操作表。旧会话的 Host 数据不需要格式转换；不得将结果未知请求当作新指令发送。历史设计见[加密历史实现](end-to-end-encryption.md)。

## 退场数据的离线归档

只读检查已有 CLI 状态目录，不需要登录或启动主机：

```sh
node dist/cli.mjs --state-dir /absolute/private/.moor-cli-v1 retired list --json
node dist/cli.mjs --state-dir /absolute/private/.moor-cli-v1 retired export OPERATION_ID \
  --output /absolute/private/archive/original-operation.json --json
```

`list` 每张旧表最多显示 100 个原编号与 `storedState`，并返回总数和是否截断，不输出正文、回执或目标。`storedState` 是之前保存的状态，不是本次向 Host 查询的结论。`pending`、`ending` 仍是未完成确认，不会因导出而改变。

`export` 只查指定原编号在两张旧表中的记录，将原 JSON 字符串和表名原样保存在带 Moor 私有文档标识的文件中。同一编号出现在两张表时一并保留。不会校正未知格式、修改状态、补造回执、联网、运行 Agent 或导入普通会话。输出父目录必须已经存在、由当前用户持有、权限为 `0700` 且无符号链接；文件必须不存在，以 `0600` 新建。每条原记录上限为 128 MiB，超过限制时保留原数据库并采用完整停机备份。导出内容可能包含私有正文，应放在项目和分发目录之外，不加入 Git、附件或共享文档。

归档命令只读打开现有 `moor-cli-v1.sqlite`；目录或文件不存在时失败，不创建新的空状态。它不能恢复早期版本已经丢失的数据。需要保留全部记录时，正常退出使用该目录的 CLI 后备份完整私有目录；Host 数据另按[停机备份](runtime.md#主机停机备份与恢复)处理。

## 创建、发送与阅读

Moor 逐回合附加 MCP 与旧父子任务计划已退场。`session mcp` 只读旧配置摘要；新的指令不携带这些授权。旧 Host 仍可读取、停止和核查原回执，但需升级执行电脑后才能通过当前 Relay 发送新指令。410 退场错误保留明确分类：首次新请求的明确拒绝可记为 rejected；对旧结果未知原操作的人工重试仍保留 pending 和原正文。

```sh
node dist/cli.mjs session create --agent AGENT_ID --file /absolute/title.txt
node dist/cli.mjs session send --file /absolute/prompt.txt --wait --timeout 60000
node dist/cli.mjs session read SESSION_ID --json
node dist/cli.mjs session read SESSION_ID --follow --timeout 60000 --json
node dist/cli.mjs session list --json
```

创建时标题可省略，或通过 `--stdin`/`--file` 提供；新会话自动成为当前选择。创建事务同时保存会话编号、空历史、完整归属和固定 Agent 版本，不启动 ACP 进程。保存失败整体回滚，响应未知时保留原请求编号。

发送正文只能来自 `--stdin` 或 `--file`，最多 100,000 字符且不超过 1 MiB。发送前读取已持久化的历史和固定 Agent 安全配置，冻结 `send-turn` 语义请求；主机负责创建普通用户回合和文档增量。请求包含完整执行身份、原操作与回合编号、正文及经核验的运行选择，不携带客户端生成的会话增量或元数据。主机须报告 `session-intents-v1`，否则在保存新原操作前拒绝发送，不回退旧接口。可传 `--model ID`、`--effort ID`、`--mode ID`，选项须由该版本的 Agent 能力支持。它们是本次发送的覆盖参数，不追溯修改既有回合。省略时不发送相应覆盖参数，实际值由 Agent 当前原生会话与默认配置决定；CLI 不从上一条 Moor 输入自动复制选项。脚本需要固定行为时应每次明确提供。

`--wait` 等待本次用户回合对应的助手结果；单独 `read --wait` 固定首次读到的用户回合。`--follow` 同时输出变化的历史快照。原助手完成后，即使另一端已经发起新回合，原等待仍可完成。等待默认 60 秒，`--timeout` 为 1–86,400,000 毫秒；普通 HTTP 请求另有 30 秒上限。

等待超时或按 Ctrl-C 只结束当前 CLI 请求/等待，不发送停止操作，也不表明 Agent 已结束。需要停止时，重新读取并明确操作当前助手回合：

```sh
node dist/cli.mjs session stop SESSION_ID --turn ASSISTANT_TURN_ID --wait
```

省略 `--turn` 时使用刚读取的活动助手编号，主机仍对精确回合校验。停止意图先保存；原操作不会因为查询或重试而再次取消新回合。`stopping` 表示尚未确认结束，`interrupted` 表示原回合已因重启或中断结算，不能解释为已确认正常取消。

CLI 可以查看审批和提问相关历史；当前会话 CLI 不提供审批答复、附件上传、角色应用、Skills 安装、Git 写操作或任意 shell 命令。审批、附件和 Git 等当前能力仍使用各自入口；旧角色只保留历史核查，Skills 安装尚未实现，不因 CLI 登录扩大权限。

## 整理与配置查看

```sh
node dist/cli.mjs session rename SESSION_ID --file /absolute/title.txt
node dist/cli.mjs session pin SESSION_ID
node dist/cli.mjs session unpin SESSION_ID
node dist/cli.mjs session archive SESSION_ID
node dist/cli.mjs session restore SESSION_ID
node dist/cli.mjs config show --json
```

整理使用刚读取的元数据版本与原操作编号。活动会话不能归档，归档会话必须先恢复再发送；恢复不会启动 Agent。`config show` 离线展示 CLI 状态位置、脱敏连接和选定目标；`targets list` 在线查看目标及 Agent 安全配置。启动命令、环境变量和凭据不进入共享配置输出。

## 结果未知时

CLI 在网络请求前，将完整目标、操作编号、原始请求正文及摘要保存到自身私有 SQLite。读取列表、重新登录、重连和重新启动 CLI 都不会自动发送这些请求。

新发送记录的类型为 `send-turn`。已有类型为 `turn` 的旧 Mutation 原样读取与手动恢复，保存的正文字符串、摘要和路径均不迁移或重新序列化；新请求也不会替代旧待确认记录。CLI 冷重启后重试仍使用同一正文。有关主机生成增量和双格式恢复的边界见[会话语义命令](session-intents.md)。

```sh
node dist/cli.mjs operation list --json
node dist/cli.mjs operation inspect OPERATION_ID --json
node dist/cli.mjs operation retry OPERATION_ID --json
node dist/cli.mjs operation abandon OPERATION_ID --json
```

`inspect` 只向原主机查询，不执行原请求。`found: false` 只表示此刻尚无记录，不能证明原请求以后不会到达。`retry` 是明确的手动重试，保持原编号、正文、配置和执行身份；产品目录路由可以更新，但不能换成另一账号、电脑或项目。已完成的本地记录直接返回确认，不再派发。

`operation list` 最多返回最近 100 条摘要，明确给出 `limit` 与 `truncated`，不加载或输出历史请求正文和完整回执。`receiptStatus` 保留停止结果的区别；单个原编号可通过 `inspect` 继续查询。超过列表上限的记录仍保留，脚本应保存每次命令返回的 `operationId`。

`abandon` 先保存结束意图，再请原主机封存尚未接受的编号。封存与原执行串行竞争；只有主机确认封存后，迟到的原请求才确定不会执行。若主机此前已接受，返回原接受结果，不撤销已执行内容。停止请求的封存也不表示停止 Agent。保存了结束意图的记录只继续封存，不重新派发正文。

原记录状态包括 `pending`、`ending`、`accepted`、`abandoned`、`rejected`。首次明确拒绝可标为 `rejected`；未知请求重试遭拒绝时仍保留原未知状态，不能用后一次失败否定第一次可能成功。`operation inspect` 命令成功只表示完成查询；脚本还必须查看本地 `state`、`inspection.found`，以及 `found: true` 时的 `inspection.receipt.status`。

## 脚本输出与私有状态

除 `--help` 外，输出为版本化 JSON；`--json` 输出每行一条，默认缩进显示。成功写入 stdout，错误写入 stderr：

```json
{
  "cliVersion": 1,
  "ok": false,
  "command": "session send",
  "error": {
    "code": "unknown",
    "message": "原请求结果尚未确认",
    "operationId": "original-operation"
  }
}
```

`--follow --json` 会先输出若干 `data.event: "session"` 快照，最后输出完成结果。历史是会话正文，重定向输出时应保存在私有位置。Node/依赖自身的诊断可能同时出现在 stderr，不应把整个 stderr 当成单个 JSON 文档。

| 退出码 | 含义                                                   |
| ------ | ------------------------------------------------------ |
| 0      | 命令完成；查询仍需检查具体状态                         |
| 1      | 私有状态、输入结构或响应不可验证                       |
| 2      | 命令用法或正文输入错误                                 |
| 3      | 未登录或本机连接不可用                                 |
| 4      | 网络/HTTP 读取失败、响应读取不可确认、离线或未持久保存 |
| 5      | 明确拒绝、范围/能力不匹配，或原停止已中断              |
| 6      | 请求或核查结果未知，保留原编号手动处理                 |
| 7      | 等待超时                                               |
| 130    | Ctrl-C 中断 CLI                                        |

普通 `session` 等待超时或中断不会发送停止操作。旧加密执行与额外 MCP 已退场，其已接受或结果未知的原记录保持原样；不能因退场推断已派发的外部动作停止或回滚。

默认状态位于 `~/.moor-cli-v1/moor-cli-v1.sqlite`，可用 `--state-dir` 指定项目外的绝对私有目录。目录使用 `0700`，数据库使用 `0600`；文件、祖先目录或身份变化时停止请求。数据库包含登录凭据、Google 待完成接续和待确认正文，没有额外文件加密，不能提交到 Git、复制到程序包或放入共享目录。同一次 Google 接续的所有命令必须使用相同的状态目录。项目文件读取与快照额外排除 CLI 保留文件名。

备份前停止使用该状态目录的所有 CLI 进程，并完整保存其数据库和仍存在的 SQLite 辅助文件。客户端状态不替代[执行主机备份](runtime.md#主机停机备份与恢复)。连接描述文件是临时凭据，应由当前主机重新生成，不从备份恢复旧端口和密钥。删除待确认记录会丢失原编号与封存能力，应先处理这些操作。

真实 Google、ACP、Mac mini、MacBook Air、iPhone 与安装包仍需[CLI 专项验收](validation.md#m53-cli-专项步骤)。M6.2 加密会话闭环及跨主机迁移尚未完成。返回[文档目录](README.md)。
