# 设计问题改造与验收依据

本文对应[2026-09-22 设计审查](design-review-2026-09-22.md)，记录每项问题的当前实现与验收范围。审查报告保留原始证据，当前产品能力以[能力表](capabilities.md)为准；“已实现”不代表真实设备或正式发布已验收。

## 完成判定

一项问题需要同时满足对应代码、兼容/迁移说明和行为验证，不能只修改文案或隐藏入口。数据迁移必须保留身份、原操作、冻结输入和主机确认语义；结果未知不能自动改号、改投或重放。

本轮自动化验证只用合成数据与确定性信号。真实双 Mac、iPhone/PWA、Agent 账号和正式签名验收仍需由操作者执行；任何未验证项都不计为完整目标达成。

## 当前改造范围

| 问题                 | 状态         | 当前实现与剩余边界                                                                                   | 说明与验证入口                                                                                           |
| -------------------- | ------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| D01 加密退场         | 仓库验证通过 | 专属UI、v4、secure CLI、构建资源与E2EE包已退场；旧数据只读保留及导出                                 | [退场说明](end-to-end-encryption.md)、[退场回归](../tests/integration/retired-e2ee.test.ts)              |
| D02 客户端统一       | 仓库验证通过 | Web/Desktop共用界面、控制器、传输和账本；原Web记录按完整身份迁移，离线不执行                         | [统一浏览器](browser-client.md)、[客户端回归](../tests/integration/browser-workspace.test.ts)            |
| D03 旧功能运行退场   | 仓库验证通过 | 停止预览、角色、旧父子任务和逐回合MCP新增运行；历史读取/原请求检查保留，410不改写旧unknown           | [退场回归](../tests/integration/retired-session-features.test.ts)、[当前范围](capabilities.md)           |
| D04 范围扩张         | 范围已明确   | 冻结平台扩张，保留当前持久任务语义；后续交付继续受核心设备门槛约束                                   | [路线图](roadmap.md)                                                                                     |
| D05 身份与入口       | 部分实现     | 单工作区默认简化，目录管理集中账号设置；移动或归组检查所有受影响本机草稿/unknown；内部ID类型仍待收敛 | [概念与身份](concepts.md)、[管理保护](../tests/integration/catalog-data-guard.test.ts)                   |
| D06 512次寿命限制    | 仓库验证通过 | 原操作按ID独立保存；完成记录退出热索引但保留归档，pending不淘汰                                      | [同步与存储](sync.md)、[记录存储回归](../tests/integration/workspace-records.test.ts)                    |
| D07 跨会话误阻塞     | 仓库验证通过 | 界面和执行层共用当前会话pending判断，真正共享资源的约束保留                                          | [界面回归](../tests/integration/workspace-app.test.ts)                                                   |
| D08 项目单体账本     | 仓库验证通过 | 多记录原子CAS、会话功能记录、独立附件字节；当前会话自己的内容仍按需读取校验                          | [同步与存储](sync.md)、[记录存储回归](../tests/integration/workspace-records.test.ts)                    |
| D09 上行CRDT过宽     | 待完成       | 窄意图入口与旧Mutation兼容仍需实施                                                                   | [接口语义](interface-semantics.md)                                                                       |
| D10 多套意图基础设施 | 部分实现     | 旧父子任务执行退场；持久队列按scope/phase/sequence表达式索引认领，共用接受原语待随D09收敛            | [接口语义](interface-semantics.md)、[队列索引](../packages/host/tests/collaboration-queue-index.test.ts) |
| D11 输出写放大       | 仓库验证通过 | LoroText真实追加、原始增量与有界检查点；所有持久写入比较原读取版本，阻止旧分支覆盖已提交输出         | [运行与恢复](runtime.md)、[流式回归](../packages/host/tests/stream-output.test.ts)                       |
| D12 全历史启动恢复   | 仓库验证通过 | 持久未结算索引、旧库单次迁移、按会话元数据读取                                                       | [运行与恢复](runtime.md)、[恢复回归](../packages/host/tests/runtime-recovery.test.ts)                    |
| D13 重复文件基线     | 仓库验证通过 | 内容去重、轻量冻结清单、原子迁移、引用和展开预算保护                                                 | [历史变更](file-changes.md)、[存储回归](../packages/host/tests/project-history-storage.test.ts)          |
| D14 导航全量读取     | 部分实现     | Host有界分页、最近/置顶摘要、服务端筛选及精确失效；缓存每scope最多64页/8MiB，内部元数据仍全量扫描    | [分页协议](session-pages.md)、[真实Relay回归](../tests/integration/session-page-relay.test.ts)           |
| D15 重复目录往返     | 仓库验证通过 | 首次聚合目录；业务前后只读取单副本context，共3请求，仍逐次授权                                       | [范围说明](concepts.md)、[Relay回归](../tests/integration/workspace-catalog-relay.test.ts)               |
| D16 总控与手工映射   | 部分实现     | 传输共用固定路由与响应校验，补齐普通Git/Fork核查；有限命令描述与总控业务拆分仍待实施                 | [核心架构](core.md)、[恢复路由回归](../tests/integration/workspace-operation-recovery-relay.test.ts)     |
| D17 安全包边界       | 仓库验证通过 | 锁、私有内容识别、本机连接证明、canonical JSON与IndexedDB适配已独立，普通客户端不再依赖E2EE包        | [设备安全](device-security.md)、[真实存储CAS](../tests/integration/indexed-storage-cas.test.ts)          |
| D18 加密生命周期     | 仓库验证通过 | 通过完整v4生产退场消除当前生命周期维护负担；未来E2EE继续受独立立项条件约束                           | [退场条件](end-to-end-encryption-deferral.md)                                                            |
| D19 源码解析漂移     | 仓库验证通过 | 从manifest发现源码出口，不再遗漏sync或混用旧dist                                                     | [开发与验证](development.md)、[解析回归](../tests/integration/workspace-sources.test.ts)                 |
| D20 构建交付耦合     | 仓库验证通过 | 按Relay/Web/Host/Desktop分目标，复用运行入口与许可；Mac不包含独立Relay                               | [开发与验证](development.md)、[构建回归](../tests/integration/runtime-build.test.ts)                     |
| D21 死代码入口       | 仓库验证通过 | Knip显式源码映射；私有根barrel收窄；8份真实产物图核对模块与哈希，退场入口和仅测试孤儿已清理          | [死代码检查](dead-code-checks.md)、[工具回归](../tests/integration/production-reachability.test.ts)      |
| D22 PWA版本交接      | 仓库验证通过 | 新worker等待旧页面关闭；旧hash资源仍可读，不强制刷新或执行                                           | [运行与恢复](runtime.md)、[升级回归](../tests/integration/service-worker-update.test.ts)                 |
| D23 文档状态冲突     | 部分实现     | 当前能力表、README、路线图和专题按退场更新；本轮验收记录仍需最终门禁后补齐                           | [能力表](capabilities.md)、[路线图](roadmap.md)                                                          |
| D24 设备验收缺口     | 未完成       | 门槛和首轮基线已明确，尚无本轮最终包真实设备结果                                                     | [设备验收](validation.md)                                                                                |
| D25 发布输入漂移     | 仓库验证通过 | 镜像固定manifest摘要，根manifest提供产品版本与构建编号                                               | [部署](../deploy/README.md)                                                                              |
| D26 旧分区清理阻塞   | 仓库验证通过 | 启动不读写或删除旧分区；旧唯一草稿/未知请求保留                                                      | [兼容策略](client-unification.md)、[启动回归](../tests/integration/retired-client-data.test.ts)          |

