# 网页预览退场与原回执

Moor 内置网页预览的配置、浏览器实例、截图/定位及点击、输入、滚动、导航等执行入口已经移除。新版 Host 不启动预览 renderer，也不接受 `--preview-config-stdin`；旧命令在读取私有配置前明确退出。此决定不影响普通项目文件、已有图片附件和冻结历史 diff 的查看。

## 已有数据

旧 `preview-v1.json`、`preview-*` journal、截图附件及客户端保存的原标注保留。升级不删除配置或图片，不重放页面动作，不把未确认记录改成成功、关闭或封存。客户端历史标注继续绑定原截图、版本、选择和输入范围。

## 原操作核查

只保留 `preview-inspect`：请求必须携带完整原动作，Host 按当前账号/设备允许访问的工作区、用户、机器、项目、会话和原 operation ID 核对旧 journal 指纹。它读取已保存回执，或明确报告仍未知，不打开浏览器或访问网页。

响应中的 `closed: true` 只说明新版 Host 没有该预览实例；`phase` 仍来自原回执，没有原回执时保持 `unknown`。页面可能已经发生的外部动作不会因为进程退出而回滚。核查不返回新的页面截图，也不修改旧记录。

旧 `preview-read`、`preview-action`、`preview-close` 路由返回 410。关闭旧界面或重启不能代替原动作的送达确认。需要归档时保留完整私有 Host 数据和客户端数据，不将其放进项目或分发包。

实现：[历史核查](../packages/host/src/sessions/retired.ts)、[只读协议格式](../packages/protocol/src/preview-protocol.ts)、[保留历史标注验证](../tests/integration/project-preview-compatibility.test.ts)、[退场回归](../tests/integration/retired-session-features.test.ts)。
