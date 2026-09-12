# 本机设备安全命令

设备安全入口已提供建根、设备配对、换钥、撤销、恢复，以及公开签名版本的手动发布和同步。共 15 个动作：原有 12 个动作及 `read-publications` 只操作本机；仅 `publish-trust`、`sync-trust` 访问固定中转接口。所有动作都不会启动 Agent。**执行这些命令不会开启现有远程连接的端到端加密**；生产远程会话仍使用明文桥接协议 v3，后续接线见[加密进展](end-to-end-encryption.md)。

## 入口和私有文件

构建后运行 `node dist/security.mjs --data-file /绝对路径/endpoint.json`，或 `pnpm -s security --data-file /绝对路径/endpoint.json`。每次从标准输入读取一个 JSON 对象，成功输出一行 `{securityVersion:1,ok:true,action,data}`。不从参数或环境变量接收恢复码；输入上限为 1 MiB，未知字段会被拒绝。该入口也包含在新 Mac 包的 `Contents/Resources/app/runtime/security.mjs` 中。

端点文件、恢复码文件、连接凭据文件和导出文件须使用不同的绝对路径。父目录必须已存在、路径中无符号链接、由当前用户持有且权限为 `0700`；文件为 `0600` 普通文件且不得有硬链接。命令保留锁文件，不自动删除别人的文件或修正权限。建议放在项目外的 `.moor-security` 私有目录；恢复码另存到独立的私有位置。不要将端点文件、恢复码或连接凭据加入 Git、Moor 会话、附件或共享文档。

项目读取、快照、Skills 和附件会拦截完整带 Moor 私有文件标识的文档，包括改名副本；Agent 返回的完整私有文档使用安全占位。此检查不保护拆分片段、去掉标识的内容或任意 Agent 文件系统访问，不能替代项目外存放和恢复材料的独立保管。

以下仅使用合成账号说明输入格式。实际 `accountId` 和中转 origin 必须来自已核对的个人账号，设备 ID 应唯一；不要为已有端点重新建根。

```sh
node dist/security.mjs --data-file /private/device/.moor-security/endpoint.json <<'JSON'
{
  "action": "initialize",
  "identity": {
    "accountId": "example-account",
    "serverOrigin": "https://relay.example.com",
    "deviceId": "macbook-pro-unique-id",
    "roles": ["client", "host"]
  },
  "recoveryCodeFile": "/private/recovery/.moor-security/recovery-code.json"
}
JSON
```

示例目录需自行创建并设置为私有目录。角色 `client` 表示访问端，`host` 表示执行主机；一台 Mac 可同时承担两者。命令先保存恢复码，再初始化端点；若端点初始化失败，已写入的恢复码会保留，后续手动操作复用它。返回的公开状态包含 `revision`、`pin`、当前设备和签名信任状态，不含私钥或恢复码。

查看当前状态：

```sh
node dist/security.mjs --data-file /private/device/.moor-security/endpoint.json <<'JSON'
{"action":"read"}
JSON
```

`phase` 为 `empty`、`pending`、`active` 或 `revoked`。大多数修改需要填入本机最新的 `expectedRevision`，它与公开信任清单的 `epoch` 不同。失败时先执行 `read` 核对；命令不自动重试，失败也不保证磁盘未发生变化。端点文件在使用期间由一个进程独占，不能同时由另一个命令或主机实例打开；遇到占用应先结束原持有者，不能删除锁文件绕过。

| 动作                                             | 范围                                           |
| ------------------------------------------------ | ---------------------------------------------- |
| `read`、`read-publications`                      | 本机状态与待发布的公开签名版本，只读           |
| `initialize`、`begin-pairing`、`renew-pairing`   | 本机建根、创建或续期配对请求                   |
| `approve-pairing`、`accept-pairing`              | 本机明确批准与接收配对                         |
| `rotate-key`、`cancel-rotation`、`revoke-device` | 本机换钥、取消换钥与签署撤销                   |
| `install-trust`、`export-recovery`、`recover`    | 本机安装单个版本、导出与恢复                   |
| `publish-trust`、`sync-trust`                    | 明确联网发布公开签名版本，或读取并安装一页版本 |

## 在另一台设备上配对

