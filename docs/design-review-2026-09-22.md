# Moor 设计审查与简化建议

审查日期：2026-09-22。最终核对基准：`ce42138`（`docs(e2ee): defer encryption and document retirement plan`）。审查开始时以 `d108ffb` 及已有未提交修改为对象；整理期间这些修改已纳入 `69e854d`、`ce42138`，关键代码证据已复核。

本文保留审查时的事实与判断，源码和方案链接固定到上述基准版本；后续重构以当前实现和对应专题文档为准。

## 结论

Moor 最需要解决的是**产品范围与实现复杂度失衡、同一业务的多套实现长期并存，以及可靠性机制缺少完整的容量和生命周期设计**。

“加密工作区”是最明显的例子：端到端加密有明确安全价值，但当前实现把一种连接安全属性做成了第二套工作区、控制器、存储、设备管理和恢复流程。项目已经决定延期，这个方向合理；当前问题是退场还没有落实到运行代码。类似问题还存在于旧协作任务、网页预览、客户端统一和文档维护中。

本次归纳了 **26 项主问题**。其中既有可以直接修复的缺陷，也有需要取舍的架构设计。优先处理的五件事是：

1. 修复桌面操作账本累计 512 条后不能继续操作，以及一个会话阻塞同项目其他会话的问题。
2. 落实加密与已退场功能的清理，保护历史数据，停止维护多套业务界面。
3. 减少普通请求的重复身份/目录读取，以及输出流的整份快照写放大。
4. 让 Web 与 Desktop 使用同一套会话状态、业务控制器和组件。
5. 把发布前的核心真实设备验收放到继续扩展功能之前。

不建议开展一次全量重写，不建议现在替换所有 CRDT，也不建议为了减少代码删除主机确认、精确审批、身份绑定或幂等恢复。

## 审查范围与证据强度

覆盖了产品说明、Web/Desktop/CLI 入口、Host 与 ACP 接入、会话/任务/同步协议、客户端持久化、Relay、E2EE、构建部署及验证安排。生产源码目录共扫描到 288 个 TS/TSX/JS/CJS/MJS 文件、95,487 行；其中 Web 为 36,527 行，Host 包为 26,190 行，E2EE 包为 4,211 行。另有 233 个 `.test.ts` 文件和 40 篇 `docs` 文档。行数包含注释及空行，仅用于说明规模，不能直接证明过度设计。

本报告采用入口追踪、调用链和存储检查、跨模块对照、定向合成实验；没有逐条验证所有分支，不能保证穷尽全部缺陷。代码位置按当前工作区记录，后续修改可能使行号变化。

证据标记：

- **复现**：调用实际实现或底层模型，以内存合成数据验证。
- **静态确认**：源码明确存在对应行为，但未完成完整 UI 或真实设备复现。
- **设计判断**：事实已核对，是否调整取决于产品目标或规模；不能当成已发生故障。

优先级：**P1** 为近期应处理的问题；**P2** 为随后降低维护或规模成本的问题；**P3** 为有使用证据后再做的改善。本次没有确认需要立即停服的 P0 漏洞。改造量的“小/中/大”表示涉及范围，不是工期承诺。

## 问题总表

| 编号 | 问题                                                 | 优先级 | 证据               | 建议动作                             | 改造量         |
| ---- | ---------------------------------------------------- | ------ | ------------------ | ------------------------------------ | -------------- |
| D01  | 加密延期未落实，普通工作区仍依赖加密链路             | P1     | 静态确认           | 执行退场，解除启动依赖               | 大             |
| D02  | 统一界面之下仍维护多套客户端业务                     | P1     | 静态确认           | 统一控制器和组件，保留传输适配       | 大             |
| D03  | 功能入口移除后，运行能力与恢复负担仍长期保留         | P1     | 静态确认           | 明确只读兼容与运行退场边界           | 中/大          |
| D04  | 个人多设备核心尚未验收，协作与平台能力持续扩张       | P2     | 设计判断           | 冻结扩展，明确近期产品范围           | 小             |
| D05  | 组织身份层级与名称给用户、开发者增加理解负担         | P2     | 设计判断           | 保留身份隔离，简化默认入口和命名     | 中             |
| D06  | 项目操作账本累计 512 条后无法继续写入                | P1     | 复现               | 按操作存储，归档已完成记录           | 中             |
| D07  | 一个会话的待确认操作阻塞同项目其他会话               | P1     | 静态确认           | 按会话与真实冲突资源限制             | 小             |
| D08  | 整个项目共用一个大型操作账本                         | P1     | 静态确认           | 分离操作、会话状态和附件字节         | 中/大          |
| D09  | 简单业务命令通过任意 CRDT 增量表达，再做完整差分验证 | P2     | 设计判断           | 新入口用类型化意图，保留文档格式     | 大             |
| D10  | 三类意图与恢复模型并行，通用执行原语重复             | P1     | 静态确认＋设计判断 | 共用接受与回执，保留不同授权政策     | 中/大          |
| D11  | 每个输出片段复制并保存完整会话与元数据               | P1     | 复现＋静态确认     | 增量持久化与有界检查点               | 中/大          |
| D12  | 启动恢复扫描全部历史并重复扫描元数据                 | P2     | 静态确认           | 活跃状态索引、一次迁移、定向恢复     | 中             |
| D13  | 每回合保存完整项目双快照，缺少跨回合去重             | P2     | 静态确认           | 内容去重和冻结清单，保留历史真实性   | 中/大          |
| D14  | 导航拉取所有项目的完整列表，只展示少量最近会话       | P2     | 静态确认           | Host 分页与增量失效                  | 中             |
| D15  | 一个普通桌面业务请求重复进行两轮完整目录校验         | P1     | 复现               | 合并目录读取，使用明确版本与失效机制 | 中             |
| D16  | 大型总控模块与多处手工协议映射抵消了分包收益         | P2     | 静态确认           | 按业务拆分，集中有限命令描述         | 中             |
| D17  | 通用安全原语放进 E2EE 包，退场边界被污染             | P2     | 静态确认           | 按实际消费者迁移共享原语             | 小/中          |
| D18  | 加密链路有配额、撤销和恢复生命周期缺口               | P1     | 静态确认           | 当前退场，未来立项前补齐设计         | 当前中；未来大 |
| D19  | 多份包清单造成源码与构建产物混用                     | P1     | 复现＋静态确认     | 从 workspace 元数据生成解析清单      | 小/中          |
| D20  | Relay 打包依赖完整 Desktop 构建                      | P2     | 静态确认           | 按交付物构建，共享基础配置           | 中             |
| D21  | 死代码检查把整包源码视为入口，削弱退场验证           | P2     | 静态确认           | 以真实入口验证可达性                 | 小/中          |
| D22  | PWA 立即接管并删除旧资源缓存，缺少版本交接           | P2     | 设计判断           | 保留使用中的资源版本，安全更新提示   | 中             |
| D23  | 当前说明、历史验收与计划状态互相矛盾                 | P1     | 静态确认           | 一个当前能力表，历史文档单独归档     | 小/中          |
| D24  | 合成验证持续扩张，核心真实设备验收长期滞后           | P1     | 静态确认           | 核心流程发布门槛与分层验证           | 中             |
| D25  | 应用依赖锁定，部署镜像和产品版本仍分散维护           | P2     | 静态确认           | 固定镜像摘要、单一版本来源           | 小             |
| D26  | 旧客户端清理被设为新客户端启动硬门槛                 | P1     | 静态确认           | 分离清理与启动，明确旧数据退场契约   | 小/中          |