## 数据升级原则

- 客户端v1账本只在首次可靠写入时原子迁移，失败保留原格式；离开完成热索引不删除原操作。
- Host恢复索引和历史内容去重属于内部存储升级，对外会话及diff编号/版本保持不变。升级前做完整停机备份；不能让旧二进制直接读取新内部布局。
- 当前Chromium分区和数据库名称即使含有secure，也可能保存普通客户端数据。重构保持其身份和键不变，不能按名称删除。
- 退场只停止不再支持的新增工作流，不伪造原未知结果，不自动封存，不把加密请求改投普通连接。

## 首批整合验证

首批整体运行 `pnpm check`、`CI=1 pnpm test`、`pnpm build`、`pnpm format:check` 和 `pnpm knip`，均通过。测试共 2,747 项，2,743 通过，4 项既有图形专项跳过，失败和取消均为 0。`CI=1` 仅让文件级测试串行执行，不减少用例或放宽超时；此前并行运行中的子进程超时已单独串行复核。完整构建包含 Relay/Web 与 Desktop。锁文件使用离线冻结校验通过，未升级第三方依赖版本。

正式 Mac 发布检查另有 44 项合成回归通过；新分发包无需独立 Relay 服务。多记录存储还在隔离 Electron 的真实 IndexedDB 中验证了比较冲突、写入后失效回滚及并发 CAS。上述验证没有连接真实 Agent、Google 或 GitHub 账号，也不代表双 Mac、iPhone、Docker 部署或正式签名已经完成。

