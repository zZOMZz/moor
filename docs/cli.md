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

设备公开信任发布与同步使用独立的[设备安全入口](device-security.md)。先核对当前 CLI 的远程账号和服务，再导出到尚不存在的私有文件：

```sh
node dist/cli.mjs auth status
node dist/cli.mjs auth export-trust --output /private/device/.moor-security/trust-connection.json
```

导出不联网、不重新登录，只把当前远程连接写入新文件；成功输出 `data.outputFile`。路径必须绝对，父目录属于当前用户且权限为 `0700`，文件使用 `0600`，禁止符号链接、硬链接和覆盖已有文件。本机 `--connection` 登录不能导出，也不能将其实例密钥当作远程 Cookie。

文件含 Moor 登录凭据，必须放在项目与程序包之外，不输出、手写或共享其中的 Cookie。服务器撤销该 CLI 登录或凭据过期会使导出连接失效；退出请求失败时不能保证已撤销。重新登录后需明确导出新文件。Google 登录允许访问对应账号的公开版本，不能代替完整根 pin 和配对指纹的独立核对。

设备安全命令有 15 个动作：原有 12 个动作和新增 `read-publications` 保持本机操作，只有 `publish-trust`、`sync-trust` 请求固定的公开信任接口，不执行会话或 Agent。待发布队列最多 16 项；发布确认严格匹配原前缀，同步每次完整验证一页后以一次本机 CAS 安装。参数、容量限制与手动恢复见[公开信任版本流程](device-security.md#发布与同步公开信任版本)。公开版本同步本身不启用加密；普通远程会话命令仍使用明文桥接 v3，以下 `secure` 命令才使用加密链路。

## 显式加密连接

先按[设备安全流程](device-security.md)准备已配对、属于同一账号与中转、已安装相同信任检查点的两个端点：执行电脑需要 `host` 角色，CLI 设备需要 `client` 角色。必须独立核对完整根 pin 和配对指纹。两端各自登录自己的个人账号会话；执行电脑用上节命令导出私有连接文件，不复制或手写 Cookie。所有设备文件与状态目录都放在项目、会话工作目录和程序包之外。

在执行电脑明确启动加密主机，Agent 需事先在同一主机数据库中完成本机配置：

```sh
node dist/bridge.mjs \
  --secure-endpoint /absolute/private/.moor-security/host.json \
  --secure-connection /absolute/private/.moor-security/trust-connection.json \
  --runtime-data /absolute/private/runtime.sqlite \
  --project /absolute/test-project
```

两个 `--secure-*` 参数须同时提供，不能与 `--local`、`--desktop`、旧配对或配置命令混用。这一模式不读取旧的远程配对连接，不回落到 v3。主机断开后需手动重新启动；主机运行时独占设备与连接文件，修改或同步信任前先停主机，再明确执行设备安全命令，随后启动新连接。

在已远程登录的 CLI 设备上，读取主机提示，再验证所选主机的加密目录：

```sh
node dist/cli.mjs secure hosts --endpoint /absolute/private/.moor-security/client.json --json
node dist/cli.mjs secure catalog --endpoint /absolute/private/.moor-security/client.json \
  --host HOST_DEVICE_ID --json
```

`hosts` 返回 `verified:false`，只是中转提供的在线提示；成功解密 `catalog` 后才确认对端持有已配对设备的密钥。目录包含实际运行工作区、项目和 Agent 的编号。当前 `secure` 使用运行工作区和本地项目，参数是 `--workspace` 与 `--project`；与普通 CLI 的产品工作区/副本选择分别处理，不继承 `targets use`。

```sh
node dist/cli.mjs secure create --endpoint /absolute/private/.moor-security/client.json \
  --host HOST_DEVICE_ID --workspace RUNTIME_WORKSPACE_ID --project LOCAL_PROJECT_ID \
  --agent AGENT_CONFIG_ID --json
node dist/cli.mjs secure send SESSION_ID --endpoint /absolute/private/.moor-security/client.json \
  --host HOST_DEVICE_ID --workspace RUNTIME_WORKSPACE_ID --project LOCAL_PROJECT_ID \
  --stdin --json <<'PROMPT'
检查当前项目，说明下一步待办。
PROMPT
node dist/cli.mjs secure read SESSION_ID --endpoint /absolute/private/.moor-security/client.json \
  --host HOST_DEVICE_ID --workspace RUNTIME_WORKSPACE_ID --project LOCAL_PROJECT_ID --json
```

同样的明确目标参数支持 `list`、`mcp`、`stop`、`archive`、`restore`、`rename`、`pin`、`unpin`；`list` 不传会话。`rename` 从 `--stdin` 或 `--file` 读取标题，`stop --turn TURN_ID` 核对当前活动回合。`send` 可提供 `--model`、`--effort`、`--mode` 与 `--mcp-server-ids`，已有会话仍固定原 Agent 版本。当前没有审批回应、问题回答、附件上传、`--wait`、`--follow` 或通知子命令；使用手动 `read` 查看结果，需要人工回应的回合仍可精确停止。

发送前先把原请求保存到独立的私有加密操作表。丢失响应、超时或无法验证时退出码为 6，并返回原操作编号；不自动重发，也不把中转错误当成主机拒绝。手动恢复：

```sh
node dist/cli.mjs secure operations --json
node dist/cli.mjs secure inspect OPERATION_ID --endpoint /absolute/private/.moor-security/client.json --json
node dist/cli.mjs secure retry OPERATION_ID --endpoint /absolute/private/.moor-security/client.json --json
node dist/cli.mjs secure abandon OPERATION_ID --endpoint /absolute/private/.moor-security/client.json --json
```

`operations` 只读本机摘要，不含原正文；其余恢复命令从原记录选择主机与执行范围，不能另传目标。重试沿用原操作编号、正文和请求哈希，主机已接受时返回原结果。请求封存后保持 `ending`，在主机确认前不能重试执行；已接受操作不能借封存撤销。旧 `session retry` 无法读取加密操作，避免通过旧 HTTP 发送。这里的“加密操作表”指使用加密传输的私有操作记录，SQLite 正文本身没有磁盘加密。

此入口已加密目录、命令和主机响应；默认桌面、Web/PWA、普通远程 CLI、watch 和通知尚未迁入。完整范围和剩余限制见[端到端加密进展](end-to-end-encryption.md)。

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

`session mcp SESSION_ID --json` 只读取本机登记、已启用且允许当前项目使用的 MCP 版本。审查后可在 `session send` 中明确提供 `--mcp-server-ids ID,ID`，最多 8 项且每次发送前核对；省略时不添加 Moor MCP。配置、凭据和传输能力边界见[本机 MCP](mcp.md)。

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

默认状态位于 `~/.moor-cli-v1/moor-cli-v1.sqlite`，可用 `--state-dir` 指定项目外的绝对私有目录。目录使用 `0700`，数据库使用 `0600`；文件、祖先目录或身份变化时停止请求。数据库包含登录凭据、Google 待完成接续和待确认正文，没有额外文件加密，不能提交到 Git、复制到程序包或放入共享目录。同一次 Google 接续的所有命令必须使用相同的状态目录。项目文件读取与快照额外排除 CLI 保留文件名。

备份前停止使用该状态目录的所有 CLI 进程，并完整保存其数据库和仍存在的 SQLite 辅助文件。客户端状态不替代[执行主机备份](runtime.md#主机停机备份与恢复)。连接描述文件是临时凭据，应由当前主机重新生成，不从备份恢复旧端口和密钥。删除待确认记录会丢失原编号与封存能力，应先处理这些操作。

真实 Google、ACP、Mac mini、MacBook Air、iPhone 与安装包仍需[CLI 专项验收](validation.md#m53-cli-专项步骤)。M6.2 加密会话闭环及跨主机迁移尚未完成。返回[文档目录](README.md)。