## 产品与架构边界

### D01：加密延期是正确决策，但目前仍是文档决策

**证据。** [退场计划](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/docs/end-to-end-encryption-deferral.md)第 5、36 行明确延期，并规定不能长期只隐藏入口；但 [workspace-app.tsx](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/app/workspace-app.tsx)第 1617 行要求普通工作区同时存在 `moorWorkspace` 和 `moorSecure`，第 1625 行无条件创建加密控制器。[Relay HTTP 入口](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/gateway/src/http.ts)第 220、261、3125 行仍装配信任发布、加密中转及 v4 upgrade。构建还生成 `security.mjs` 和加密客户端。

**问题。** 用户没有选择加密，也必须承担其启动接线和维护负担；直接删除加密 preload 还会破坏普通工作区启动。现有计划不能被算作已完成的简化。

**建议。** 按已有计划完成实际退场：先解除普通入口依赖，停止新增 secure 记录，再移除专属 UI、桥接、传输、Host/Relay/CLI 运行入口及其构建资源。历史读取与原操作处置采用有限兼容路径；不能把 secure 未确认请求改走普通连接。

**完成标准。** 不提供加密桥接时普通客户端能独立启动；发布包与网络端点无退场入口；历史数据未删除、未重放。将来重新立项时，加密成为连接的安全属性，复用相同业务界面；不得静默降级为明文。

### D02：客户端统一停留在外壳层面

**证据。** [entry.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/app/entry.ts)第 6—18、63—74 行分别进入 Desktop Workspace、SecureApp、协作页和普通 Web App；[workspace-app.tsx](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/app/workspace-app.tsx)第 1586—1593 行还通过 `hidden` 切换独立 SecureApp。普通 [app.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/app/app.ts)为 4,748 行，桌面 Workspace 为 1,654 行，SecureApp 为 2,068 行，另有各自控制器与 feature 适配。

普通 Web 还在 [ui.tsx](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/components/ui.tsx)第 77—86 行通过 `paint`、`flushSync` 和统一监听器广播衔接命令式状态；[app.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/app/app.ts)第 340 行起维护多组模块级状态。

**影响。** 同一个模型选择、草稿保留、审批和恢复问题需要在多个入口修复；共用样式或放进同一个窗口不能消除行为差异。

**建议。** 选择一套会话 ViewModel/Controller 作为主实现，先统一发送、停止、审批和历史读取，再迁移附件/Git 等能力。HTTP、本机 IPC 和未来加密实现只负责传输与平台能力。协作队列如保留，应作为同一会话的视图，而不是继续复制整套应用。

**完成标准。** 相同业务用例以同一组行为契约分别验证 HTTP 与 IPC；修改发送策略只需修改一个业务入口。无需新建通用插件框架或新的全局状态框架。

### D03：移除界面，不等于完成了功能退场

**证据。** [README](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/README.md)说明网页预览、角色、协作任务和逐回合额外 MCP 的客户端入口已移除。但 [WorkspaceStore](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/features/workspace/workspace-store.ts)第 135—147 行仍维护对应状态；[WorkspaceController](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/features/workspace/workspace-controller.ts)第 1506、2551—2570、2598—2600 行仍涉及旧任务/MCP 恢复和发送绑定；Host 中的 `sessions/tasks.ts`、`sessions/preview.ts`、`sessions/roles.ts`、`integrations/task-mcp.ts` 及预览渲染器仍存在运行实现。

更直接的运行证据是 [host-command.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/commands/host-command.ts)第 131—155 行继续分发任务、角色和预览操作，[HostWorkspace](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/sessions/workspace.ts)第 304—306 行继续实例化对应管理器。保留历史状态本身不是问题，需要清理的是没有当前产品消费者的新执行能力。

**问题。** “历史必须可读”容易被扩展为“旧功能的完整执行系统必须永久存在”。每一条继续可执行的兼容路径都需要授权、异常恢复和回归验证。

**建议。** 为每项退场能力列出三个范围：历史数据读取；结果未知操作的必要核查/处置；允许创建的新操作。默认关闭第三类，证明仍有消费者后才保留具体写入路径。按产品决定逐项退场，不能仅凭名称批量删除，尤其不能把新的持久任务意图与旧父子任务混为一谈。

**完成标准。** 普通新会话不再携带退场能力状态；无新增业务入口或不再必要的后台资源；已有原操作仍保留必要核查及明确恢复路径。兼容支持范围应明确，但不能因期限自动删除、封存或改投未知请求。删除后保留共用的安全、数据恢复测试。

### D04：个人多设备工具正在承担平台级范围

**证据。** [README](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/README.md)定位个人开发预览；[Catalog](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/gateway/src/catalog.ts)第 24—73 行已包含跨账号协作成员/权限，[entry.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/app/entry.ts)第 63 行有独立协作入口；[接口语义](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/docs/interface-semantics.md)包含共享 TaskDoc、成员授权、双通道送达与持久队列。旧父子任务、PR 全流程、预览渲染等也已实现，而 [roadmap](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/docs/roadmap.md)第 21—41 行列出的核心真机验收仍多为待完成。

**判断。** 这些能力各自有价值，但组合起来远超“手机继续自己电脑上的会话”。本报告不能仅凭个人定位断言协作无需求；需要产品明确选择。

