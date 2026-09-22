# 设计问题改造与验收依据

本文对应[2026-09-22 设计审查](design-review-2026-09-22.md)，记录每项问题的当前实现与验收范围。审查报告保留原始证据，当前产品能力以[能力表](capabilities.md)为准；“已实现”不代表真实设备或正式发布已验收。

## 完成判定

一项问题需要同时满足对应代码、兼容/迁移说明和行为验证，不能只修改文案或隐藏入口。数据迁移必须保留身份、原操作、冻结输入和主机确认语义；结果未知不能自动改号、改投或重放。

本轮自动化验证只用合成数据与确定性信号。真实双 Mac、iPhone/PWA、Agent 账号和正式签名验收仍需由操作者执行；任何未验证项都不计为完整目标达成。

## 当前改造范围

| 问题                 | 状态         | 当前实现与剩余边界                                                          | 说明与验证入口                                                                                  |
| -------------------- | ------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| D01 加密退场         | 待完成       | 尚未删除专属UI/v4/CLI生产路径                                               | [退场计划](end-to-end-encryption-deferral.md)                                                   |
| D02 客户端统一       | 待完成       | 普通Web与Desktop业务控制器仍需收敛                                          | [统一客户端](client-unification.md)                                                             |
| D03 旧功能运行退场   | 待完成       | 历史读取与新增执行能力仍需逐项分离                                          | [当前范围](capabilities.md)                                                                     |
| D04 范围扩张         | 范围已明确   | 冻结平台扩张，保留当前持久任务语义；后续交付继续受核心设备门槛约束          | [路线图](roadmap.md)                                                                            |
| D05 身份与入口       | 待完成       | 默认入口和明确类型命名仍需统一                                              | [概念与身份](concepts.md)                                                                       |
| D06 512次寿命限制    | 仓库验证通过 | 原操作按ID独立保存；完成记录退出热索引但保留归档，pending不淘汰             | [同步与存储](sync.md)、[记录存储回归](../tests/integration/workspace-records.test.ts)           |
| D07 跨会话误阻塞     | 仓库验证通过 | 界面和执行层共用当前会话pending判断，真正共享资源的约束保留                 | [界面回归](../tests/integration/workspace-app.test.ts)                                          |
| D08 项目单体账本     | 仓库验证通过 | 多记录原子CAS、会话功能记录、独立附件字节；当前会话自己的内容仍按需读取校验 | [同步与存储](sync.md)、[记录存储回归](../tests/integration/workspace-records.test.ts)           |
| D09 上行CRDT过宽     | 待完成       | 窄意图入口与旧Mutation兼容仍需实施                                          | [接口语义](interface-semantics.md)                                                              |
| D10 多套意图基础设施 | 待完成       | 先退场无消费者路径，再收敛共同接受/回执与队列索引                           | [接口语义](interface-semantics.md)                                                              |
| D11 输出写放大       | 待完成       | 需实现真正文本追加、原始增量持久化与检查点                                  | [运行与恢复](runtime.md)                                                                        |
| D12 全历史启动恢复   | 仓库验证通过 | 持久未结算索引、旧库单次迁移、按会话元数据读取                              | [运行与恢复](runtime.md)、[恢复回归](../packages/host/tests/runtime-recovery.test.ts)           |
| D13 重复文件基线     | 仓库验证通过 | 内容去重、轻量冻结清单、原子迁移、引用和展开预算保护                        | [历史变更](file-changes.md)、[存储回归](../packages/host/tests/project-history-storage.test.ts) |
| D14 导航全量读取     | 待完成       | Host分页、最近/置顶摘要与精确失效仍需实施                                   | [工作区界面](workspace-ui.md)                                                                   |
| D15 重复目录往返     | 仓库验证通过 | 首次聚合目录；业务前后只读取单副本context，共3请求，仍逐次授权              | [范围说明](concepts.md)、[Relay回归](../tests/integration/workspace-catalog-relay.test.ts)      |
| D16 总控与手工映射   | 待完成       | 客户端/Host业务拆分及有限命令定义仍需实施                                   | [核心架构](core.md)                                                                             |
| D17 安全包边界       | 部分实现     | 锁与私有内容识别已迁出；本机连接证明、canonical与共享存储仍待加密退场时解耦 | [设备安全](device-security.md)                                                                  |
| D18 加密生命周期     | 待完成       | 以完整v4退场解决当前生产负担，未来需求另立项                                | [退场计划](end-to-end-encryption-deferral.md)                                                   |
| D19 源码解析漂移     | 仓库验证通过 | 从manifest发现源码出口，不再遗漏sync或混用旧dist                            | [开发与验证](development.md)、[解析回归](../tests/integration/workspace-sources.test.ts)        |
| D20 构建交付耦合     | 仓库验证通过 | 按Relay/Web/Host/Desktop分目标，复用运行入口与许可；Mac不包含独立Relay      | [开发与验证](development.md)、[构建回归](../tests/integration/runtime-build.test.ts)            |
| D21 死代码入口       | 待完成       | 仍需收窄入口，并核对最终产品图与包API                                       | [开发与验证](development.md)                                                                    |
| D22 PWA版本交接      | 仓库验证通过 | 新worker等待旧页面关闭；旧hash资源仍可读，不强制刷新或执行                  | [运行与恢复](runtime.md)、[升级回归](../tests/integration/service-worker-update.test.ts)        |
| D23 文档状态冲突     | 部分实现     | 已建立当前能力表并重写路线图；随退场继续清理各专题旧操作指引                | [能力表](capabilities.md)、[路线图](roadmap.md)                                                 |
| D24 设备验收缺口     | 未完成       | 门槛和首轮基线已明确，尚无本轮最终包真实设备结果                            | [设备验收](validation.md)                                                                       |
| D25 发布输入漂移     | 仓库验证通过 | 镜像固定manifest摘要，根manifest提供产品版本与构建编号                      | [部署](../deploy/README.md)                                                                     |
| D26 旧分区清理阻塞   | 仓库验证通过 | 启动不读写或删除旧分区；旧唯一草稿/未知请求保留                             | [兼容策略](client-unification.md)、[启动回归](../tests/integration/retired-client-data.test.ts) |

