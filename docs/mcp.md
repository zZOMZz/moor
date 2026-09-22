# Moor 逐回合附加 MCP 的退场

Moor 自己管理的额外 MCP 配置、逐回合选择和授权注入已经退场。新版 Host 不再根据会话输入启动额外服务、将私有连接参数注入 Agent，或生成新的 `mcp-grant-v1`。`--mcp-config-stdin` 在读取配置前拒绝，CLI 的 `--mcp-server-ids` 在保存或发送指令前拒绝。

本次变化只涉及 Moor 的附加服务。Agent 自己的原生配置不由这些旧设置代替；本次退场不读取、修改或删除 Agent 自己的 MCP 配置。

## 保留的私有记录

Host `runtime_state` 中的 `mcp-settings-v1`、已有 grant 和会话历史输入保持原样。账号、设备、项目、原 operation ID、回合和曾经选择的版本不会自动重绑；升级、打开页面与重新连接不发送旧授权。

普通旧指令已经被 Host 接受时，原操作恢复仍返回此前的确认，不再次执行；此前状态未知的原指令保持原状态。新的非空 `mcpServerIds` 或旧任务计划在 Host 接受指令之前被明确拒绝。

## CLI

`session mcp` 仅可读取当前完整执行范围内的旧配置摘要：版本 ID、名称、说明、传输类型和原目录版本。它不返回 URL、命令参数、环境变量或请求头值，也不授权任何工具。项目路径/设备身份不匹配时不会把旧配置映射到新项目。

```sh
node dist/cli.mjs session mcp SESSION_ID --json
```

其余普通会话发送、停止、精确审批与原操作核查保持原有语义。新 Relay 要求执行电脑报告当前受支持的输入边界后，才接受新的指令；旧 Host 的读取、停止和原回执查询仍可用，升级 Host 后再发送新指令。

## 历史与验证

旧配置含敏感连接材料，应继续放在主机私有数据中；不自动删除，也不导入共享文档。无法确认的旧动作需要保留原文和主机回执分别核查，不能将“本次新请求被拒绝”当作以前的请求从未执行。

实现：[历史摘要读取](../packages/host/src/sessions/retired.ts)、[输入接受边界](../packages/host/src/commands/validate-mutation.ts)、[退场回归](../tests/integration/retired-session-features.test.ts)。旧父子任务的工具服务与新的 TaskDoc 队列边界见[旧父子任务退场](session-tasks.md)。