**建议。** 近期以本机/远程会话、附件、审批、停止、历史和基础 Git 为闭环。共享执行队列若是当前明确需求，就纳入同一主流程并给出验收门槛；否则冻结新增产品入口，保留已承诺数据语义。PR 发布中心、复杂子任务编排、预览与新 Agent 扩展分别按实际使用反馈立项。

**完成标准。** 发布清单中每个功能有明确用户场景和负责人；待验收核心流程没有关闭前，不继续以“协议可扩展”为理由增加整条功能链。

### D05：身份层级必要，但默认体验和名称可以更简单

**证据。** [概念与身份](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/docs/concepts.md)区分 Workspace、RuntimeWorkspace、HostBinding、Project、ProjectReplica、deviceId、machineId；[workspace-target.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/protocol/src/workspace-target.ts)第 5—17 行同时携带 `workspaceId` 与 `catalogWorkspaceId`。同名 `workspaceId` 在不同协议层意义不同。

**问题。** 单用户一台电脑也要理解组织目录、执行工作区和项目副本，开发者还容易把同为字符串的两类 ID 互换。这是暴露方式和命名的问题，不意味着可以合并授权身份。

**建议。** 默认个人工作区自动建立；主流程只显示项目和执行电脑，多工作区与副本归组放到管理设置。新内部 API 使用 `catalogWorkspaceId`、`runtimeWorkspaceId` 等明确名称，可用轻量类型区分；线上旧字段只在边界转换。名称相同、路径相同不得自动合并身份。

**完成标准。** 单电脑首次使用不需要理解副本模型；跨电脑时始终清楚当前执行位置；归组不会改变已创建会话和未确认操作的执行目标。

## 操作、存储与执行

### D06：操作账本具有“用够次数就不能再用”的硬上限

**证据。** [workspace-store.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/features/workspace/workspace-store.ts)第 134 行限制 `operations.max(512)`；第 651 行持续追加；第 1149 行完成时只更新状态，没有完成记录的删除或归档路径。

**合成复现。** 使用实际 `WorkspaceStore` 和纯内存 backend，预置 512 条合法 `confirmed` 记录，读取正常；追加第 513 条时得到 Zod `too_big`，`maximum: 512`、`path: [operations]`，账本仍保留原 512 条。所有数据均为虚构，没有使用真实会话。

**影响。** 这不是同时有 512 个未完成请求的防护，而是按项目累计的使用寿命限制。增加上限只能推迟故障。

**建议。** 将每条操作独立保存；未确认记录完整保留；已完成记录进入分页历史或精简为回执索引。客户端热数据保留策略与 Host 幂等凭据寿命分别设计。不能通过清空整个 IndexedDB 解决，更不能删除未知结果的原始请求。

**完成标准。** 超过现有上限的连续成功操作仍可继续；刷新、跨窗口竞争和未知结果恢复保留原编号；故障时不破坏原记录。

### D07：会话级风险被扩大成项目级阻塞

**证据。** [workspace-app.tsx](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/app/workspace-app.tsx)第 253 行获取整个项目全部 pending，第 273 行用 `!pending.length` 决定当前会话能否发送；但 [WorkspaceController](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/features/workspace/workspace-controller.ts)第 2608—2611 行实际按 `sessionId` 检查。

**触发条件。** A 会话有结果待确认；切到同项目的空闲 B 会话；B 的输入本来有效，但发送按钮仍被项目中 A 的 pending 禁用。这个结论来自 UI 条件和控制器对照，本次未操作真实窗口复现。

**建议。** 共用一个按资源范围计算的阻塞函数。会话内原操作只阻塞本会话；共享工作目录的 Git 变更等确有冲突时，按目录/资源扩大范围。项目级待确认总览保留为提醒。

**完成标准。** A 未确认不影响无冲突的 B；A 本身和共享目录冲突仍受保护；界面与执行层使用同一判断来源。

### D08：可靠操作账本承担过多数据，局部操作变成全项目重写

**证据。** [workspace-store.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/features/workspace/workspace-store.ts)第 129—147 行把操作、附件、Git、GitHub、任务、角色、标注等放到一个 Ledger。第 276—404 行校验全量关联，第 406—424 行读取、克隆、序列化计量并 CAS 写回整份对象。[WorkspaceController](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/features/workspace/workspace-controller.ts)第 255—256 行取得状态又会 `structuredClone`；[workspace-attachments.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/features/attachments/workspace-attachments.ts)的校验还包含附件摘要。

**影响。** 一个会话的状态更新会受到其他会话历史和附件体积影响；256 MiB 总预算意味着拒绝增长，不能解决每次全量处理。这里确认的是算法与存储粒度问题，未测真实手机延迟。

**建议。** 将不可变原操作、完成回执、会话功能状态、可丢弃缓存和附件 Blob 分开。使用数据库事务及记录版本保证一致性，只验证本次触及的对象；通过引用固定附件与审阅快照，避免把大字节对象复制进 UI 状态。

**完成标准。** 修改 B 会话不需要复制或重新哈希 A 的附件；仍能检测陈旧版本、跨范围引用和多窗口冲突；迁移保留所有未知请求。

### D09：上行 CRDT 操作比当前允许的业务表达更宽

**证据。** [validate-mutation.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/commands/validate-mutation.ts)第 31—53 行复制 Flock、文档并导入客户端增量；第 78、114—123 行又证明其他字段没有变，只允许追加一个用户回合。审批也有精确的受限语义，而不是任意共同编辑。

**判断。** 本次证据不足以认定现有 CRDT 下行与历史格式应整体替换；但当主机是唯一执行和持久化权威、草稿不共享时，客户端先构造通用编辑再由主机还原业务意图，会增加校验面与整文档成本。

**建议。** 新入口采用 `SendTurn`、`RespondPermission`、`UpdateSessionMetadata` 等窄命令，由 Host 验证并生成文档操作。先复用现有 schema、存储和下行同步，不以此为由迁移全部历史或更换 CRDT。已有 `Mutation` 作为有限兼容适配，逐步减少生产调用。

**完成标准。** 客户端不能编写 Host 执行状态；同编号不同内容仍拒绝；历史文档可读；重试仍绑定原目标和输入。该项应在核心稳定后分段实施，不能先做“大换存储”。

