# 旧父子任务的退场与历史核查

Moor 原有的父回合任务计划、`moor_tasks` 工具服务、子会话自动创建/发送/等待、撤销与目录清理执行链已经移除。新版 Host 不再建立新 grant、创建任务 MCP 服务或恢复这些执行授权。

这与当前的 `TaskDoc`、同步及明确提交的持久任务意图不同。新的协作输入与执行队列继续保留，见[接口语义](interface-semantics.md)。不能把本页的旧父子任务表删除策略套用到新的队列。

## 保留什么

旧 `task_grant`、`task_slot`、`task_operation`、`task_revocation` 原表和记录保留，不 `DROP`、不改写状态。新数据库不创建这些表；升级启动也不再把旧 grant/slot/operation 统一改成其他状态。

旧记录中的 `active`、`running`、`pending` 或 `unknown` 表示保存时的状态，不代表新版进程仍持有授权或正在执行。核查不会根据当前文件或另一个会话猜测操作结果，也不会调用嵌套 Git 操作、Agent、MCP 或外部服务来“补齐”回执。

## 只读接口

`tasks-read` 返回当前账号/设备通过 Host 验证的原工作区、项目和父会话中的历史 grant 与操作摘要。`tasks-action` 仅保留 `action: "inspect"`，同时核对原 grant 和 operation ID。读取会验证原请求指纹、槽位身份及完整执行范围；同名项目、另一账号的授权、不同会话或重复编号不能借用原记录。

`abandon`、`revoke`、`cleanup` 和所有新增任务动作明确返回功能退场，不生成成功回执，不改变原 `pending`/`unknown` 状态。旧记录仍可保留到完整主机备份中，见[停机备份](runtime.md#主机停机备份与恢复)。

## 尚未确认的子槽位

`reserved`、`preparing`、`running`、`unknown` 槽位，以及存在 `pending`/`unknown` 原操作的槽位继续阻止普通创建、发送、Git 和 Fork 覆盖同一子会话身份。退出旧执行链不能成为绕过这些保护的方式。

只读核查不会解除此保护。需要处理无法核实的旧工作时，保留完整原记录和工作目录，不把旧 operation ID、子会话 ID 或正文自动改投新的任务。后续人工处置必须作为独立、可核对的操作设计，不能用升级、启动或后台清理代替。

实现入口：[只读任务记录](../packages/host/src/persistence/retired-tasks.ts)、[历史核查](../packages/host/src/sessions/retired.ts)、[退场回归](../tests/integration/retired-session-features.test.ts)。
