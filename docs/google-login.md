# 个人 Google 登录

Moor 的自托管中转可以启用 Google 登录。每个中转仍只有一个个人账号；本机工作区保持独立，不需要 Google 或中转账号。此功能只请求 `openid email`，不申请 Google Drive、Gmail 或其他资源权限，不保存 Google access token、ID token 或 refresh token。

## 配置中转

在自己的 Google Cloud 项目中创建 **Web application** 类型的 OAuth 客户端，配置应用品牌与同意页面，登记中转的准确回调地址：

```text
https://moor.example.com/api/auth/google/callback
```

将域名替换成实际 `MOOR_ORIGIN`，包括非默认端口。正式使用需要 HTTPS；本机开发可使用准确的 localhost、127.0.0.1 或 IPv6 回环 HTTP 地址。不要把 Electron 内嵌页面登记成 Google 授权页，也不需要为每台 Mac 单独配置客户端密钥。配置要求见 [Google Web 服务端流程](https://developers.google.com/identity/protocols/oauth2/web-server)。

在服务器的私有环境配置中设置 `MOOR_GOOGLE_CLIENT_ID` 和 `MOOR_GOOGLE_CLIENT_SECRET`，重启中转。两者都为空时隐藏 Google 登录；只设置其中一项或配置无效时服务拒绝启动，并给出不含私密值的错误。Compose 已接入这两个变量，现有部署需在服务器修改配置；更新脚本不上传本地凭据。

密钥只留在中转服务器。不要放入 Mac 项目、会话、浏览器配置或代码仓库，也不要加入程序归档与 Docker 构建上下文。Google Console 中的测试用户、应用发布状态和同意页面由操作者管理。实现和合成验证不代表已经配置好真实客户端。

## 建号、绑定与登录

新中转在登录页提供“使用 Google 创建账号”。填写首次启动生成的初始化口令，在 Google 选择账号，回到 Moor 后确认显示的邮箱。只有最终确认后才创建个人账号；取消、过期或重启后需重新开始。

已有密码账号先按原方式登录，在“设置与账号 → Google 登录设置”中输入当前 Moor 密码并绑定 Google。账号 ID、已配对电脑、工作区及原密码保持不变。Google 登录依据已经验证的 `issuer + sub`，相同邮箱不会自动关联两个身份；Google 邮箱变化也不会修改原密码登录邮箱。这遵循 [Google 身份验证说明](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)。

以后可从浏览器、iPhone Safari/PWA 或 Mac 的“我的所有电脑”选择“使用 Google 登录”。Mac 会打开系统浏览器；核对浏览器和原 Moor 窗口的确认码，在浏览器明确允许，再返回 Moor 点击“完成 Google 登录”，并在原生对话框确认邮箱与服务地址。Moor 登录凭据只由桌面主进程接收，不进入页面或接续链接。Google 不支持在可控嵌入浏览器中完成授权，见 [Google OAuth 政策](https://developers.google.com/identity/protocols/oauth2/policies)。

没有后台轮询或自动重试。关闭页面、切换服务、退出登录、取消或到期会使原尝试失效；失败后可以取消并重新发起。Google 授权码按标准协议出现在 Google 回调 URL 中，服务处理后跳转到固定的无参数确认页；Moor 的接续密钥和登录 Cookie 不进入 URL。

绑定和登录并不执行 Agent，也不配对新电脑。Google 登录成功后，所有会话请求仍使用原来的账号、设备、工作区、项目与会话归属校验。

## CLI 系统浏览器接续

CLI 可以登录已存在且已关联 Google 的个人账号。建号与绑定仍使用上面的浏览器或 Mac 设置流程；CLI 不接收初始化口令、Moor 密码或 Google 令牌来完成这两个动作。

先构建程序，在项目外的私有 CLI 状态目录中开始一次接续：

```sh
node dist/cli.mjs auth google-start --server https://moor.example.com
```

成功结果 `data` 包含 `origin`、`browserUrl`、`code` 和 `expiresAt`。手动在系统浏览器打开返回的 `browserUrl`，选择 Google 身份，核对 Moor 服务地址、邮箱及与 CLI 一致的确认码，再明确确认。CLI 不自动打开应用、轮询浏览器或完成登录；URL 只含公开流程编号，接续密钥保存在本机私有 CLI 状态，绝不输出。

回到同一个 CLI 状态目录，手动读取结果：

```sh
node dist/cli.mjs auth google-review
```

`data.status:"pending"` 表示浏览器尚未确认；`"ready"` 会返回 `email`、`origin`、`code` 和到期时间。核对实际显示的完整邮箱和确认码后，通过标准输入提交严格 JSON，仅包含这两个字段：

```sh
node dist/cli.mjs auth google-confirm --stdin <<'JSON'
{"expectedEmail":"owner@example.com","expectedCode":"AB12-CD34"}
JSON
```

示例邮箱和代码必须替换为本人刚核对的值；代码是大写十六进制 `XXXX-XXXX`。不支持把确认内容放进参数或用 `--file` 代替。成功仅输出已登录账号、邮箱和服务地址，登录 Cookie 留在私有状态。Google 授权不会因此批准设备根、配对请求或 Agent 执行。

开始和最终提交前会持久记录流程状态，原状态目录中的另一次登录、退出或设置变化会使旧操作失效。`finishing` 表示最终提交可能已经派发：响应丢失时不会再次发送该 POST，也不能因报错断言尚未登录。若 Cookie 已以 `issued` 保存而最后的身份核查失败，可在流程有效且本机状态未改变时，手动再次提交相同 `google-confirm`；它只读取 `/api/me` 核对已有凭据，不再次申请登录。

取消当前尝试使用：

```sh
node dist/cli.mjs auth google-cancel
```

取消会先使旧本机流程失效，再尝试取消中转流程；若已保存新 Cookie，则请求撤销该凭据。检查返回的 `serverConfirmed`，不能把仅本机取消等同于服务器撤销。已签发凭据的撤销结果不明时保留待处理状态；后续需手动核查或取消，不能用新登录覆盖未知结果。过期或未完成流程不会在重启后自动继续，重新开始前先手动取消。

需要发布或同步设备公开信任版本时，先核对 CLI 的当前远程登录，再导出专用私有连接文件：

```sh
node dist/cli.mjs auth export-trust --output /private/device/.moor-security/trust-connection.json
```

父目录须为当前用户持有的 `0700` 私有目录，输出须是新的绝对文件路径；不会覆盖已有文件。本机 `--connection` 登录不能导出。输出文件含 Moor 登录 Cookie，不能加入项目、会话或仓库；终端只返回路径。发布/同步命令只传公开签名材料，具体流程见[设备安全命令](device-security.md#发布与同步公开信任版本)。

## 解除绑定与本机恢复

已有 Moor 密码时，可以在设置中再次验证密码后解除 Google 绑定。解除绑定会撤销未完成的 Google 登录尝试，保留当前 Moor 登录与已配对电脑。Google 是唯一登录方式时不允许直接解除，以免失去访问入口。

失去 Google 访问权限时，服务器操作者可在中转本机设置恢复密码。先停止中转并备份整个数据目录，在源码及程序目录之外准备仅自己可读的 UTF-8 JSON 文件，内容为新的密码登录邮箱和至少 12 字符的密码：

```json
{ "email": "owner@example.com", "password": "replace-with-your-private-password" }
```

在已构建的仓库中执行以下命令，用实际路径替换示例：

```sh
MOOR_DATA_DIR=/private/moor-data node dist/server.mjs --recover-account < /private/account-recovery.json
```

独立 relay 程序包的入口是 `node server.mjs --recover-account`。Compose 部署可在停止 relay 后，使用原项目名、环境文件和当前发布镜像覆盖配置执行 `run --rm --no-deps -T relay node server.mjs --recover-account`，通过标准输入传入私有 JSON。不要将密码写进命令行参数、环境变量或终端历史；完成后按自己的凭据保管策略处理输入文件。

恢复只操作已经存在的 Moor 账号数据库，不会创建新库或导入旧应用历史。新版本中转与恢复工具共享互斥锁；旧版本也必须先停止。成功后所有旧登录和未兑换配对码失效，已配对电脑、原账号 ID 与 Google 关联保留。重启中转，用新的邮箱和密码登录后即可管理绑定。恢复入口没有 HTTP 路由，不能从远程页面调用。

## 验证范围

合成验证覆盖实际签名校验、短期 state/nonce/PKCE、单次消费、账号事务、密码恢复、浏览器和桌面确认、CLI 手动接续与私有连接导出、取消及异步竞争。Google 令牌验证使用锁定的 `jose`，实现遵循 [OpenID Connect ID Token 校验](https://openid.net/specs/openid-connect-core-1_0-errata2.html#IDTokenValidation)。中转重启不会继续旧认证流程。

真实 Google 客户端、Mac 系统浏览器接回、Mac mini、MacBook Air、iPhone Safari/PWA、Google 同意页面与撤销权限仍需在操作者环境中验收。这是身份认证功能；M6.2 尚未完成，生产远程会话仍是明文 v3，跨主机迁移也未接通，不能将本批 HTTPS 或 Google 登录视为已实现它们。

返回[文档目录](README.md)。