**TaskDoc 也应单独评估。** [collaboration-replica.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/session/src/collaboration-replica.ts)第 95—128 行把不可变操作和完整任务状态作为 JSON 字符串存入 Loro Map，第 54—93 行在读取时全量解码与排序；[sync/store.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/sync/src/store.ts)第 228—243、392—397 行在状态发布时加载并保存完整文档。公开文档和私有执行账本分离有其必要性，但现有数据主要由不可变意图和 Host 单写状态组成。先优化增量与索引，再依据真实共同编辑需求评估 CRDT 的适用范围；“SQL 权威状态＋幂等提交＋顺序事件同步”可以作为对照方案，不是本次要求实施的替换。无论选哪种机制，都必须保留离线明确提交、冻结授权和公开投影原子更新。

### D10：三类任务语义需要共用基础设施，但不能强行合成一种恢复政策

**证据。** 当前有普通 `Mutation + Journal`、[TaskStore/SessionTaskManager](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/sessions/tasks.ts)的父回合子任务，以及 [CollaborationCoordinator](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/sessions/collaboration-coordinator.ts)与 [CollaborationExecutionStore](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/persistence/collaboration-execution-store.ts)的持久用户任务。后两者最终仍汇入 Host 的回合接受路径，并不是三个独立 Agent 派发器。

**问题。** 输入冻结、去重、原请求保存、接受结果和恢复展示分散在多个系统，后续功能容易再增加第四套。持久队列还在 [collaboration-execution-store.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/persistence/collaboration-execution-store.ts)第 143—156 行每次 claim 读取全部历史并解析 JSON 寻找活动/排队任务。

**建议。** 共用“固定输入 → 验证授权 → 原子接受 → 回执查询”的基础原语。保留三类政策：立即命令结果未知时人工核查；明确提交的 durable intent 可重连入队；子任务受父回合授权与预算约束。队列相位存为可索引列，claim 只查活动项和首个 queued 项。

**完成标准。** 同一输入不会通过 RPC 和文档同步执行两次；未知普通命令不会被自动升级为队列任务；草稿与已提交意图始终分开；完成任务数量不线性增加每次队列认领成本。

### D11：流式输出存在显著全快照写放大

**证据。** [HostWorkspace.edit](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/sessions/workspace.ts)第 2174—2194 行每次创建候选 LoroDoc、导出/导入当前完整快照，再开事务保存；第 2196—2226 行将每个文本 chunk 接入此路径。[RuntimeStore.persist](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/persistence/store.ts)第 281—286 行写完整 session snapshot 和元数据；[Journal](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/persistence/journal.ts)第 32—35 行使用同步 SQLite 与 `synchronous=FULL`。

**合成证据。** 内存 Loro 与当前 Mirror schema，固定种子 `123456789` 生成 10,000 字符 ASCII：一次写入的快照为 20,704 bytes；分 100 次、每次 100 字符写入，最终快照为 23,460 bytes，但累计导出快照为 1,184,995 bytes，约为一次写入的 57.2 倍。此实验只证明快照字节放大，不是实际 SQLite 写入量、耗时或设备性能测试。

进一步用相同输入、每次仅导出更新前版本向量之后的 Loro update：一次写入为 10,088 bytes，100 次累计为 513,798 bytes，约 50.9 倍。原因是 [session-schema.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/session/src/session-schema.ts)的文本为普通字符串，`last.text += chunk` 每次写入累计值；只换导出模式仍没有消除主要文本放大。

**建议。** 热路径保存真正新增的文本片段或有类型的追加记录，周期性生成检查点；不能只是将快照替换成仍含累计字符串的 Loro update。是否迁移为文本追加容器另行评估，元数据仅变化时更新。若合并短片段，应明确未持久输出的展示和崩溃语义。用户输入接受、审批决定、附件引用和终态仍需可靠事务，不能先报告确认再延迟落盘。

**完成标准。** 用固定历史长度和 chunk 数测量序列化字节、事务次数、事件循环占用与崩溃恢复；增长接近新增内容量；故障不会把未持久输出当作完成结果。

### D12：主机启动成本随整个历史库增长

**证据。** [RuntimeStore](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/persistence/store.ts)第 173—246 行在启动事务内遍历所有会话，完整导入文档并扫描回合；第 180 行每个会话再调用 `metas(this.meta)`。[metas](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/session/src/model.ts)第 41—47 行每次扫描整份元数据。若每会话元数据规模近似固定，这部分存在随会话数近似二次增长的扫描成本。

**问题。** 为恢复少数中断回合，已归档、已完成历史也进入启动关键路径；某次历史修复逻辑还会在每次启动重复扫描。

**建议。** 先将元数据读取移出循环；再建立持久的未结算会话/回合索引，只恢复需要处理的记录。旧格式身份修复按 schema 版本执行一次，保留可检查的迁移结果。普通读取继续保持只读。

**完成标准。** 已完成历史增加时，重启恢复的工作量主要由未结算记录决定；中断回合仍准确终止；迁移不会替换已有错误身份或自动重新执行。

### D13：冻结历史 diff 的价值应保留，存储方式可以降低成本

**证据。** [ProjectHistoryStore](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/projects/history.ts)第 53—57 行按回合保存 before/after snapshot；第 145—152 行写入完整 JSON。每回合前后采集项目受限文件集合，见 [snapshot.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/projects/snapshot.ts)。

**问题。** 大多数文件未变化时，相邻回合仍反复存储相同文本；现有文件数、大小和读取预算控制单次成本，没有消除长期重复。共享目录中的外部修改也会进入差异，不能把这些快照理解成精确的 Agent 修改归属。

**建议。** 采用按内容摘要去重的 blob，每回合保存新增内容与完整的轻量不可变文件清单。清单本身成为瓶颈后，再评估增量压缩；不需要新建外部对象存储服务。保持现有敏感文件排除规则，提供空间占用与明确保留策略。历史已引用内容不能因回收破坏，不能改为事后读取当前文件冒充旧 diff。

**完成标准。** 连续无变化回合不重复保存相同文件字节；旧 diff 不随文件变化；垃圾回收理解历史引用；界面明确“回合前后目录变化”的归属限制。

## 读取链路、模块与安全生命周期

### D14：会话导航在请求层没有真正分页

**证据。** [workspace-navigation.tsx](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/features/sessions/workspace-navigation.tsx)第 50—62 行枚举全部项目，第 98—135 行用四个 worker 逐项目读取；[WorkspaceController](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/features/workspace/workspace-controller.ts)第 497—498 行目录刷新后使所有项目失效，第 665—666 行请求完整 `sessions`；[workspace-app.tsx](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/app/workspace-app.tsx)第 1448 行最终只显示最近 30 条。

**影响。** 限制渲染条数只减少 DOM，不减少请求、解析和缓存成本。电脑、项目与会话增多时，导航开销持续增长。

