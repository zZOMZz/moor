# macOS 签名与公证

日常 `pnpm package:mac` 继续生成 ad-hoc 签名的开发预览包。正式分发流程由 `scripts/mac-release.mjs` 单独执行：先检查明确指定的 `Moor.app`，再复制到一个不存在的新输出目录，逐层签名、验证、提交公证并装订票据。源程序包保留原样，失败时保留工作副本与最小步骤报告。

工具准备完成不代表某个包已经取得 Developer ID 签名或通过公证。真实身份、凭据、目标系统与 Agent 兼容性由发布操作者验收；没有这些证据时继续标为开发预览版。

## 先检查计划

在目标架构的 Mac 上完成四项仓库检查和打包。发布操作者自行准备 Developer ID Application 身份及已配置的 `notarytool` Keychain profile；本工具不创建凭据、搜索身份或读取密码。身份和 profile 名称是本机引用，密码、私钥与 API key 不接受为命令参数。

```sh
pnpm check
pnpm test
pnpm build
pnpm format:check
pnpm package:mac

node scripts/mac-release.mjs plan \
  --app /absolute/release/macos-arm64/Moor.app \
  --output /absolute/release/notarized-candidate \
  --identity 'Developer ID Application: YOUR NAME (YOURTEAMID)' \
  --keychain-profile moor-notary
```

替换路径、证书身份与 profile 名称，输出目录的父目录应已存在。省略子命令也只生成计划；`plan` 不创建输出目录、不运行签名命令、不访问 Keychain、不上传文件。它枚举实际程序文件与嵌套签名目标，并给出源目录摘要、每个目标的权限模板和执行顺序。检查清单中的 native Agent、辅助进程和 framework，不能仅核对顶层应用名。

输入必须是规范路径中的 `Moor.app`。工具检查 Moor 入口、许可证、常见私有数据、非普通文件和越界符号链接；应用中不能混入操作者配置或数据库。发布输入应来自本仓库锁定依赖的构建流程，不能把这些检查当成任意目录内容的安全认证。输出目录必须全新且位于源应用之外，已有输出不会被覆盖。

## 明确执行

确认具体计划后，将同一命令中的 `plan` 改成 `execute`。这一步会使用指定身份签名，并把工作副本的 ZIP 上传给 Apple 公证服务；它不会发布到 GitHub、安装或替换用户应用。

执行过程依次完成：

1. 独占创建输出目录，复制程序并复核源文件清单与摘要。
2. 按从内到外的顺序签名 Mach-O、各 framework 版本、辅助应用和主应用，启用 hardened runtime 与安全时间戳。签名不使用 `--deep`。
3. 验证每个签名及 Developer ID 团队要求，再对整个应用执行严格验证。
4. 创建提交 ZIP，调用 `notarytool submit`，只接受解析后的明确 `Accepted` 结果。
5. 对应用装订公证票据，验证票据、嵌套签名及 Gatekeeper，再生成最终 `Moor-notarized.zip` 和 SHA-256。

`release-report.json` 只记录步骤、源摘要、公证状态和最终归档摘要，通过同目录独占临时文件、文件同步、原子替换和目录同步保存；写入失败不会截断上次完整记录。凭据、命令输出、任务正文与原始服务器诊断不会被写入报告。只有全部步骤通过才报告 `complete`；不能把中间的 `submission.zip` 或目录存在当作正式分发成功。

权限模板位于 `scripts/mac-entitlements/`。Electron 仅允许 JIT；固定路径的 Codex 原生程序另允许未签名可执行内存；Claude 固定模板保留锁定二进制所声明的 JIT、未签名可执行内存、关闭库验证、Apple Events 与音频输入权限。普通原生程序使用空模板，库不附加应用权限。模板不会从输入应用的任意签名自动继承。原生 Agent 的权限需求和 Apple 审核仍须用实际锁定版本验证，不能因合成命令通过就宣称可正常启动模型。

## 失败与人工验收

任一步失败即停止后续动作，保留工作副本、提交归档和脱敏报告。工具不会自动重新上传或删除失败目录；先核对报告中的失败步骤及公证记录，再由发布操作者决定下一次操作。公证结果未知不等于未上传，也不能进入票据装订或最终发布。

报告的 `notarySubmission` 分为 `not-started`、`possibly-submitted` 和 `confirmed-submitted`。派发前先保存“可能已提交”，收到合法提交编号后保存原编号；超时即使没有最终状态也保留编号。已知编号可由操作者用 `xcrun notarytool info <原编号> --keychain-profile <原 profile>` 查询，用 `log` 检查 Apple 诊断。没有编号时先核查同一 profile 的提交历史，不能直接再次执行上传。当前工具不自动续接失败的执行，也不会把后续人工查询结果改写为完整发布成功。

最终包仍需在干净的目标架构 Mac 验证首次打开、系统权限、本机 Agent 登录与启动、CLI、网页预览、升级后数据可读及退出。另一台 Mac 和 iPhone 的跨设备验收见[设备验收](validation.md)。签名、公证与 Gatekeeper 检查不能证明全部业务流程、真实 Agent 或系统生命周期均已通过。

实现依据：[Apple 签名技术说明](https://developer.apple.com/library/archive/technotes/tn2206/_index.html)、[Apple Mac 分发签名](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac)、[Apple 公证要求](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)、[Electron 签名说明](https://www.electronjs.org/docs/latest/tutorial/code-signing)、[Electron 公证工具](https://github.com/electron/notarize)。返回[开发与验证](development.md)。
