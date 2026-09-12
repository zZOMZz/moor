# Moor 中转服务部署与迁移

中转服务使用 Node 24、WebSocket 和 SQLite。以下命令在仓库根目录运行，先执行 `corepack pnpm package:relay` 生成服务包。服务保存账号、设备绑定与撤销，以及工作区、逻辑项目和副本映射；代码、Agent 配置和完整会话仍在执行电脑。

当前使用 Moor 桥接协议 **v3**，中转服务与 Mac 客户端需一起更新，已有中转沿用原数据卷。从旧运行时升级时需重新配对电脑并登记项目，旧历史和草稿不自动导入。账号与组织目录的数据迁移不会使旧协议设备兼容新主机。数据边界见[核心架构](../docs/core.md)，版本与恢复语义见[运行与恢复](../docs/runtime.md)。

## 通过本地 SSH 更新已有 VPS

本地需要 Node 24、已安装的锁定依赖、pnpm、SSH 和 SCP。先在本机配置 SSH 别名 `moor-vps`，独立核实并信任服务器主机密钥。脚本使用非交互认证与严格主机密钥检查，不上传 SSH 密钥或本地 `.env`。VPS 需要 Bash、Docker Compose、Python 3、curl、flock、sha256sum 和 tar；默认通过 `sudo -n docker` 操作容器。

```sh
# 只读：验证连接、Docker 权限、现有数据卷与公网 HTTPS 健康状态
pnpm deploy:check

# 主动发布当前工作区的代码（包含尚未提交的修改）
pnpm deploy:relay
```

默认更新 `moor-vps` 上 `/opt/moor/compose.yaml` 的 `moor` 项目，只重建 `relay` 服务。其他部署可传入 `--host`、`--compose`、`--project`、`--state`；Docker 不需要 sudo 时传入 `--sudo no`。路径使用不含空格的绝对路径。

```sh
pnpm deploy:check --host my-vps --compose /srv/moor/compose.yaml --project existing-moor --state /srv/moor/.moor-deploy --sudo no
```

此入口只更新已有且健康的单实例中转服务，不负责首次安装或更改域名、环境变量和 Compose 配置。执行前确认这些配置与运行中的服务一致。脚本会核对 `/data` 的实际命名卷与 Compose 解析出的卷名，发现不一致立即退出。`deploy:check` 不修改服务器文件；发布时还会获取部署锁，防止同一状态目录内的并发发布。

发布先运行 `pnpm check`、`pnpm test`、`pnpm build` 和 `pnpm format:check`，任一失败即退出。随后只上传现有打包脚本生成的程序归档，验证 SHA-256，并在 VPS 构建新镜像。构建成功后停止中转、备份完整 `/data`，然后启动新版本，验证容器内健康状态和原域名的 HTTPS `/healthz`。更新期间中转连接会短暂断开；这不是零停机发布。

程序、备份和镜像覆盖配置分别保存在 VPS 的 `/opt/moor/.moor-deploy/release-*` 内。备份不进入程序目录或 Docker 构建上下文，也不下载到源码仓库。备份含账号与设备凭据，文件默认仅部署用户可读。旧镜像与备份不会自动清理，应由操作者按自己的保留策略管理磁盘空间。

成功后，`/opt/moor/.moor-deploy/current.json` 记录新镜像；原 Compose 文件、`.env`、证书卷和数据卷继续沿用。**之后手动运行 Compose 必须追加此覆盖文件**，否则原配置中的旧镜像可能被重新启动：

```sh
sudo -n docker compose -p moor -f /opt/moor/compose.yaml -f /opt/moor/.moor-deploy/current.json ps
sudo -n docker compose -p moor -f /opt/moor/compose.yaml -f /opt/moor/.moor-deploy/current.json up -d --no-build --pull never
```

### 发布失败与恢复

- 校验或镜像构建失败：原服务继续运行。
- 停机备份失败：脚本尝试启动原容器，不运行新程序。
- 尝试启动新版本后失败：脚本停止新服务，输出本次发布目录。该目录保留 `data.tar.gz`、`previous.json` 和 `next.json`，不会自动覆盖数据库或启动旧版本，因为新程序可能已经迁移了数据。

恢复前先核对数据库兼容性、失败阶段和服务状态。如果确认旧版本可直接使用当前数据，可在 VPS 执行以下命令，用实际发布目录替换 `RELEASE`：