**建议。** 先提供 Host 的最近/置顶摘要与分页；跨主机结果由访问端合并，Relay 仍不持久保存会话索引。按实际项目变化失效，展开项目后加载更多。离线结果继续标注缓存覆盖范围。

**完成标准。** 首屏不会读取所有项目的全部会话；单项目变化不刷新无关项目；排序、置顶与离线提示保持一致。

### D15：安全检查被实现为每个请求重复遍历完整目录

**证据。** [DesktopWorkspaceClient.catalog](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/client/src/node/workspace-client.ts)第 154—166 行顺序获取身份、工作区、设备、身份；第 228—229 行每次 `resolve` 都重新执行 `catalog`；第 252、264、273 行在业务请求前后各调用一次 `resolve`。普通成功路径由此形成 **4 + 1 + 4 = 9 次 HTTP 请求**，还不包含调用方为刷新 UI 发出的其他请求。

**合成复现。** 实际 `DesktopWorkspaceClient` 注入 fake fetch 与虚构目录：初始 catalog 成功后清空计数，执行一次 `sessions`，返回 `ok: true, value: []`；请求次序为 `me → workspaces → devices → me → sessions → me → workspaces → devices → me`，共 9 次。没有访问真实网络或账号。

**问题。** 一个读文件或会话列表动作承担两轮完整目录往返；与 D14 的逐项目读取叠加后放大网络延迟。这些检查意图正确，但实现粒度过粗。

**建议。** 第一阶段把同一版本的身份、设备和目录合并成一次受认证读取；之后按连接维护目录版本与撤销失效信号。业务请求携带固定目标和版本，Relay/Host 仍在每次请求上做权威授权，响应返回可验证的目标与版本。变化时重新获取，不用任意短 TTL 替代撤销校验。

**完成标准。** 合成计数验证稳定目录下请求次数下降；账号切换、撤销、项目移动、迟到响应和连接替换仍拒绝错误范围；结果未知的写操作不自动换连接重发。

### D16：分包没有解决大型总控和手工分发

**证据。** [Gateway HTTP](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/gateway/src/http.ts)3,422 行，[WorkspaceController](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/features/workspace/workspace-controller.ts)2,945 行，[HostWorkspace](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/sessions/workspace.ts)2,722 行，[Host 启动入口](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/host/src/main.ts)1,576 行。协议还需要在 [host-command.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/protocol/src/host-command.ts)、[host-response.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/protocol/src/host-response.ts)、[Host 分发](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/commands/host-command.ts)及各 transport 中对应接线。

**问题。** 新功能跨越多处条件分支、能力字符串和状态更新；分包数量增加不自动减少修改面。大文件本身不是缺陷，跨职责耦合才是主要成本。

**建议。** 按会话、内容、Git、账号等稳定业务拆分处理器。共享层集中静态命令名称、请求 schema、响应校验和能力标识；Host 在自身模块中按同一类型注册处理器，协议包不能反向导入执行实现。只统一共性，不创建动态插件加载、通用规则引擎或新的微服务。

**完成标准。** 新增一个业务命令不必修改每一种 UI/transport 的独立业务分支；删除某功能时能明确找到所有消费者；授权仍在 Host 边界执行。

### D17：E2EE 包同时承载普通工作区的安全工具

**证据。** [账号恢复](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/relay/src/account-recovery.ts)第 5、41 行使用 `@moor/e2ee/node/exclusive-lock`；[项目文件](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/projects/files.ts)第 7 行、[Skills](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/projects/skills.ts)第 7 行、[附件](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/agents/attachments.ts)第 3 行使用 `@moor/e2ee/private-content`。

**问题。** 安全功能与加密产品混在同一包，使退场难以按模块边界实施，也容易产生“删掉加密包就完成简化”的错误。

**建议。** 将真实共享的锁和私有内容识别迁到现有合适模块或很小的通用模块；保留其防护与测试，再删除专属 E2EE 消费者。无需把全部加密内部工具都升级成公共 API。

**完成标准。** 普通恢复、文件读取和附件防护不依赖加密产品包；共享模块没有反向导入加密协议。

### D18：加密系统防护细致，但生命周期出口不完整

当前应随退场处理，不建议再投入一轮功能补齐。以下缺口作为未来重新立项的前置条件。

| 缺口                            | 证据与影响                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 未来设计要求                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 正常连接次数耗尽后断开整台 Host | [encrypted-host.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/transport/encrypted-host.ts)第 232—237 行保留退役通道，第 262—268 行达到历史上限就关闭 Host；[协议](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/e2ee/src/encrypted-bridge-protocol.ts)第 37 行上限为 256；[secure CLI](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/cli/src/encrypted-client.ts)第 150—168、539—541 行每次新建并关闭连接。现有[测试](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/tests/integration/encrypted-host-transport.test.ts)第 406 行覆盖上限行为 | 安全轮换挑战与连接；允许连接恢复，禁止自动重放未知写操作；必要人工恢复仍用原编号、正文和目标。不能直接删除防重放 tombstone |
| 信任更新需要停止 Host           | [encrypted-host.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/transport/encrypted-host.ts)第 46—95 行独占端点；[设备安全文档](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/docs/device-security.md)第 40、103、115 行说明独占、手动同步单页、未更新设备不知道撤销                                                                                                                                                                                                                                                                                                                                                       | 唯一端点管理服务接收有限管理命令；自动拉取并验证已签署的撤销，展示各 Host 生效版本；签署授权仍需明确操作                   |
| 队列与永久信任链存在硬终点      | [device-manager.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/e2ee/src/node/device-manager.ts)第 51、299—306、796—803 行：最多 16 个待发布版本，满额也会阻止追加撤销；[trust-publication.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/e2ee/src/trust-publication.ts)第 14—18 行：4,096 版本、128 MiB；[信任分发](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/gateway/src/trust-publications.ts)第 171—182 行要求连续                                                                                                                                                      | 设计有验证能力的检查点、历史压缩和根迁移；保留最高版本与分叉检测，不直接信任 Relay 最新列表                                |
| 灾难恢复材料参与日常管理        | [device-manager.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/e2ee/src/node/device-manager.ts)第 703—720、774—788 行：批准设备和撤销需要解锁恢复材料；[设备安全文档](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/docs/device-security.md)第 117 行明确没有根轮换                                                                                                                                                                                                                                                                                                                                                                | 区分日常设备管理凭据与离线恢复材料，完成根失陷、设备丢失和多端冲突演练；撤销设备不能冒充根恢复                             |
| 大型密文 RPC 推动自建帧准入机制 | [e2ee-crypto.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/e2ee/src/e2ee-crypto.ts)第 7—13、44—69 行允许 48 MiB 明文并整体 base64；[encrypted-ingress.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/gateway/src/encrypted-ingress.ts)在 WebSocket 库前增加帧准入和分块预算                                                                                                                                                                                                                                                                                                                                           | 小型控制消息与有界二进制内容传输分开；保留并发、字节、时间预算和背压，不以删掉准入保护实现简化                             |