1. 从首台可信设备的 `read` 结果取得 `data.pin`，通过独立可信途径核对完整 `accountId`、`serverOrigin`、`rootKeyId`。Google 登录本身不确认此 pin。
2. 新设备选择新的私有端点文件，以 `begin-pairing` 提交 `{pin,deviceId,roles}`。保存返回的 `data.pending.request`、本机 `revision` 和完整 `fingerprint`；`read` 可重新取得请求与指纹。请求有效期为 10 分钟。
3. 根管理设备核对新设备实际显示的完整指纹和角色后，提交 `approve-pairing`：`expectedRevision` 为管理设备的当前版本，`request` 为原请求，`expectedFingerprint` 为核对值，`recoveryCodeFile` 为恢复码文件。新设备的 `expectedDeviceKeyId` 填 `null`；替换已存在的设备密钥必须填其当前 keyId。
4. 新设备提交 `accept-pairing`，使用自己的 `expectedRevision`，以及批准结果 `data.approval`、`data.trust.rootPublicKey` 和 `data.trust.signedManifest`。成功后 pending 消耗，私钥成为当前设备密钥。
5. 管理端用下文的 `publish-trust` 明确发布待发版本，其他已配对设备用 `sync-trust` 逐页核对并安装。也可继续离线使用 `install-trust`，每次提交本机 `expectedRevision` 和一个 `signedManifest`；相同版本可重读，不能跳过版本、回滚或安装同版本分叉。仅保存最新版本不足以让落后多个版本的端点同步。

批准结果丢失时，可以在有效期内对原请求手动重试 `approve-pairing`，返回相同回执；仍需恢复码及原指纹，不能替换请求。已经消耗的 `accept-pairing` 不再次执行，应读取本机状态。过期后在请求端以当前 `expectedRevision` 调用 `renew-pairing`，再核对新指纹；若原请求已获批准但未被接收，重新批准需要明确匹配管理端当前的设备 keyId。

当前每个管理端最多保留 8 个未过期批准。旧回执过期后只保留为本机记录，下次明确管理操作时清理；不会自动批准、续期或执行配对。首次配对的取消界面尚未接通；未接受的请求不会自行激活。

## 发布与同步公开信任版本

