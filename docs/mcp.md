# 本机 MCP 配置与逐回合授权

Moor 可以把执行电脑上明确登记的额外 MCP 服务交给当前 Agent。先在本机配置连接、限定项目并启用，再在会话中审查具体配置版本，随一次普通发送授权。读取目录、保存配置、选择服务和刷新页面都不会启动服务或发送指令。

本功能只管理 Moor 添加的服务。原生 Agent 可能仍加载自己的 MCP 设置；Moor 选择为空不表示原生 MCP 全部关闭。有限多 Agent 协作的五个 `moor_tasks` 工具有独立的任务计划与授权，见[协作任务](session-tasks.md)。

## 执行电脑上的设置

打开桌面连接设置中的 MCP 区域，填写名称、说明、允许使用的已登记项目及连接方式。名称和说明会展示给可访问该项目的设备，请勿填入凭据。每项至少选择一个项目，新配置默认停用；保存后明确启用才会进入该项目的会话目录。

| 连接方式 | 本机设置                                                   |
| -------- | ---------------------------------------------------------- |
| stdio    | 普通可执行文件的绝对路径、参数 JSON 数组和可选环境变量     |
| HTTP     | 规范绝对 URL 和可选请求头；由实际 Agent 报告 HTTP MCP 支持 |
| SSE      | 规范绝对 URL 和可选请求头；由实际 Agent 报告 SSE MCP 支持  |

URL 使用 HTTPS；HTTP 仅接受 `localhost`、`127.0.0.1` 或 `[::1]` 回环主机。URL 不接受用户名、密码、查询串和 fragment。仅主机名的 URL 需带末尾 `/`。不允许覆盖 Host、连接管理和代理认证请求头。stdio 路径不接受符号链接，保存与执行时都核对文件可执行、项目目录仍是原登记目录；这不等于固定程序文件字节或 Agent 原生账号。

环境变量和请求头的值只写入主机私有配置，重新读取仅显示已保存的键名。编辑时可选择保留、替换整组或清空；换传输类型不会继承旧凭据。保存不进行连接探测、OAuth 登录或工具调用。实际连接与服务行为由 Agent 负责。

修改名称、说明、项目或连接参数会生成新的不可变版本；停用或移除会撤销使用该配置的当前授权。重新启用不能恢复旧回合的授权。最多保存 100 项未移除配置和 500 个历史版本，达到上限时明确拒绝，不静默清理原记录。

## 在会话中使用

1. 打开会话的 MCP 面板，手动读取当前项目的可用目录。新会话也可先审查，不必发送空指令。
2. 审查名称、说明、传输方式与版本，选择最多 8 项，保存到当前草稿。
3. 检查普通指令并手动发送。发送前重新读取目录，主机接受指令时再次核对原版本、原项目和原连接身份。已失效版本必须重新审查，不自动换成最新版。

主机在接受指令的同一事务中保存私有授权与原操作编号；共享输入只含不透明版本编号，不携带可执行路径、URL、参数、环境变量或请求头。ACP 仅在该回合的 new/load 阶段收到选中的连接描述。能力检查、Fork 创建和协作子任务不继承父回合的额外 MCP；后续回合需要新的明确选择。

离线可保存已有选择为草稿，恢复连接不会发送。原发送回执未知时，手动重试保留原编号与原请求，已接受的指令返回原确认，不启动第二次执行。新草稿不会被旧发送的迟到确认清除。

配置撤销、原连接失效或执行目录身份改变时，Moor 撤销该回合并请求取消、关闭 Agent。已经派发到外部服务的动作可能仍在进行；取消不是外部动作已撤销的确认，应核查原结果后再决定后续操作。Moor 不提供 MCP 原始网络代理或远程设置写入接口。

## CLI

会话 CLI 使用同一只读目录和主机发送边界：

```sh
node dist/cli.mjs session mcp SESSION_ID --json
node dist/cli.mjs session send SESSION_ID --file /absolute/prompt.txt \
  --mcp-server-ids MCP_VERSION_ID,MCP_VERSION_ID
```

省略 `--mcp-server-ids` 时，本次发送不添加 Moor MCP。参数只接受目录中的版本编号；不接受连接配置，且不会沿用上一条指令的选择。恢复方法见[会话 CLI](cli.md#结果未知时)。

没有桌面窗口时，可以在执行主机停止后通过独立本机配置命令管理注册表。输入 JSON 由项目和程序包外的私有文件提供，避免凭据进入命令行历史：

```sh
node dist/bridge.mjs --config /absolute/private-moor/bridge-v3.json \
  --runtime-data /absolute/private-moor/runtime-v1.sqlite \
  --mcp-config-stdin < /absolute/private-moor/mcp-action.json
```

读取请求为 `{"action":"read"}`；保存请求示例不含真实凭据：

```json
{
  "action": "save",
  "expectedRevision": 0,
  "name": "项目工具",
  "description": "供当前项目手动授权使用",
  "projectIds": ["REGISTERED_PROJECT_ID"],
  "enabled": false,
  "connection": {
    "transport": "http",
    "url": "https://tools.example.com/mcp",
    "headers": {}
  }
}
```

编辑添加预设 `id`；所有写操作使用刚读取的 `expectedRevision`。`enabled` 动作提供 `id`、`enabled`；`remove` 动作提供 `id`。stdio 的 `connection` 使用 `command`、`args` 和可选 `env`。同传输类型编辑时省略 `env`/`headers` 保留原值，提供 `{}` 清空。结果只返回安全的本机状态，失败后手动读取，不自动重试。配置命令与启动、配对或其他配置命令互斥，输入上限 64 KiB；已有主机持有数据锁时不能另进程写入。

## 兼容与验证

当前锁定的 Codex ACP 1.11.0 支持 stdio 与 HTTP，Claude ACP 0.76.0 支持三种传输。Moor 对 HTTP/SSE 仍核对本次实际初始化报告，未知或缺失能力会拒绝，不能用名称代替报告。内置 Codex 在当前回合有明确 MCP 授权时使用其配置合并选项，保证选中的 Moor 描述不被原生同名服务替换；普通回合、检查和 Fork 不设置该选项。

合成验证覆盖私有配置、真实本机 CLI/IPC、主机事务与撤权、中转归属变化、Web/IndexedDB 草稿竞争，以及实际 stdio ACP 的 new/load、传输能力和私有值回显处理。若权限选项或问题绑定含私有值而无法原样安全交付，取消或拒绝该请求，不改写身份后提交答案。真实 Agent 登录、实际第三方 MCP 服务、外部写动作、双 Mac 与 iPhone/Safari/PWA 仍需[设备专项验收](validation.md)。

返回[功能计划](roadmap.md) · [文档目录](README.md)。