```sh
RELEASE=/opt/moor/.moor-deploy/release-实际目录
sudo -n docker compose -p moor -f /opt/moor/compose.yaml -f "$RELEASE/previous.json" up -d --no-deps --no-build --pull never relay
# 核对健康状态后再更新后续手工操作使用的镜像记录
cp "$RELEASE/previous.json" /opt/moor/.moor-deploy/current.json
```

如需恢复停机备份，先停止服务并保存失败后的数据，按照下文的备份恢复流程恢复至新建空卷，再明确调整 Compose 卷映射；恢复会舍弃备份之后的写入，不能盲目将归档覆盖到现有数据库上。SSH 中断或强制终止后，应先检查容器和本次发布目录，再决定恢复或重新发布。

`/healthz` 只验证中转可访问。发布后仍需用真实 Mac/iPhone 检查登录、执行电脑在线、历史补齐及手动重试；这些操作不由部署脚本自动执行。

## 启动 HTTPS 服务

复制 `.env.example` 为同目录的 `.env`，填写 `MOOR_DOMAIN`，只写域名，不带协议或路径。将域名解析到服务器，并允许访问 80/443。Caddy 会申请和续期证书，详见 [Caddy 自动 HTTPS 文档](https://caddyserver.com/docs/automatic-https)。

```sh
cp deploy/.env.example deploy/.env
# 编辑 deploy/.env 后启动
docker compose -p moor --env-file deploy/.env -f deploy/compose.yaml up -d --build
docker compose -p moor --env-file deploy/.env -f deploy/compose.yaml exec relay cat /data/setup-token
```

新部署使用固定的 Compose 项目名 `moor`。已有部署继续使用原项目名，避免切换到新的空数据卷。浏览器访问该 HTTPS 域名，用初始化口令创建个人账号，然后配对电脑。`/healthz` 返回 `{"ok":true}` 只表示中转进程可访问；还需在客户端确认执行电脑在线。

内网部署同样需要访问端信任的 HTTPS 证书。可以由公司现有 HTTPS 网关终止 TLS 并转发 HTTP/WebSocket 到 `relay:3078`，也可以给 Caddy 挂载公司签发的证书，使用 `tls /certs/cert.pem /certs/key.pem`。只有网关应能访问中转的 HTTP 端口。`MOOR_ORIGIN` 必须与浏览器实际访问的完整 origin 一致，包含非默认端口。证书配置见 [Caddy TLS 文档](https://caddyserver.com/docs/caddyfile/directives/tls)。

仅用于开发时可使用 Caddy 的 `tls internal`，但各访问端仍需信任其 CA；容器里的证书不会自动成为 iPhone 或 Mac 信任的证书。不要通过关闭证书校验来完成设备验收。

## 配置个人 Google 登录

中转可选启用 Google 登录。在 Google Cloud 登记 Web OAuth 客户端及准确的 `/api/auth/google/callback` 地址，将 `MOOR_GOOGLE_CLIENT_ID` 与 `MOOR_GOOGLE_CLIENT_SECRET` 留在服务器私有环境配置中，再重启服务。Mac 通过系统浏览器登录，客户端不保存 Google 密钥。已有密码账号需显式绑定，不能靠邮箱自动关联。建号、恢复命令和真实设备限制见[个人 Google 登录](../docs/google-login.md)。

## 配置 Web Push

Web Push 默认未配置；桌面本机通知不依赖此配置。需要远端浏览器或 PWA 通知时，在私有配置目录生成一次 VAPID 密钥，使用真实的操作者联系地址替换示例：

```sh
node scripts/create-web-push-keys.mjs --output .data/web-push.env --subject mailto:operator@example.com
docker compose -p moor --env-file deploy/.env --env-file .data/web-push.env -f deploy/compose.yaml up -d --build
```

命令创建仅当前用户可读的文件，不在终端输出密钥，并拒绝覆盖已有文件或符号链接。文件含 `MOOR_WEB_PUSH_PUBLIC_KEY`、`MOOR_WEB_PUSH_PRIVATE_KEY` 和 `MOOR_WEB_PUSH_SUBJECT`，由 Compose 作为环境配置读取。保持此文件私有，不提交、不复制进程序包或 Docker 构建上下文；部署到其他服务器时用操作者自己的私有配置传递方式保存相同变量。已有 VPS 的更新脚本不会上传或修改此配置，须先在服务器设置环境变量，再使用原有更新流程。

启用后，后续 Compose 操作继续包含这两个 `--env-file` 参数；已有部署还需保留实际使用的项目名和镜像覆盖文件。未设置或密钥无效时，通知设置显示未配置原因，其余服务仍可使用。服务只接受确切的 `fcm.googleapis.com`、`updates.push.services.mozilla.com`、`web.push.apple.com` HTTPS 端点；其他供应商或 Apple 子域当前不支持。

密钥应随服务私有配置独立备份，不能在每次构建或重启时重建。更换密钥或域名后，需要用户关闭旧订阅并手动重新开启。SQLite 数据备份包含私有订阅材料，应与登录、设备凭据同样保护。供应商接受推送不等于设备显示，启用后仍须完成真实已安装 PWA 的前后台验收，见[任务通知](../docs/notifications.md)。

## 停机备份

先停止服务，确保 SQLite 写入已经完成。备份整个 `/data`，保留数据库、可能存在的 WAL 文件和初始化口令。备份包含登录及设备凭据记录，放在源码目录之外。

```sh
umask 077
mkdir -p ../moor-backups
docker compose -p moor --env-file deploy/.env -f deploy/compose.yaml stop
docker compose -p moor --env-file deploy/.env -f deploy/compose.yaml run --rm --no-deps -T relay tar -C /data -czf - . > ../moor-backups/relay-data.tar.gz
```

普通备份完成后可以用原来的 `up -d` 命令恢复服务；迁移时先保持旧服务停止。不要删除旧数据卷。程序压缩包和 Docker 镜像只包含程序文件，不包含这个数据备份；重新打包也不会删除服务包目录中的运行数据。

## 恢复到新服务器

在新服务器准备同版本代码与服务包，配置新的域名或内网网关，将备份放到 `../moor-backups/relay-data.tar.gz`。下列恢复命令仅用于新建、尚无账号的目标数据卷；不要覆盖已有服务的数据库。

```sh
docker compose -p moor --env-file deploy/.env -f deploy/compose.yaml build relay
docker compose -p moor --env-file deploy/.env -f deploy/compose.yaml run --rm --no-deps -T relay tar -C /data -xzf - < ../moor-backups/relay-data.tar.gz
docker compose -p moor --env-file deploy/.env -f deploy/compose.yaml up -d
```

账号、设备绑定和撤销记录随数据卷恢复。Caddy 的证书卷与账号数据卷独立；目标服务器需要重新申请证书，或按公司的证书部署流程配置。迁移前后域名一致时，客户端可以继续使用原设备凭据连接。

如果域名改变，在新地址重新登录，在 Mac 连接设置中用新地址及一次性配对码重新配对，确认新连接后撤销旧设备条目。浏览器缓存按 origin 隔离：旧地址下的草稿、缓存和待确认请求不会自动出现在新地址。切换前保存未发送的草稿，并在原地址核对待确认请求；同一账号不能把浏览器缓存迁移到另一域名。

恢复后先检查 `/healthz`、原账号登录、设备列表及已撤销设备不可连接，再重新连接执行电脑。历史对话应从电脑按需加载；中转服务本身没有历史正文副本可恢复。

## 设备验收

下面的步骤需要两台真实 Mac 和 iPhone，使用专门的测试项目：

1. 两台 Mac 配对同一账号下的同一工作区，iPhone 用 Safari 登录并添加到主屏幕；分别确认设备名称和本地项目副本。
2. 手机在 Mac A 创建会话、审批一次修改并继续对话；Mac B 查看并继续同一会话。核对修改只出现在 Mac A 的项目。
3. 反过来从 Mac A 操作 Mac B 的会话，测试停止当前回合；旧审批不能影响之后的新回合。
4. 关闭手机页面，在主机上确认任务继续运行。重新打开手机后应补齐输出。
5. 在访问端已读过会话后断开 Mac A 的中转连接。Mac A 应仍可使用本机工作区；其他设备只能看已有缓存。未缓存会话不能伪装成已加载历史。
6. 离线输入草稿，恢复连接，确认草稿未自动发送。对“结果待确认”使用原请求的“重试确认”，核对主机上没有重复回合。
7. 重启中转服务，再打开 PWA，核对登录、选中的主机、历史补齐、草稿和审批状态。
8. 将两台 Mac 的测试目录归入同一逻辑项目，确认项目筛选汇总两台电脑的会话；分别打开会话，核对执行电脑和目录。
9. 创建第二个工作区，将其中一台 Mac 的本地工作区移入；确认工作区列表和项目归属更新，原会话与草稿仍可恢复，正在运行的任务没有迁移或重启。

已在本机 Docker 的独立容器与数据卷中验证 HTTPS/WSS、合成双主机路由、断线与手动重试，以及停机备份恢复。TLS 使用显式信任的测试 CA；公网证书签发、公司网关、真实双 Mac 和 iPhone 仍需在目标环境验收。