这些问题不证明密码算法无效，也没有证明真实攻击或 OOM 已发生。它们说明“拒绝不安全操作”之外，还需要正常用户可完成的连接更新、撤销和恢复路径。安全的只读同步、重新建连与执行旧指令，是不同类别的行为。

## 构建、维护与交付

### D19：源码解析清单已经发生实际漂移

**证据。** [workspace-sources.mjs](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/scripts/build/workspace-sources.mjs)第 5 行手工列出六个包，漏掉 `sync`；[collaboration-service.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/sessions/collaboration-service.ts)第 16 行实际导入 `@moor/sync/store`；[sync/package.json](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/sync/package.json)的运行时导出指向 `dist`。开发构建在 [desktop-runtime.mjs](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/scripts/build/desktop-runtime.mjs)第 63 行使用这份源码解析插件。

**合成检查。** 直接调用实际 `workspaceAliases`：`@moor/host/sessions/workspace` 命中源码路径，`@moor/sync/store` 返回 `NO SOURCE ALIAS`。

**影响。** 开发模式可能混用最新 Host 源码与旧 sync 构建产物；干净 checkout 则依赖是否预先生成该包。没有据此宣称当前整仓构建必然失败。

**建议。** 从 workspace manifest/明确导出生成统一的解析信息，供开发构建、打包和检查共用。包依赖方向仍保留显式约束，避免为了自动化而开放任意跨包源码引用。

**完成标准。** 每个生产包在开发时解析到当前源码；删除旧 dist 后也能按声明流程启动；新增包不会遗漏某个独立清单。

### D20：交付物独立，构建却被串在一起

**证据。** [package.json](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/package.json)的 `build` 同时构建所有 workspaces、服务 bundle 与 Desktop；`package:relay` 先执行整套 build。[build.mjs](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/scripts/build/build.mjs)已经打包 Host/CLI/桌面客户端；[build-desktop.mjs](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/scripts/build/build-desktop.mjs)又调用 [desktop-runtime.mjs](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/scripts/build/desktop-runtime.mjs)构建同一组运行入口。Web 和 Desktop 分别使用 esbuild 与 electron-vite 维护资产流程。

**问题。** 发布 Relay 也承担 Desktop 构建失败面，多个 pipeline 重复维护入口、WASM、样式和资源规则。不同工具本身不一定错误，但重复配置缺少单一来源。

**建议。** 建立 `build:relay`、`build:host`、`build:web`、`build:desktop` 的明确产物依赖，复用目标、入口和公共资源规则；默认完整检查继续覆盖所有产品。Relay 包仅消费自身产物，不要求先完成 Desktop 构建。

**完成标准。** 单独 Relay 构建产生完整服务与 Web 资源、许可声明，不包含 Host 数据或 Desktop 专属资源；完整 CI 仍覆盖各目标。

### D21：当前死代码门禁不能证明功能已经清理

**证据。** [knip.jsonc](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/knip.jsonc)多处将 `src/**/*.ts!` 设为 entry，并设置 `includeEntryExports: false`。这会把包内大量文件当成独立有效入口，而非只从产品入口判断可达性。仓库配置如此，不等于工具本身没有价值。

本次实际运行 `pnpm knip:production` 还报告三个未使用导出/类型：`previewAnnotationSnapshotSchema`、`filterSessions`、`SecureGithubContext`，命令退出码为 1。

**建议。** 私有包按实际公开出口和运行入口检查；确需直接运行的脚本使用有限白名单。把“包 API 是否有效”和“最终产品是否引用”作为两种检查，补充发布产物中禁止退场入口的校验。不要通过追加忽略项来让退场显示为完成。

**完成标准。** 移除最后一个真实消费者后，未使用模块能被发现；构建产物也不再包含它。清理这三个告警只是小修复，不能替代入口配置校准。

### D22：PWA 更新缺少旧页面与新资源的交接

**证据。** [sw.js](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/public/sw.js)第 6—25 行安装后立即 `skipWaiting`，激活时删除旧 shell cache 并 `clients.claim`；[build.mjs](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/scripts/build/build.mjs)第 8 行清理旧 hash assets；[entry.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/app/entry.ts)使用动态 import。新 Service Worker 的 fetch 只处理本版本资源清单。

**风险判断。** 已打开的旧页面若随后请求尚未加载的旧 hash chunk，旧缓存和服务器资源可能均已不存在。本次没有模拟真实浏览器升级重现，报告不把它写成已发生的数据丢失。

**建议。** 保留仍被页面使用的构建资源版本，或在草稿/原操作已可靠保存后提示用户更新；对动态模块加载失败提供保留状态的恢复入口。不能通过清空草稿缓存处理资源升级。

**完成标准。** 打开旧版页面、发布新版、再进入延迟加载功能，页面可继续或安全更新；草稿与未确认请求保持原样；更新不自动提交。

### D23：文档没有一个可信的“当前状态”

**证据。** [client-unification.md](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/docs/client-unification.md)第 5 行称四阶段工程交付已完成，而 [roadmap.md](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/docs/roadmap.md)第 11 行仍说下一步实施统一客户端基础；第 17 行已决定延期 E2EE，文档后半部分却仍保留继续迁移加密功能的计划。README 一方面宣布功能退场，另一方面保留较长的加密工作区使用说明。[development.md](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/docs/development.md)仍举 `tests/cli-host.test.ts` 等旧测试路径，实际文件已位于 `tests/integration`。

**问题。** 用户无法判断能否使用，开发者可能根据旧计划继续补已经取消的功能。链接检查通过也不能发现代码块中的旧路径或互相矛盾的状态。

**建议。** 用一份简短能力表区分“当前提供 / 预览 / 已退场 / 尚未验收”；README、路线图引用它。验收历史和旧方案移入历史目录并标注适用版本；开发命令用真实路径。不要再往当前计划末尾追加历史进展段落。

