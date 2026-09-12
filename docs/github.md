# GitHub 仓库与会话上下文

Moor 可以读取执行电脑明确登记的 GitHub.com 仓库、分支、Issue、PR、会话评论和指定提交的 CI 状态，并将仓库、分支及 Issue/PR 关联到 Moor 会话。关联只修改 Moor 的本机记录，不会创建评论、推送提交、合并 PR 或启动 Agent。

这是 M4.3 的实现范围。配置、读取和关联边界已实现，四项仓库检查与 612 项自动测试通过，并完成合成浏览器检查。尚未使用真实 GitHub 账号或 API 验收，也不表示后续外部写入已完成。

## 在执行电脑配置

1. 在 **Moor → 连接设置 → GitHub** 展开设置，手动读取本机配置。先在 Moor 登记本地项目，再为该项目选择 GitHub 仓库。
2. 添加凭据备注和 token。保存后输入框清空，设置只返回备注、编号及连接状态，不返回已保存的 token。替换凭据会使相关项目回到未验证状态。
3. 手动检查账号连接。这只验证当前 token 能否读取账号，不代表它能读取所有仓库。
4. 选择本地项目、凭据并明确填写 `owner/repo`，保存并验证仓库。主机先保存未验证配置，再查询所选仓库；验证成功后固定其数字仓库 ID，远端才可读取。仓库同名重建或身份改变时，需要操作者重新确认绑定。
5. 删除凭据时同时移除使用它的项目配置；也可单独解除某项目的 GitHub 配置。配置变化会使访问页面清除已有 GitHub 内容，用户手动重新读取。

建议使用限定所需仓库的 fine-grained personal access token，并按使用的视图授予只读权限：Contents、Issues、Pull requests、Checks 和 Commit statuses。组织审批和仓库权限仍由 GitHub 管理；Moor 不会提高权限或自动寻找其他 token。权限选择见 GitHub 的[个人访问令牌说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)及[细粒度权限表](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)。

配置只在执行电脑的本机设置或本机 CLI 中管理。手机和其他电脑可以使用已验证的项目绑定，但没有读取、替换或删除主机凭据的远程接口。每个本地项目当前只配置一个仓库。同一个逻辑项目在两台电脑上的配置分别保存，不从 Git remote、浏览器登录或 Agent 凭据推断授权。

## 数据保存范围

| 位置                        | 保存内容                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------- |
| 执行电脑的 `github-v1.json` | token、凭据备注、验证状态、明确的项目仓库配置及主机身份；文件权限为 `0600`              |
| 执行电脑的 Moor SQLite      | 会话关联的仓库/分支/Issue 或 PR 标识、版本与操作去重凭据；不保存 GitHub 正文            |
| 中转                        | 转发读取结果和本地关联请求，不持久保存 token、GitHub 正文或关联正文副本                 |
| 浏览器                      | GitHub 读取结果仅在内存中；待确认关联只保存完整目标、版本和原操作，不保存 provider 正文 |

token 使用本机私有 JSON 保存，当前没有 Keychain 或额外文件加密。文件默认在主机数据库旁，可用 `--github-config-dir` 指定其他私有目录；该目录必须位于**所有已登记项目之外**。保存、读取配置和使用凭据时都会检查这一边界；后来把其父目录登记为项目也会使配置不可用。

Moor 的自动文件树、回合快照与手动文件读取保留 `github-v1.json` 和 `github-v1.json.tmp-*` 文件名，大小写不敏感，避免配置经项目内容接口暴露。此保护不能把原生 Agent 变成操作系统文件沙箱：Agent 仍受其自身进程与文件权限约束，所以主机私有数据不能放进代码项目。

