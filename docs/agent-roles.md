# Agent 配置与旧角色记录

> 界面更新：新版客户端已移除网页预览、项目角色、协作任务及逐回合额外 MCP 入口。原角色执行链已退场，只保留历史目录和回执核查。本机 Agent 配置继续保留；Moor 额外 MCP 配置的退场见[MCP](mcp.md)。当前交互以[工作区界面](workspace-ui.md)为准。

当前在执行电脑登记实际运行的 Agent，已有会话固定配置版本。旧项目角色只保留目录与原回执读取，不能新建、编辑或应用到草稿。

## 在执行电脑登记 Agent

先按 [Codex CLI 官方安装说明](https://learn.chatgpt.com/docs/codex/cli)安装并登录，再打开 **Moor → 连接设置 → 本机 Agent 配置**。Moor 不内置或自动安装 Codex runtime；展开面板或刷新设置只读取本机记录，不启动 Agent。

1. 选择“添加 Codex”。Moor 从 `MOOR_CODEX_PATH`、常见安装位置和绝对 `PATH` 目录发现本机可执行文件；未找到时明确显示“未发现本机 Codex，Moor 不内置 runtime”，并提供官方说明入口。
2. 保存配置。新登记默认不用于新会话；自定义配置可明确勾选“用于新会话”。内置适配器的启动配置由 Moor 管理，面板不编辑其程序路径和参数。
3. 需要检查时，点击“检查已保存的连接”。对内置 Codex，先向同一本机程序查询 `--version`，再在独立临时目录打开 ACP 读取能力后关闭，不发送指令，也不创建 Moor 任务历史。检查只针对已保存的配置；修改表单后需先保存新版本。界面显示实际程序路径、安装的适配器版本和程序版本检查时间；无法确认版本或程序文件已更新时明确标示，不用安装包版本冒充执行程序版本。
4. 核对结果，再明确选择“用于新会话”。检查成功不会自动启用。模型和审批模式来自 Agent 实际报告，具体项目中的选项可能不同。

兼容的自定义 ACP 配置仍只能在本机登记：程序选择器要求可执行普通文件的绝对路径，参数是 JSON 字符串数组且不经过 shell 展开。该兼容入口不是选择 Codex CLI 路径的方法；指定其他 Codex 位置应在启动 Moor 前设置 `MOOR_CODEX_PATH`。统一工作区就绪时按执行范围读取能力缓存；打开选择器、切换模型和连续切换会话不重复探测，设置中提供明确的手动刷新。能力探测可以启动临时 ACP 会话，但不发送用户指令或批准请求，详见[模型面板](model-controls.md)。读取 Agent 登记列表或旧角色目录本身不启动 Agent；已有会话继续使用固定版本。

名称或启动参数变化会生成新的版本编号。新会话使用当前启用版本；已有会话及原生 Fork 沿用其固定配置，不被后续编辑、停用或“从新会话列表移除”切换到另一个 Agent。移除也不会删除原会话、原生映射或已确认操作记录。固定的是启动配置，不能据此宣称磁盘上的程序文件、模型服务或第三方账户状态被一并冻结。

启动程序路径、参数和配置快照只保存于执行主机的私有数据中。远端会话和目录只返回允许公开的编号、名称、Agent 类型与能力，不接收任意启动命令。不要把凭据填入角色说明或消息：这些普通正文会按草稿和会话规则保存。

## 本机 CLI

先退出持有原主机数据库的 Moor 实例，再指定同一份配置和数据路径：

```sh
node dist/bridge.mjs \
  --config /absolute/private-moor/bridge-v3.json \
  --runtime-data /absolute/private-moor/runtime-v1.sqlite \
  --agent-config-stdin <<'JSON'
{"action":"read"}
JSON
```

返回 `revision` 与 `presets`。预设的 `id` 标识可编辑登记，`versionId` 标识当前不可变启动版本；角色固定的是后者。CLI 读取结果可能包含本机程序路径与参数，属于本机配置输出。

每次修改使用刚读取的 `expectedRevision`。以下是新建自定义 ACP 的输入示例；路径和参数须替换为实际支持 ACP 的程序，版本值须替换为当前读取值：

```json
{
  "action": "save",
  "expectedRevision": 0,
  "name": "我的 ACP Agent",
  "command": "/absolute/path/to/acp-agent",
  "args": [],
  "enabled": false
}
```

| 动作      | 额外字段                                                     | 结果                                             |
| --------- | ------------------------------------------------------------ | ------------------------------------------------ |
| `builtin` | `agentType: "codex"`                                         | 登记内置 Codex 适配器，默认不用于新会话          |
| `save`    | `name`、`command`、`args`，修改时加预设 `id`，可选 `enabled` | 保存自定义配置；省略 `enabled` 按 `false` 处理   |
| `check`   | 预设 `id` 与刚读取的 `versionId`                             | 明确启动并检查该版本，不发送指令，不改变启用状态 |
| `enabled` | 预设 `id`、`enabled`                                         | 设置是否供新会话选择                             |
| `remove`  | 预设 `id`                                                    | 从新会话列表移除，保留已有会话的版本             |

这些动作都需要 `expectedRevision`；`read` 不需要。一次 stdin 输入一个 JSON，最多 64 KiB。退出码 `0` 表示命令已处理，`1` 表示输入或配置失败，`3` 表示主机锁不可用；连接检查还需查看所选预设的 `checked.ok`，不能仅用退出码判断 Agent 已连通。不能同时使用桌面、配对或其他配置 stdin 入口。版本冲突或响应丢失后先手动读取实际状态，不自动重试本机配置命令。

## 创建和应用项目角色

项目角色的新建、修改、删除和应用入口已退场。旧 `project_role_catalog` 与 `role-*` 原回执保留；已有会话中已经作为用户输入发送的文本不被改写，也不会在新会话自动套用旧角色。

`roles-read` 只读取原项目目录，所有历史角色明确标为不可应用；不会为不存在的目录创建表或记录。正常 Agent 的登记、模型发现和会话固定版本不依赖项目角色功能，继续使用前述入口。

## 角色操作结果未知

`roles-action` 仅保留 `action: "inspect"`，必须携带完整原 `save`/`remove` 请求并核对 operation ID、请求指纹和当前完整执行范围。已有回执原样返回；没有回执只报告未找到，不补做写入。

`save`、`remove`、`abandon` 均明确返回功能退场。升级或只读查询不把未知请求改成已拒绝、成功或封存。历史角色说明可能包含私有内容，只能通过当前已授权的项目范围读取。

实现：[历史目录与回执](../packages/host/src/sessions/retired.ts)、[角色历史格式](../packages/protocol/src/role-protocol.ts)、[退场回归](../tests/integration/retired-session-features.test.ts)。
