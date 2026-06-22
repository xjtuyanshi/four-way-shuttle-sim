# Mac mini Codex Remote Setup

这个文件是给 Mac mini 上的 Codex/Terminal 用的。目标是把 Mac mini 准备成可以接手 `four-way-shuttle-sim-2.0` 的 Codex host。

## 最快操作

在 Mac mini 上打开这个项目文件夹，然后双击：

```text
scripts/setup-codex-mac-mini-remote.command
```

如果 macOS 提示不能打开，右键点这个文件，选择 `Open`。

脚本会做这些事：

- 临时启动 `caffeinate`，让 Mac mini 24 小时不睡。
- 检查并提示是否打开 `Remote Login`。
- 打印 Mac mini 的用户名、`.local` 地址和局域网 IP。
- 检查 `codex --version`、Codex.app、项目 Git 状态、Node/pnpm。
- 如果 Syncthing CLI 可用，会打印 `codex-projects` 的同步状态。
- 生成当前 Mac 要用的 SSH config snippet。
- 生成给 Mac mini 上 Codex 继续工作的 prompt。

脚本不会做这些事：

- 不改项目代码。
- 不 reset / checkout / commit。
- 不改 `.syncthing` 临时文件。
- 不自动打开公网端口。

## 跑完后看哪里

脚本会生成：

```text
output/remote-setup/mac-mini-remote-readiness-*.txt
output/remote-setup/mac-mini-ssh-config-snippet.txt
output/remote-setup/mac-mini-codex-continuation-prompt.md
```

把 readiness report 里这几项发回当前 Mac：

```text
User
LocalHostName
Remote Login
codex --version
ssh user@xxx.local
```

## 当前 Mac 上的下一步

在当前 Mac 上先测试：

```bash
ssh <User>@<LocalHostName>.local
```

如果能登录，再把 `mac-mini-ssh-config-snippet.txt` 里的内容加到当前 Mac 的：

```text
~/.ssh/config
```

然后打开 Codex App：

1. `Settings > Connections`
2. 添加或启用这个 SSH host
3. 选择 Mac mini 上同一个项目路径
4. 回到当前线程底部，选择 Mac mini 作为 handoff 目标

## 如果不走 SSH

如果你只想从手机/另一台 Mac 控制 Mac mini 上已经打开的 Codex：

1. 在 Mac mini 上打开 Codex App。
2. 进入 `Set up Codex mobile` 或 `Settings > Connections`。
3. 用同一个 ChatGPT 账号/Workspace 配对。
4. 保持 Mac mini 醒着、联网、Codex 不退出。

这种方式适合远程盯进度和继续对话；要把当前本机线程和 Git 状态正式 handoff 到 Mac mini，仍然需要 Codex 能看到 Mac mini 上同一个 repo/project。