**完成标准。** 任意功能只有一个当前状态；旧说明不能被误解为操作指引；文档不以测试数量代表产品成熟度。

### D24：真实设备反馈尚未成为扩展功能的约束

**证据。** [roadmap.md](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/docs/roadmap.md)第 21—41 行大量功能“已接通”但真实 Agent、双 Mac、iPhone、PWA、签名仍待验收；[validation.md](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/docs/validation.md)第 5 行原本要求在 M2 前完成首轮真机验收，后面却已累计到更多扩展阶段。[CI](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/.github/workflows/check.yml)主要运行 Ubuntu 上的类型、死代码、测试、格式和构建。

**问题。** 合成测试对身份、幂等和故障恢复很有价值，但不能覆盖手机键盘、后台推送、休眠、Agent 实际能力和安装体验。产品范围继续扩展时，核心体验的不确定性没有同步下降。

**建议。** 先设定可交付核心：首次启动、添加项目、远程连接、发指令、审批、停止、断网恢复、保留草稿。自动测试继续只用合成数据与确定性信号；由操作者在目标设备和专用项目上完成真实验证。日常开发用定向反馈，提交前仍执行仓库要求的四项门禁；不削弱现有安全测试来追求数量或速度。

**完成标准。** 发布说明绑定实际包版本、设备和 Agent 版本，记录失败与未测范围。没有真实验收的能力继续明确标为预览，不以合成通过替代。

### D25：部署可重复性与依赖锁定标准不一致

**证据。** 应用依赖使用精确版本与锁文件，但 [Dockerfile](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/deploy/Dockerfile)第 1 行使用 `node:24-bookworm-slim`，[compose.yaml](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/deploy/compose.yaml)使用 `caddy:2`；同一标签内容可以变化。产品版本还在 [package.mjs](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/scripts/release/package.mjs)第 99、116、141 行和 [边界检查](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/scripts/validation/check-package-boundaries.mjs)第 73 行手工写为 `0.2.0`。

**建议。** 正式交付记录或固定实际镜像 digest，通过明确更新流程升级；包版本、归档名称和校验要求从同一 manifest 读取。保留现有程序文件白名单、数据卷保护、停机备份与迁移后不盲目自动回滚的措施。

**完成标准。** 同一源码和锁定镜像能追溯到同一部署输入；升级版本不用同步编辑多处常量；备份、凭据和运行数据库不进入分发产物。

### D26：旧分区清理不应成为当前应用启动的必要条件

**证据。** [main.cjs](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/desktop/src/main/main.cjs)第 947—953 行在应用 ready 后先执行旧数据清理，任何异常都会 `app.quit()`；[retired-client-data.cjs](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/desktop/src/main/retired-client-data.cjs)第 17—20 行递归删除 `personal-local`、`personal-remote` 两个分区。清理范围有路径/符号链接防护，当前分区、Host 数据与凭据不在删除目标内。

**问题。** 旧目录权限或文件系统问题可以阻止新客户端使用，这是可以从代码直接确认的可用性设计。另需核对升级契约：[client-unification.md](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/docs/client-unification.md)第 118—120 行承诺保留旧草稿与原操作，但第 171—173 行又明确宣布删除旧恢复入口和分区。因此不能简单称删除行为是“无意 bug”，也不能假设所有旧数据均已迁移。

**建议。** 清理失败时保留旧目录并报告，当前独立分区仍正常启动；清理只处理已知安全范围，不绕过路径检查。发布说明明确旧分区是否已宣布不再保留，以及仍含本地独有数据时的处理方式。如果尚未完成迁移或明确退场，应先隔离保存或提供导出窗口。该建议不要求恢复整套旧客户端产品。

**完成标准。** 合成旧目录不可清理时，当前应用仍可启动；迁移与退场说明一致；无隐藏的草稿、原操作自动导入或执行。本次未检查真实旧分区，不能声称实际发生过用户数据丢失。

## 次级改善与暂不建议做的重构

