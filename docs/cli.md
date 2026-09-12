# 会话 CLI

Moor CLI 通过与 Web 相同的主机接口创建、读取、发送和整理会话。主机确认后才报告送达；空会话创建、阅读、配置查看和恢复查询都不会启动 Agent。需要 Node.js 24+，运行 `pnpm build` 后可用 `node dist/cli.mjs` 或 `pnpm cli`。

macOS 程序包同时包含 `Moor.app/Contents/Resources/app/runtime/cli.mjs`，可用 Node.js 24+ 执行该文件。CLI 不会安装全局命令，也不依赖其他应用的数据或源码。中转程序包只包含中转所需程序。

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

## 创建、发送与阅读

```sh
node dist/cli.mjs session create --agent AGENT_ID --file /absolute/title.txt
node dist/cli.mjs session send --file /absolute/prompt.txt --wait --timeout 60000
node dist/cli.mjs session read SESSION_ID --json
node dist/cli.mjs session read SESSION_ID --follow --timeout 60000 --json
node dist/cli.mjs session list --json
```

创建时标题可省略，或通过 `--stdin`/`--file` 提供；新会话自动成为当前选择。创建事务同时保存会话编号、空历史、完整归属和固定 Agent 版本，不启动 ACP 进程。保存失败整体回滚，响应未知时保留原请求编号。

发送正文只能来自 `--stdin` 或 `--file`，最多 100,000 字符且不超过 1 MiB。发送前读取已持久化的历史和固定 Agent 安全配置，通过相同 CRDT 协议构造普通用户回合；只有主机导入并保存操作。可传 `--model ID`、`--effort ID`、`--mode ID`，选项须由该版本的 Agent 能力支持。它们是本次发送的覆盖参数，不追溯修改既有回合。省略时不发送相应覆盖参数，实际值由 Agent 当前原生会话与默认配置决定；CLI 不从上一条 Moor 输入自动复制选项。脚本需要固定行为时应每次明确提供。

`--wait` 等待本次用户回合对应的助手结果；单独 `read --wait` 固定首次读到的用户回合。`--follow` 同时输出变化的历史快照。原助手完成后，即使另一端已经发起新回合，原等待仍可完成。等待默认 60 秒，`--timeout` 为 1–86,400,000 毫秒；普通 HTTP 请求另有 30 秒上限。

等待超时或按 Ctrl-C 只结束当前 CLI 请求/等待，不发送停止操作，也不表明 Agent 已结束。需要停止时，重新读取并明确操作当前助手回合：

```sh
node dist/cli.mjs session stop SESSION_ID --turn ASSISTANT_TURN_ID --wait
```

省略 `--turn` 时使用刚读取的活动助手编号，主机仍对精确回合校验。停止意图先保存；原操作不会因为查询或重试而再次取消新回合。`stopping` 表示尚未确认结束，`interrupted` 表示原回合已因重启或中断结算，不能解释为已确认正常取消。

CLI 可以查看审批和提问相关历史；当前会话 CLI 不提供审批答复、附件上传、角色应用、Skills 安装、Git 写操作或任意 shell 命令。已有审批、附件、角色和 Git 等能力仍使用各自入口，Skills 安装尚未实现，不因 CLI 登录扩大权限。

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
| 7      | 等待超时，未停止 Agent                                 |
| 130    | Ctrl-C 中断 CLI，未停止 Agent                          |

默认状态位于 `~/.moor-cli-v1/moor-cli-v1.sqlite`，可用 `--state-dir` 指定项目外的绝对私有目录。目录使用 `0700`，数据库使用 `0600`；文件、祖先目录或身份变化时停止请求。数据库包含登录凭据与待确认正文，没有额外文件加密，不能提交到 Git、复制到程序包或放入共享目录。项目文件读取与快照额外排除 CLI 保留文件名。

备份前停止使用该状态目录的所有 CLI 进程，并完整保存其数据库和仍存在的 SQLite 辅助文件。客户端状态不替代[执行主机备份](runtime.md#主机停机备份与恢复)。连接描述文件是临时凭据，应由当前主机重新生成，不从备份恢复旧端口和密钥。删除待确认记录会丢失原编号与封存能力，应先处理这些操作。

真实 ACP、双 Mac、iPhone 与安装包仍需[CLI 专项验收](validation.md#m53-cli-专项步骤)。返回[文档目录](README.md)。
