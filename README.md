# pi-progress-compact

[pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 扩展：下载/传输时在 TUI 底部显示实时网速与进度，同时把 bash 输出里的大量进度刷新折叠掉，避免塞满模型上下文。

## 功能

- **状态栏实时进度**（只在 TUI 显示，不进上下文）：`⬇ 269KB/s ⬆ 50KB/s · 收4.3MB 发304KB · 17% · 0:24`
  - 速度/累计量读 `/proc/net/dev`（整张网卡，含其他并发流量；仅 Linux）
  - 百分比从命令输出识别：rclone、wget、curl（`-#` 与默认进度表）、git clone、scp 等
- **scp 百分比**：含 `scp` 的命令自动用 `script` 套伪终端，让 scp 打印进度条；未使用 `sshpass` 时设 `SSH_ASKPASS=/bin/false SSH_ASKPASS_REQUIRE=force`，要密码/确认指纹会立即失败而不是卡住
- **gh 估算百分比**：`gh run download` / `gh release download` 开始时用 GitHub API 查产物/资产总大小（支持 `-n`、`-p`），按网卡收量估算 `≈45%/64MB`
- **压缩工具输出**：返回给模型的 bash 结果把进度刷新折叠为最后约 6 行；原始输出保留在 pi 的 `fullOutputPath` 或 `/tmp/pi-progress-*.log`

## 安装

```bash
mkdir -p ~/.pi/agent/extensions
curl -fsSL https://raw.githubusercontent.com/Linyesantan/pi-progress-compact/main/progress-compact.ts \
  -o ~/.pi/agent/extensions/progress-compact.ts
```

然后在 `~/.pi/agent/settings.json` 的 `extensions` 里加入该路径（或放在自动加载目录），已打开的 pi 会话执行 `/reload`。

依赖：Linux、`script`（util-linux）；gh 估算需已登录的 `gh`。

## License

MIT
