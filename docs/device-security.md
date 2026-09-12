# 本机设备安全命令

本机命令已提供建根、设备配对、换钥、撤销与恢复。它不发送网络请求，也不启动 Agent。**执行这些命令不会开启现有远程连接的端到端加密**；生产传输与桌面/PWA 接线继续按[加密进展](end-to-end-encryption.md)推进。

## 入口和私有文件

构建后运行 `node dist/security.mjs --data-file /绝对路径/endpoint.json`，或 `pnpm -s security --data-file /绝对路径/endpoint.json`。每次从标准输入读取一个 JSON 对象，成功输出一行 `{securityVersion:1,ok:true,action,data}`。不从参数或环境变量接收恢复码；输入上限为 1 MiB，未知字段会被拒绝。该入口也包含在新 Mac 包的 `Contents/Resources/app/runtime/security.mjs` 中。

端点文件、恢复码文件和导出文件须使用不同的绝对路径。父目录必须已存在、路径中无符号链接、由当前用户持有且权限为 `0700`；文件为 `0600` 普通文件且不得有硬链接。命令保留锁文件，不自动删除别人的文件或修正权限。建议放在项目外的 `.moor-security` 私有目录；恢复码另存到独立的私有位置。不要将端点文件或恢复码加入 Git、Moor 会话、附件或共享文档。

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

## 在另一台设备上配对

1. 从首台可信设备的 `read` 结果取得 `data.pin`，通过独立可信途径核对完整 `accountId`、`serverOrigin`、`rootKeyId`。Google 登录本身不确认此 pin。
2. 新设备选择新的私有端点文件，以 `begin-pairing` 提交 `{pin,deviceId,roles}`。保存返回的 `data.pending.request`、本机 `revision` 和完整 `fingerprint`；`read` 可重新取得请求与指纹。请求有效期为 10 分钟。
3. 根管理设备核对新设备实际显示的完整指纹和角色后，提交 `approve-pairing`：`expectedRevision` 为管理设备的当前版本，`request` 为原请求，`expectedFingerprint` 为核对值，`recoveryCodeFile` 为恢复码文件。新设备的 `expectedDeviceKeyId` 填 `null`；替换已存在的设备密钥必须填其当前 keyId。
4. 新设备提交 `accept-pairing`，使用自己的 `expectedRevision`，以及批准结果 `data.approval`、`data.trust.rootPublicKey` 和 `data.trust.signedManifest`。成功后 pending 消耗，私钥成为当前设备密钥。
5. 其他已配对设备通过 `install-trust` 逐个安装缺失的签名版本；输入为其本机 `expectedRevision` 和 `signedManifest`。相同版本可重读，不能跳过版本、回滚或安装同版本分叉。当前没有自动公开版本分发，需要保留每次管理操作返回的公开清单；只保留最新版本不足以让落后多个版本的端点同步。

批准结果丢失时，可以在有效期内对原请求手动重试 `approve-pairing`，返回相同回执；仍需恢复码及原指纹，不能替换请求。已经消耗的 `accept-pairing` 不再次执行，应读取本机状态。过期后在请求端以当前 `expectedRevision` 调用 `renew-pairing`，再核对新指纹；若原请求已获批准但未被接收，重新批准需要明确匹配管理端当前的设备 keyId。

当前每个管理端最多保留 8 个未过期批准。旧回执过期后只保留为本机记录，下次明确管理操作时清理；不会自动批准、续期或执行配对。首次配对的取消界面尚未接通；未接受的请求不会自行激活。

## 换钥和撤销

已受信任的设备可提交 `{"action":"rotate-key","expectedRevision":当前本机版本}`。它生成新的 pending 密钥和请求，现用密钥保留到精确批准被接受。随后按配对步骤批准，并将 `expectedDeviceKeyId` 设为旧密钥。`cancel-rotation` 可在接受前按当前本机 revision 清除 pending；如果管理端已经批准新 keyId，它仍需另行处理已签署的清单，取消不能撤回远端批准。

管理端撤销设备使用 `revoke-device`，明确提交 `expectedRevision`、`deviceId`、`expectedKeyId`、`recoveryCodeFile`。取得新签名清单后，其他端点手动安装；未安装撤销版本的离线端点还不知道该变化。已安装撤销的旧设备不能再提供有效加密通道或发起换钥。已经进入主机处理的外部动作不会因此回滚。

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