私有配置、数据库和备份不进入 Git、日志、发布压缩包或 Docker 构建上下文。备份操作见[主机停机备份与恢复](runtime.md#主机停机备份与恢复)。

## 本机 CLI

CLI 与桌面设置使用同一配置模型。先停止持有该主机数据库的 Moor 进程，再运行配置命令；关闭窗口不等于退出。以下路径都是占位符，应替换为原主机数据库、配对配置及项目外的私有目录：

```sh
node dist/bridge.mjs \
  --config /absolute/private-moor/bridge-v3.json \
  --runtime-data /absolute/private-moor/runtime-v1.sqlite \
  --github-config-dir /absolute/private-moor/github \
  --github-config-stdin <<'JSON'
{"action":"read"}
JSON
```

读取返回配置 `revision`、凭据编号与本地项目编号。每次修改都携带刚读取的 `expectedRevision`；版本冲突后先重新读取，再由用户决定修改。配置命令不会启动回环服务、连接中转或调用 Agent；检查账号和仓库的动作会调用 GitHub。

token 只能经标准输入提交，不放进命令参数、shell 历史或示例配置。下面的可选 Python 辅助命令从终端隐蔽读取 token，只把 JSON 写入管道；代码本身没有 token。运行前先用上面的命令取得配置版本：

```sh
python3 -c '
import getpass, json, sys
def ask(prompt):
    print(prompt, file=sys.stderr, flush=True)
    return input()
print(json.dumps({
    "action": "credential-save",
    "expectedRevision": int(ask("当前配置 revision:")),
    "label": ask("凭据备注:"),
    "token": getpass.getpass("GitHub token: ")
}))
' | node dist/bridge.mjs \
  --config /absolute/private-moor/bridge-v3.json \
  --runtime-data /absolute/private-moor/runtime-v1.sqlite \
  --github-config-dir /absolute/private-moor/github \
  --github-config-stdin
```

其余动作通过同一 stdin JSON 接口提交：

| `action`            | 除 `action` 外的字段                                                  | 行为                              |
| ------------------- | --------------------------------------------------------------------- | --------------------------------- |
| `credential-save`   | `expectedRevision`、`label`、`token`；替换时加 `credentialId`         | 新增或替换 token，不自动检查连接  |
| `credential-check`  | `expectedRevision`、`credentialId`                                    | 检查账号连接                      |
| `credential-remove` | `expectedRevision`、`credentialId`                                    | 删除凭据及使用它的项目配置        |
| `project-bind`      | `expectedRevision`、`localProjectId`、`credentialId`、`owner`、`repo` | 明确配置项目仓库并验证数字仓库 ID |
| `project-check`     | `expectedRevision`、`localProjectId`                                  | 重新验证原仓库身份                |
| `project-unbind`    | `expectedRevision`、`localProjectId`                                  | 移除项目的 GitHub 配置            |

stdin 最多 16 KiB，一次接收一个完整 JSON。成功退出码为 `0`，输入或配置失败为 `1`，主机锁被占用或不可用为 `3`；输出和错误不回显 token。`--github-config-stdin` 不能与 `--desktop` 或 `--pair` 同用。后续正常启动主机时，仍需使用同一个 `--github-config-dir`；该参数不改变主机数据库或项目目录。

## 阅读、关联与加入草稿

会话的 GitHub 面板可以手动读取仓库与本地 Git 概况，分页查看分支、Issue、PR 和会话评论。页面只显示安全文本，不执行正文 HTML，也不自动读取正文中的外部链接。项目改绑、账号或执行目标切换、授权失效以及读取失败会清除当前 GitHub 内容；离线不回退到先前正文。

“关联到会话”保存当前仓库、分支和所选 Issue/PR 的引用。它不会切换本地分支、创建 worktree、修改源文件或自动给 Agent 添加上下文。若要使用内容，明确点击加入草稿；Moor 重新读取选中条目后把文本放入当前草稿，仍需用户手动发送。

**主动加入草稿后，文本适用普通 Moor 草稿和会话的保存规则。** 后续撤销 GitHub 授权不会删除已经明确复制的草稿或已发送的历史。仅浏览或关联不会产生这份正文副本。

关联请求先保存原操作编号、完整目标和预期版本；响应丢失后手动重试，刷新与重连不会自动提交。主机已保存的绑定，重试只返回无 GitHub 上下文的历史确认及关联版本，页面清除待确认状态并提示重新读取；这不代表当前授权仍然有效。即使随后凭据撤销，也可以确认原操作并手动解除本地关联。未到达主机的原请求仍需满足当前授权才能首次接受。

也可手动撤销待确认操作。页面先保存撤销意图，主机按原完整请求和编号处理：已经接受时返回原操作的脱敏确认；尚未执行时保存该编号的放弃记录，迟到的同编号请求也不能再执行。刷新后仍由用户手动继续同一次撤销，不改为重新提交绑定。这个动作不会撤销已经保存的关联；确认已保存后，需另行解除关联。

本机项目从仓库 A 改绑到 B 后，A 的旧会话关联保留在主机数据库中，但读取只返回当前可访问的 B 上下文；旧关联只提供修改所需的版本，可以明确解除或重新关联。Moor 不用旧正文绕过新配置。

## PR、CI 与读取限制

PR 的 **head** 是待合入内容，**base** 是目标仓库及分支。来自 fork 的 PR 可以拥有不同的 head 仓库，不能把它当成目标仓库内的同名分支；界面分别展示两侧仓库、分支和提交。源仓库已删除或无法提供时显示缺失，不猜测身份。

CI 读取绑定刚刚确认的 PR head SHA。主机读取该 SHA 的 check runs 与 commit statuses，并再次核对 PR；期间 head 或 base 改变则拒绝过期结果，要求重新读取。没有记录、只读到部分页或结果缺失都不能解释为全部 CI 通过。GitHub 将这两类数据分别作为[检查运行](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)和[提交状态](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference)提供。

| 边界       | 当前范围                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| 服务       | 仅固定的 `api.github.com` HTTPS GET；API 版本 `2026-03-10`，不跟随重定向，不支持 GitHub Enterprise 自定义域名 |
| 分页       | 每页最多 20 项，手动查看，最多第 100 页；当前页及后续内容不完整时有明确提示                                   |
| 正文       | 每条正文最多 16,000 个字符，超限标明截断                                                                      |
| HTTP       | 每次 HTTP 响应最多 2 MiB、10 秒，整个主机读取最多 25 秒；超限、权限或限流错误由用户手动重试                   |
| Issue 列表 | GitHub 返回的 PR 项会被过滤，过滤页标为部分结果；空页不能证明整个仓库没有 Issue                               |
| 评论       | Issue/PR 会话评论；不含代码行 review 评论同步                                                                 |
| CI         | 精确提交的 check runs 和 commit statuses；不含工作流日志、重跑或取消                                          |

检查运行使用 `filter=latest`，只显示各检查的最新结果。GitHub 的该接口最多覆盖同一提交最近的 1,000 个 check suites；分页结束也不代表读取了所有历史检查，详见[检查运行接口限制](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)。

本批不提供提交、推送、发布评论、创建/编辑/合并 PR 或其他 GitHub 写入。M4.4 外部写入、后续网页预览、M5 配置与协作以及按需求启动的 M6 继续按 [roadmap](roadmap.md)推进。

## 验收与实现入口

合成测试使用临时项目、虚构 token 和注入的 GitHub HTTP 响应，覆盖 token 不回显、私有文件权限、项目外目录、仓库身份变化、权限撤销、精确 SHA、分页、原操作确认和目标切换。CLI/IPC 测试运行实际主机入口，验证锁、大小限制、晚到回复和退出不重放。真实 GitHub 授权、组织限制、限流及双 Mac/iPhone 体验仍待[专项设备验收](validation.md#m43-github-只读集成专项步骤)。

实现入口：[公共协议](../src/github-protocol.ts)、[主机私有配置](../src/runtime/github-config.ts)、[GitHub 客户端](../src/runtime/github-client.ts)、[会话关联](../src/runtime/session-github.ts)、[Web 控制器](../src/web/github.ts)。

返回[文档目录](README.md)。