- **设置入口收敛。** [appearance.tsx](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/components/appearance.tsx)第 149—195 行的设置混合外观、模型能力刷新和原生设置跳转；[settings.html](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/desktop/src/settings/settings.html)第 14—31 行又有外观设置。可随 D02 统一分类与表单，平台能力通过有限 IPC 提供。收益低于操作失败与请求放大，不应单独启动一轮设置框架开发。
- **Agent 进程保活先测量。** 当前回合会启动/加载并关闭 Agent，见 [workspace.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/packages/host/src/sessions/workspace.ts)第 2289、2495 行。若真实测量证明启动延迟明显，再考虑按会话有限保活、空闲回收；不能先造通用进程池，也不能牺牲运行配置与目录绑定、撤权和资源清理。
- **登录动画不列为核心问题。** [login-water.ts](https://github.com/zZOMZz/moor/blob/ce42138b3059ac679705b32d0872ffdfc1057fb6/apps/web/src/features/auth/login-water.ts)已有帧率限制、后台暂停和减少动态效果支持。没有耗电或启动失败证据时，不应因为存在 WebGL 就断言过度设计；可以冻结装饰性迭代，把资源投入核心流程。
- **不引入微服务、通用工作流引擎或新消息中间件。** 当前问题主要来自重复实现与生命周期不闭环，增加基础设施会扩大维护面。

## 不应作为“过度设计”删除的部分

| 应保留                                  | 原因与允许简化的方向                                                       |
| --------------------------------------- | -------------------------------------------------------------------------- |
| Host 对执行和持久化的最终权威           | 防止网页或 Relay 绕过项目、Agent 和会话归属；可统一校验原语，不可取消边界  |
| 账号、设备、工作区、项目、会话绑定      | 同名项目与重配对不等于同一执行目标；可封装身份类型，不可按名称合并         |
| 稳定 operation ID、同内容去重、主机确认 | 网络丢回执不代表未执行；可改善展示和索引，不可盲目重试或清空原记录         |
| 审批绑定精确活动回合、请求和已审阅内容  | 旧页面不能批准新操作；可减少重复代码，不可把审批简化成永久布尔开关         |
| 草稿与明确提交的任务意图分离            | 草稿不重连执行；已明确授权的 durable intent 可按约定同步入队，两者不能混淆 |
| Relay 不持久化正文，凭据不进入共享文档  | 属于项目的数据边界；分页与目录优化也不能把会话库搬进 Relay                 |
| 不暴露通用 shell/socket 代理            | 远程客户端只能表达受限业务动作；不能以“省协议”为由开放任意执行             |
| 版本化会话 schema 与已冻结历史          | 保证升级与历史可读；优化落盘形式不等于改变历史含义                         |
| AgentDriver 与锁定 ACP 适配器           | 隔离 Moor 和外部 Agent 的生命周期；不读其他应用数据库、不依赖外部源码      |
| 本机数据锁、路径检查、进程所有权        | 防止并发写库和终止不属于自己的进程；不属于加密退场应删除的保护             |
| 确定性合成测试、许可与分发数据隔离      | 保障可重复验证和安全交付；真实设备验证应补充，不能替代这些措施             |

## 建议的目标结构

保留现有单体部署与少量职责包，在现有代码上收敛。以下表示职责关系，不要求新增服务或逐框新增包。

```text
Web / PWA / Desktop / CLI
        │
        ├─ 共用业务命令、回执与身份模型
        └─ Web/Desktop 共用会话控制器与组件
        │
HTTP/WSS / 本机有限 IPC
        │
Relay：账号、设备、组织元数据、授权与转发
        │                         本机 IPC 可直接进入 Host
Host：范围校验 → 命令接受/回执 → 执行协调 → AgentDriver/ACP
        │
        ├─ 会话与 TaskDoc：版本化文档、按需增量
        ├─ 操作与执行账本：SQL 事务、明确生命周期
        └─ 内容与历史 diff：不可变引用、内容去重
```

将来引入 E2EE 时，替换远程连接的安全实现，配对和撤销进入“设备与安全”设置。可信客户端分发、密钥恢复与不可信 Relay 的威胁模型仍需独立评审，不能把共用界面等同于已解决这些问题。

## 实施顺序与每阶段退出条件

| 阶段                | 范围                                   | 可独立审查的交付                                                              | 退出条件                                                                                      |
| ------------------- | -------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A：先消除确定性阻碍 | D06、D07、D19、D23、D26 的明显错误     | 操作记录容量方案、会话范围阻塞修复、源码 alias 修复、清理失败隔离、当前能力表 | 超过 512 条正常操作可继续；无关会话不被阻塞；旧目录清理不阻断启动；开发解析一致；文档不再冲突 |
| B：落实产品减法     | D01、D03、D17、D18                     | 加密与旧功能消费者清单、停止新增、历史保护、逐层退场                          | 普通客户端无专属依赖；运行与分发入口消失；历史原操作无删除/重放                               |
| C：减少关键路径成本 | D08、D11、D12、D14、D15                | 存储粒度、目录请求合并、输出增量、定向恢复与分页                              | 字节/请求/扫描量可测下降；身份撤销和恢复语义不变                                              |
| D：统一业务实现     | D02、D05、D10、D16                     | HTTP/IPC 共用会话行为、共享接受/回执原语、明确身份命名                        | 修复一个业务问题无需多轨同步改动；不同任务政策仍清晰                                          |
| E：完善长期交付     | D13、D20—D22、D24、D25；按需求评估 D09 | 内容去重、按产物构建、升级交接、目标设备发布验收                              | 历史规模与升级可控；发布输入可追溯；核心设备验收通过                                          |

每阶段拆小提交，不把数据迁移、协议调整和 UI 大改塞进同一提交。当前请求只要求报告，本次没有实施这些改造。

D24 的核心真实设备基线应在 A/B 阶段同步开始，由操作者执行；不能等全部重构完成才获得第一次真实使用反馈。E 阶段负责对最终交付物复验，而不是推迟首轮验证。

### 第一批建议直接建立的工作项

1. 修复当前会话 pending 过滤，并补“同项目 A 未确认、B 正常发送”的定向回归。
2. 为 WorkspaceStore 制定记录级迁移；先覆盖 512→513、刷新恢复、CAS 冲突和未知请求保留，再移除数组寿命上限。
3. 将普通工作区启动与 `moorSecure` 解耦，同时保留已有 secure 数据的有限恢复入口。
4. 补齐 `@moor/sync` 开发解析并减少重复包清单；验证不依赖旧 dist。
5. 合并桌面请求的身份/目录读取，用合成请求计数与撤权竞争验证收益和边界。
6. 测量流式输出的事务数和序列化量，先减少无变化元数据写入，再实施输出增量与检查点。

### 用这些指标判断是否真的变简单

- 正常成功操作不再触发累计次数上限，未知结果记录不被自动删除。
- Web/Desktop 的发送、审批、停止各只有一套业务实现。
- 普通工作区不加载 E2EE 专属 UI、控制器、传输或设备信任状态。
- 稳定连接中，一次业务请求不再前后重复遍历完整账号目录。
- 小段新增输出不会导致完整会话和全局元数据反复写入。
- 首屏请求量由首屏所需数据决定；启动恢复由未结算状态决定。
- 当前文档、发布包、Host 能力声明和真实可用入口一致。
- 任何改造都不让草稿、未知请求或已派发任务自动重放。

## 本次验证记录与限制

| 检查                            | 结果               | 说明                                                                     |
| ------------------------------- | ------------------ | ------------------------------------------------------------------------ |
| 包边界检查                      | 通过               | 检查 12 个 workspace package                                             |
| 文档链接检查                    | 通过               | 报告完成后复查 61 篇 Markdown，全部链接目标存在                          |
| `pnpm knip:production`          | 未通过             | 两个未使用导出、一个未使用导出类型；见 D21                               |
| WorkspaceStore 容量实验         | 复现故障           | 内存合成 512 条 confirmed 后，第 513 条被 schema 拒绝                    |
| DesktopWorkspaceClient 请求计数 | 复现请求放大       | 实际客户端与 fake fetch；单次 sessions 成功请求触发 9 次串行 HTTP        |
| Loro 输出快照实验               | 观察到写放大       | 固定内容/分片/随机种子；只测导出字节，不等价于磁盘或时间基准             |
| workspace alias 检查            | 确认遗漏           | `@moor/sync/store` 未命中源码 alias                                      |
| 完整类型、测试、构建四项门禁    | 本次未运行完整组合 | 本次只新增报告，没有业务修改或提交；既有历史通过记录不当作当前工作区通过 |
| 真实设备、真实账号和线上服务    | 未操作             | 未使用真实 Agent/GitHub/Google 账号，未部署，未做真机性能或安全认证      |

所有发现均应按本报告的证据强度阅读。性能项应先建立合成基线再验证改造收益；产品取舍项需要在实施前确认近期功能范围。本次仅新增报告，未覆盖或回退已有源码与文档修改，也未创建提交。报告文件的 Prettier 格式检查通过。
