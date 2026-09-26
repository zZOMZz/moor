# 设计问题改造与验收依据

本文对应[2026-09-22 设计审查](design-review-2026-09-22.md)，记录每项问题的当前实现与验收范围。审查报告保留原始证据，当前产品能力以[能力表](capabilities.md)为准；“已实现”不代表真实设备或正式发布已验收。

## 完成判定

一项问题需要同时满足对应代码、兼容/迁移说明和行为验证，不能只修改文案或隐藏入口。数据迁移必须保留身份、原操作、冻结输入和主机确认语义；结果未知不能自动改号、改投或重放。

本轮自动化验证只用合成数据与确定性信号。真实双 Mac、iPhone/PWA、Agent 账号和正式签名验收仍需由操作者执行；任何未验证项都不计为完整目标达成。

## 当前改造范围

| 问题                 | 状态         | 当前实现与剩余边界                                                                                                | 说明与验证入口                                                                                           |
| -------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| D01 加密退场         | 仓库验证通过 | 专属UI、v4、secure CLI、构建资源与E2EE包已退场；旧数据只读保留及导出                                              | [退场说明](end-to-end-encryption-deferral.md)、[退场回归](../tests/integration/retired-e2ee.test.ts)     |
| D02 客户端统一       | 仓库验证通过 | Web/Desktop共用界面、控制器、传输和账本；原Web记录按完整身份迁移，离线不执行                                      | [统一浏览器](browser-client.md)、[客户端回归](../tests/integration/browser-workspace.test.ts)            |
| D03 旧功能运行退场   | 仓库验证通过 | 停止预览、角色、旧父子任务和逐回合MCP新增运行；历史读取/原请求检查保留，410不改写旧unknown                        | [退场回归](../tests/integration/retired-session-features.test.ts)、[当前范围](capabilities.md)           |
| D04 范围扩张         | 清单已明确   | 冻结平台扩张，逐项列出本轮用户场景和负责角色；保留当前持久任务语义，后续交付继续受核心设备门槛约束                | [发布清单](capabilities.md#本轮发布清单与负责人)、[路线图](roadmap.md)                                   |
| D05 身份与入口       | 仓库验证通过 | 单工作区简化；按完整身份归组/筛选项目，搜索项目和电脑；配对核实远端workspace；新内部上下文区分catalog/runtime名称 | [概念与身份](concepts.md)、[归组回归](../tests/integration/workspace-project-navigation.test.ts)         |
| D06 512次寿命限制    | 仓库验证通过 | 原操作按ID独立保存；完成记录退出热索引但保留归档，pending不淘汰                                                   | [同步与存储](sync.md)、[记录存储回归](../tests/integration/workspace-records.test.ts)                    |
| D07 跨会话误阻塞     | 仓库验证通过 | 界面和执行层共用当前会话pending判断，真正共享资源的约束保留                                                       | [界面回归](../tests/integration/workspace-app.test.ts)                                                   |
| D08 项目单体账本     | 仓库验证通过 | 多记录原子CAS、会话功能记录、独立附件字节；当前会话自己的内容仍按需读取校验                                       | [同步与存储](sync.md)、[记录存储回归](../tests/integration/workspace-records.test.ts)                    |
| D09 上行CRDT过宽     | 仓库验证通过 | 新普通发送、审批与Attention后续改用窄DTO；Host构造文档，旧Mutation原body与摘要保持兼容                            | [业务意图](session-intents.md)、[Host生命周期](../tests/integration/session-intents.test.ts)             |
| D10 多套意图基础设施 | 仓库验证通过 | 普通新/旧请求与Host内部队列命令共用接受事务及Journal；队列认领使用相位索引，保留各自恢复政策                      | [接口语义](interface-semantics.md)、[队列索引](../packages/host/tests/collaboration-queue-index.test.ts) |
| D11 输出写放大       | 仓库验证通过 | LoroText真实追加、原始增量与有界检查点；所有持久写入比较原读取版本，阻止旧分支覆盖已提交输出                      | [运行与恢复](runtime.md)、[流式回归](../packages/host/tests/stream-output.test.ts)                       |
| D12 全历史启动恢复   | 仓库验证通过 | 持久未结算索引、旧库单次迁移、按会话元数据读取                                                                    | [运行与恢复](runtime.md)、[恢复回归](../packages/host/tests/runtime-recovery.test.ts)                    |
| D13 重复文件基线     | 仓库验证通过 | 内容去重、轻量冻结清单、原子迁移、引用和展开预算保护                                                              | [历史变更](file-changes.md)、[存储回归](../packages/host/tests/project-history-storage.test.ts)          |
| D14 导航全量读取     | 仓库验证通过 | Host私有SQL投影与项目版本支持keyset分页；默认页最多limit+1，不扫全部Flock或正文；查询子串仍按项目筛选             | [分页协议](session-pages.md)、[索引回归](../packages/host/tests/session-metadata-index.test.ts)          |
| D15 重复目录往返     | 仓库验证通过 | 首次聚合目录；业务前后只读取单副本context，共3请求，仍逐次授权                                                    | [范围说明](concepts.md)、[Relay回归](../tests/integration/workspace-catalog-relay.test.ts)               |
| D16 总控与手工映射   | 仓库验证通过 | 45命令共用静态契约、固定HTTP路由、能力/上限与穷举检查；Gateway共性转发集中为有限处理器                            | [核心架构](core.md)、[真实路由回归](../tests/integration/host-command-routes.test.ts)                    |
| D17 安全包边界       | 仓库验证通过 | 锁、私有内容识别、本机连接证明、canonical JSON与IndexedDB适配已独立，普通客户端不再依赖E2EE包                     | [设备安全](device-security.md)、[真实存储CAS](../tests/integration/indexed-storage-cas.test.ts)          |
| D18 加密生命周期     | 仓库验证通过 | 通过完整v4生产退场消除当前生命周期维护负担；未来E2EE继续受独立立项条件约束                                        | [退场条件](end-to-end-encryption-deferral.md)                                                            |
| D19 源码解析漂移     | 仓库验证通过 | 从manifest发现源码出口，不再遗漏sync或混用旧dist                                                                  | [开发与验证](development.md)、[解析回归](../tests/integration/workspace-sources.test.ts)                 |
| D20 构建交付耦合     | 仓库验证通过 | 按Relay/Web/Host/Desktop分目标，复用运行入口与许可；Mac不包含独立Relay                                            | [开发与验证](development.md)、[构建回归](../tests/integration/runtime-build.test.ts)                     |
| D21 死代码入口       | 仓库验证通过 | Knip显式源码映射；私有根barrel收窄；8份真实产物图核对模块与哈希，退场入口和仅测试孤儿已清理                       | [死代码检查](dead-code-checks.md)、[工具回归](../tests/integration/production-reachability.test.ts)      |
| D22 PWA版本交接      | 仓库验证通过 | 新worker等待旧页面关闭；旧hash资源仍可读，不强制刷新或执行                                                        | [运行与恢复](runtime.md)、[升级回归](../tests/integration/service-worker-update.test.ts)                 |
| D23 文档状态冲突     | 仓库验证通过 | 当前能力、README、协议/操作专题和学习文档已对齐新主流程及历史兼容，实现与验证范围已同步记录                       | [能力表](capabilities.md)、[业务意图](session-intents.md)                                                |
| D24 设备验收缺口     | 未完成       | 门槛和首轮基线已明确，尚无本轮最终包真实设备结果                                                                  | [设备验收](validation.md)                                                                                |
| D25 发布输入漂移     | 仓库验证通过 | 镜像固定manifest摘要，根manifest提供产品版本与构建编号                                                            | [部署](../deploy/README.md)                                                                              |
| D26 旧分区清理阻塞   | 仓库验证通过 | 启动不读写或删除旧分区；旧唯一草稿/未知请求保留                                                                   | [兼容策略](browser-client.md)、[启动回归](../tests/integration/retired-client-data.test.ts)              |

## 数据升级原则

- 客户端v1账本只在首次可靠写入时原子迁移，失败保留原格式；离开完成热索引不删除原操作。
- Host恢复索引和历史内容去重属于内部存储升级，对外会话及diff编号/版本保持不变。升级前做完整停机备份；不能让旧二进制直接读取新内部布局。
- 当前Chromium分区和数据库名称即使含有secure，也可能保存普通客户端数据。重构保持其身份和键不变，不能按名称删除。
- 退场只停止不再支持的新增工作流，不伪造原未知结果，不自动封存，不把加密请求改投普通连接。

## 当前自动化验证

使用 `pnpm test:e2e` 验证构建后本机和远程 CLI/Host 的会话闭环，以及 Chromium/IndexedDB 的草稿恢复和工作区布局；`pnpm test` 在 E2E 后运行现有集成与包内回归。身份隔离、事务失败、审批竞争、旧记录保留和索引预算继续使用确定性故障注入验证。入口及覆盖缺口见[开发与验证](development.md)。

提交前运行 `pnpm check`、`pnpm test`、`pnpm build`、`pnpm format:check`；CI 同时运行 `pnpm knip` 和 `pnpm production:check`。测试数量、旧截图与 ad-hoc 包记录不作为新版本的完成依据；旧批次结果留在 Git 历史。

## 当前批次与统一验收边界

本批已收尾 D05、D09、D10、D14、D16，并同步 D23 文档。继续核对设计审查的完成标准并收尾仍有缺口的改造；代码与文档定稿后，对同一最终版本统一执行设备和发布验收。每次代码修改仍单独运行对应仓库检查，不把仓库检查等同于最终验收。

当前仍需操作者完成 D24 的真实双 Mac、iPhone/PWA、真实 Agent 兼容和正式签名/公证验收。仓库中的合成结果、屏幕尺寸模拟与 ad-hoc 包都不能替代这些结论。完成改造不代表整个目标已经完成；验收步骤见[设备验收](validation.md)，当前提供的功能见[能力表](capabilities.md)。

以下是明确保留的兼容与性能边界，并非偷偷删除或替代：旧 Mutation 的原正文、编号和摘要不迁写，Host无法区分仅保存在旧客户端的pending与新构造的同形Mutation，所以严格兼容入口仍保留。新用户请求不再生成CRDT，Host内部已持久队列命令仍可使用原适配，恢复政策不变。TaskDoc继续使用已约定的Loro格式，不在本批整体替换存储；标题子串筛选仍可能扫描本项目的索引候选，不能将其描述为常数时间搜索。