## 数据升级原则

- 客户端v1账本只在首次可靠写入时原子迁移，失败保留原格式；离开完成热索引不删除原操作。
- Host恢复索引和历史内容去重属于内部存储升级，对外会话及diff编号/版本保持不变。升级前做完整停机备份；不能让旧二进制直接读取新内部布局。
- 当前Chromium分区和数据库名称即使含有secure，也可能保存普通客户端数据。重构保持其身份和键不变，不能按名称删除。
- 退场只停止不再支持的新增工作流，不伪造原未知结果，不自动封存，不把加密请求改投普通连接。

## 首批整合验证

首批整体运行 `pnpm check`、`CI=1 pnpm test`、`pnpm build`、`pnpm format:check` 和 `pnpm knip`，均通过。测试共 2,747 项，2,743 通过，4 项既有图形专项跳过，失败和取消均为 0。`CI=1` 仅让文件级测试串行执行，不减少用例或放宽超时；此前并行运行中的子进程超时已单独串行复核。完整构建包含 Relay/Web 与 Desktop。锁文件使用离线冻结校验通过，未升级第三方依赖版本。

正式 Mac 发布检查另有 44 项合成回归通过；新分发包无需独立 Relay 服务。多记录存储还在隔离 Electron 的真实 IndexedDB 中验证了比较冲突、写入后失效回滚及并发 CAS。上述验证没有连接真实 Agent、Google 或 GitHub 账号，也不代表双 Mac、iPhone、Docker 部署或正式签名已经完成。

Knip 仍提示一处冗余入口配置，D21 的真实入口收敛尚未完成。加密退场、客户端统一和流式输出仍按表中状态继续处理；不能以本批门禁通过宣称26项全部完成。
