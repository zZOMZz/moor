# Moor 中转服务部署与迁移

中转服务使用 Node 24、WebSocket 和 SQLite。以下命令在仓库根目录运行，先执行 `corepack pnpm package:relay` 生成服务包。服务只保存账号、设备绑定与撤销；项目和完整会话仍在执行电脑。

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

1. 两台 Mac 配对同一账号，iPhone 用 Safari 登录并添加到主屏幕；分别确认设备名称和项目。
2. 手机在 Mac A 创建会话、审批一次修改并继续对话；Mac B 查看并继续同一会话。核对修改只出现在 Mac A 的项目。
3. 反过来从 Mac A 操作 Mac B 的会话，测试停止当前回合；旧审批不能影响之后的新回合。
4. 关闭手机页面，在主机上确认任务继续运行。重新打开手机后应补齐输出。
5. 在访问端已读过会话后断开 Mac A 的中转连接。Mac A 应仍可使用本机工作区；其他设备只能看已有缓存。未缓存会话不能伪装成已加载历史。
6. 离线输入草稿，恢复连接，确认草稿未自动发送。对“结果待确认”使用原请求的“重试确认”，核对主机上没有重复回合。
7. 重启中转服务，再打开 PWA，核对登录、选中的主机、历史补齐、草稿和审批状态。

已在本机 Docker 的独立容器与数据卷中验证 HTTPS/WSS、合成双主机路由、断线与手动重试，以及停机备份恢复。TLS 使用显式信任的测试 CA；公网证书签发、公司网关、真实双 Mac 和 iPhone 仍需在目标环境验收。