先用[会话 CLI](cli.md#连接执行主机)登录同一个远程账号；可以使用密码，或按[Google CLI 接续](google-login.md#cli-系统浏览器接续)登录已经关联的 Google 账号。核对 `auth status` 中的账号与中转，再导出到尚不存在的私有文件：

```sh
node dist/cli.mjs auth export-trust --output /private/device/.moor-security/trust-connection.json
```

导出只读取当前 CLI 的远程登录，不发起新登录；本机 `--connection` 登录不能导出。文件含登录 Cookie，只能供本机安全命令读取，成功输出只有路径，不要手写 Cookie 或复制到终端。它与 CLI 共用该登录的有效期；退出或过期后需明确重新登录并导出新文件，原文件不会自动更新。

查看待发布版本不会联网或修改端点：

```sh
node dist/security.mjs --data-file /private/device/.moor-security/endpoint.json <<'JSON'
{"action":"read-publications"}
JSON
```

结果 `data` 包含 `revision`、`pin`、`rootPublicKey` 和 `entries`。每项只有完整 `pin`、根公钥、检查点及原签名清单；没有设备私钥、恢复码、恢复包、登录凭据或会话正文。初始化把 genesis 与端点同时保存；批准、撤销把新清单、恢复包、回执和待发布版本一次保存。恢复到新端点只加入本次恢复产生的新版本。

把刚读取的本机 revision 填入以下示例；示例中的 `1` 不是固定值：

```sh
node dist/security.mjs --data-file /private/device/.moor-security/endpoint.json <<'JSON'
{"action":"publish-trust","expectedRevision":1,"connectionFile":"/private/device/.moor-security/trust-connection.json"}
JSON
```

每次最多发送全部 16 个待发布版本。只有中转回执的检查点与原待发前缀逐项精确匹配，才移除已确认项；确认只更新本机记账和 revision，不改变已验证的信任对象或加密授权。成功结果含 `data.status`、`stored`、`pending`；`relayHead.verified:false` 表示中转声称的最新检查点尚未作为完整信任链安装。空队列直接返回，不发网络请求。

本机最多保留 16 个待发布版本。满额时，新增信任变更整体失败，不会只保存批准或恢复包；先明确发布并确认，再继续管理。响应丢失或不可验证时保留原签名与队列，先执行 `read`、`read-publications`，再以当前 revision 手动重发。中转对已经存储的相同版本返回原存储确认，不重新签名或生成新 epoch；不会在启动、重连或读取时自动发布。

另一台已配对设备先登录同一账号并导出自己的连接文件，再用该端点的当前 revision 同步：

```sh
node dist/security.mjs --data-file /private/peer/.moor-security/endpoint.json <<'JSON'
{"action":"sync-trust","expectedRevision":2,"connectionFile":"/private/peer/.moor-security/trust-connection.json","limit":16}
JSON
```

`limit` 可省略，默认 16，允许 1–16。每次只读取一页；整页逐版本验证完成后以一次本机 CAS 安装，坏的末项不会使前面的版本部分落盘。成功结果包含 `data.status`、`installed`、`complete`。若 `complete:false`，用新的本机 revision 再明确执行一次；没有后台翻页。收到的远端版本不重新加入本机待发布队列。中转返回结果前重查原登录仍有效；客户端遇到超时或私有连接/端点变化时拒绝迟到结果。

只有完整验证到该页声明的 head 时，`relayHead.verified` 才为 `true`；这不证明中转提供了全局最新版本。中转仍可隐瞒更新，不能用其 head 替换本机检查点或已核对的根 pin。

网络入口固定为 `GET /api/me`、`POST /api/security/trust/publish`、`POST /api/security/trust/read`；不接受任意路径或主机命令。发布与读取要求同一账号的有效 Cookie 和准确 Origin，本机服务不开放这些路由。中转按账号和固定根保存连续历史，最多 4,096 个版本、128 MiB 公开条目；请求和分页响应最多 1 MiB，满额或分叉时拒绝，不能删掉历史绕过。

旧端点若没有待发布字段，只把它实际保存的当前签名版本视为待发布；读取和重开不改盘，不补造 genesis 或中间历史。中转首次建立历史必须从 genesis 连续验证。缺失版本需从保有原签名材料的可信端点取得；最新清单、恢复包或 Google 登录都不能代替缺失的链。

## 换钥和撤销

已受信任的设备可提交 `{"action":"rotate-key","expectedRevision":当前本机版本}`。它生成新的 pending 密钥和请求，现用密钥保留到精确批准被接受。随后按配对步骤批准，并将 `expectedDeviceKeyId` 设为旧密钥。`cancel-rotation` 可在接受前按当前本机 revision 清除 pending；如果管理端已经批准新 keyId，它仍需另行处理已签署的清单，取消不能撤回远端批准。

管理端撤销设备使用 `revoke-device`，明确提交 `expectedRevision`、`deviceId`、`expectedKeyId`、`recoveryCodeFile`。新清单进入待发布队列，其他端点明确同步或离线安装；未安装撤销版本的离线端点还不知道该变化。已安装撤销的旧设备不能再提供有效加密通道或发起换钥。已经进入主机处理的外部动作不会因此回滚。

恢复码解锁的是账号根管理能力。撤销设备加密密钥不会让其已有恢复码/恢复包失效；这类材料应独立保管，当前没有根密钥轮换流程。

## 导出与丢失设备后的恢复

在持有根恢复包的管理端提交 `export-recovery`，提供 `recoveryCodeFile` 和尚不存在的私有 `outputFile`。命令把根密钥及当前公开检查点重新加密后写入该文件；返回只含输出路径。恢复码、端点和导出包必须分别保管，导出包不包含历史、旧设备私钥或 Agent 账号。

恢复时选择一个空的端点文件，提交以下字段：

| 字段                | 值                                                                 |
| ------------------- | ------------------------------------------------------------------ |
| `action`            | `recover`                                                          |
| `recoveryCodeFile`  | 独立保存的原恢复码文件                                             |
| `capsuleFile`       | 导出的加密恢复包文件                                               |
| `expectedPin`       | 事先独立核对的原根 pin                                             |
| `baseTrust`         | 从存活可信设备读取并核对的完整 `data.trust`                        |
| `deviceId`、`roles` | 新设备身份和角色，不能复用基准或备份中已知的 ID                    |
| `revokeDevices`     | 明确列出丢失设备的 `{deviceId,keyId}`；保留所有原设备时明确填 `[]` |

恢复以所选基准生成下一签名版本和全新设备私钥。其他设备需要安装这一版本；恢复命令不会替它们写文件、同步清单或启动任何待执行操作。基准至少与备份一样新；若其他设备已有更新版本，必须先取得并核对它。备份不能判断全局最新状态，中转隐瞒版本或多台根管理设备同时写入可能产生分叉；遇到冲突需先核对各端状态，不能删除检查点强行重配。

恢复包与随机恢复码同时丢失时，Google 登录不能解密或恢复根管理能力。当前恢复验证仅使用合成密钥和临时私有文件；双 Mac、真实磁盘丢失与 iPhone 的完整验收尚未进行。