首批当时仍存在的 Knip 冗余入口与客户端双轨问题已在第二批处理；首批通过结论只对应当时提交，不能用于宣称26项全部完成。

## 第二批整合验证

本批整体运行 `pnpm check`、`CI=1 pnpm test`、`pnpm build`、`pnpm format:check`、`pnpm knip` 和 `pnpm production:check`，均通过。完整测试共 1,694 项，全部通过，无失败、取消或跳过。测试数下降来自删除已退场运行路径与旧总控的专属测试；普通身份校验、精确审批、原操作、私有内容、当前IndexedDB与现用组件的验证继续保留或迁至共享实现。锁文件冻结离线校验通过，没有升级第三方版本。

普通账号配对、撤销及目录管理已恢复到共享界面，每次动作绑定已审阅账号，服务端在读取请求体后再次核对授权。目录移动/归组检查所有受影响会话的草稿和原操作。退出登录另覆盖账号切换与响应重排，晚到退出响应不能清除新登录的Cookie。相关76项定向验证通过。

真实 Chromium 与 IndexedDB 的合成检查验证了在线会话、草稿事务落盘、离开会话后草稿仍阻止改绑、离线重开、401回登录，以及全过程零执行请求、零页面错误。实际构建的 Host/CLI 合成往返通过；隔离生成的 macOS arm64 ad-hoc 包也通过包内 Electron/Host/CLI 往返，运行于源码之外的临时目录。分发包只含 bridge、cli、workspace-client三个运行入口，未发现退场运行程序或数据库。生产构建图核对244个实际输出源码和2个类型依赖。

这些结果不等于双 Mac、iPhone、真实Agent/Google/GitHub账号、正式签名或公证验收。ad-hoc包只用于本轮合成验证，未部署或公开分发。

统一工作区另通过真实 Chromium 布局检查：4 个合成项目按新分页协议发出8个最近/置顶摘要请求，在768px高的桌面窗口中可见5条会话；桌面与390px窄屏均无横向溢出，输入栏没有重叠或页面错误。该检查使用有限分页夹具，不依赖退场的旧客户端，也没有降低原来的侧栏密度门槛。

## 继续实施的边界

仍需继续 D09 窄业务命令、D10 接受原语收敛、D16 有限命令注册及稳定业务拆分，以及 D05 内部身份类型与项目归组入口。D14 已实现有界网络分页，但Host内部仍扫描元数据；后续以Host私有可重建索引优化默认首屏，不能把传输下降说成扫描成本已经下降。

旧 Mutation 的原字节、编号和摘要必须保留；新的 typed 入口不得静默降级。Host无法区分仅保存在旧客户端的pending与新构造的同形Mutation，因此保留其严格兼容入口，不伪称已经关闭所有任意增量上行。新普通指令、审批及Attention后续输入将逐步转入窄命令，并共用原有接受事务和回执。D24真实设备与正式签名仍未完成。
