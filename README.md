# Dsh GUI

**A Codex-like macOS desktop app for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).**

The DSH engine is the kernel; this app is a plugin layer on top of it — no fork,
no engine changes. The official `@deepseek-ai/dsh` package is bundled as-is and
booted headlessly (`dsh web`, loopback only, random port); desktop behavior is
injected through DSH's own plugin/patch system.

**一个 Codex 风格的 macOS 桌面客户端，内核是官方 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)。**
不重新发明引擎——App 只是 DSH 之上的「插件层」。

## 特性 / Features

- 🖥️ 原生 macOS 窗口，深色 Codex 风格；完整 DSH 能力（多会话、工具调用、工作区、Goal、子代理）
- 📋 **Codex 式右侧面板**（Cmd+B 呼出，默认隐藏；浏览器式多标签，可新建/关闭/弹出为独立窗口）：
  - **终端** — 与 agent 共享同一个 PTY（agent 跑的每条命令实时可见），可再开多个本地终端标签（⌘T）
  - **改动** — 改动按文件聚合成卡片，真·逐行 diff（LCS + 上下文折叠）、+N/−N 统计、展开/收起（⌘P）
  - **文件树** — 工作区目录树，按需逐层展开，生成目录默认折叠（⌘E）
  - **浏览器** — agent 驱动的无头 Chromium 实时画面 + 搜索/抓取活动流（Chromium 不随包分发，
    首次打开该标签时按提示下载，优先走国内镜像；下载后随用户数据保留，不会被更新覆盖）
  - **侧边聊天** — 临时轻量聊天（⌥⌘S），流式回复，关闭应用即消失，不打扰主会话
- 🔌 桌面行为全部以 DSH 插件（profile patch overlay）实现：`bridge/`（活动采集 + 共享 PTY + `terminal_send` 工具）、`browser/`（实时浏览器）
- 🔒 引擎只绑定 127.0.0.1，外部链接自动走系统浏览器
- 🔄 自动更新默认走国内 CDN 镜像（大陆下载更快更稳）；`DSH_GUI_UPDATE_URL=github`
  可切回 GitHub Releases，或填任意自建镜像地址

## 安装 / Install

> macOS 提供 Apple Silicon (`arm64`) 与 Intel (`x64`) 两个版本，请按芯片选择；
> Windows 提供安装版与免安装版（`x64`）。
> macOS ships Apple Silicon (`arm64`) and Intel (`x64`); Windows ships an
> installer and a portable build (`x64`).
>
> **Windows 版尚未经过真机验证，也未做代码签名**——首次运行 SmartScreen 会
> 提示，点「更多信息 → 仍要运行」即可。欢迎反馈问题。
> The Windows build is not yet verified on real hardware and is unsigned;
> SmartScreen warns on first run — choose "More info → Run anyway".

1. 从[下载页](https://dsh.merefusion.com)（自动识别芯片）或
   [Releases](https://github.com/Caxson/dsh-gui/releases) 下载对应的
   `Dsh-GUI-<版本>-arm64.dmg` / `Dsh-GUI-<版本>-x64.dmg`
2. 双击打开，把 **Dsh GUI** 拖进「应用程序」
3. 首次打开：Gatekeeper 会弹一次确认框，点「打开」即可（见下方说明）
4. 打开后进入 **设置 → 模型** 填入 DeepSeek（或任意 OpenAI 兼容）API Key，开聊

> 数据目录：机器上已有 `~/.dsh`（用过 dsh CLI / `dsh web`）时直接复用它——
> 会话、模型、插件与命令行侧完全同步；没有才使用
> `~/Library/Application Support/Dsh GUI/dsh-home`。`DSH_GUI_HOME` 环境变量可覆盖。

### 首次打开被 Gatekeeper 拦住了？

签名与公证已接入发布流程：仓库配置了 Developer ID 证书与公证凭证时，
CI 产出的就是已签名并公证的包，首次打开只会弹一次「来自互联网的 App」
确认框，点「打开」即可。

如果你下载到的是**未签名**的构建（凭证缺失时 CI 会降级产出），macOS 会
把它统一报成「已损坏，无法打开」——这不是文件真的损坏，执行一次即可：

```bash
xattr -cr "/Applications/Dsh GUI.app"
```

Signing and notarization are wired into the release pipeline: when the signing
credentials are present, CI produces signed + notarized builds and macOS only
shows the one-time "app downloaded from the internet" prompt. If you got an
unsigned build (CI degrades to unsigned when credentials are absent),
Gatekeeper reports it as "damaged" — the one-time `xattr -cr` above clears the
quarantine flag.

## 开发 / Development

```bash
npm install        # postinstall 会 vendor 面板依赖
npm start          # 开发运行
npm run smoke      # 端到端冒烟：引擎启动 + 面板 PTY + 布局探针
npm run dist       # 构建 dmg + zip（发版产物）
npm run dist:unsigned  # 无证书时的本地构建
```

架构速览：

```
src/main.js          Electron 主进程：引擎拉起、窗口/面板布局、更新
src/panel/           右侧面板（终端 xterm / 文件 diff / 浏览器）
bridge/              DSH 插件：活动采集、共享 PTY、terminal_send 工具
browser/             DSH 插件：agent 可驱动的无头 Chromium + 画面流
plugins/desktop.patch.yml   挂到 web profile 的 loader patch 覆盖层
```

## 发版 / Release

`package.json` 改版本号 → 打 `vX.Y.Z` tag 推送到 GitHub，Actions 云构建自动
发版：依赖闭包 + 文档一致性校验 → macOS dmg + zip（arm64 与 x64 各自在对应
架构的 runner 上构建）与 Windows 安装版 + 免安装版 → Apple Developer ID
签名 + 公证（仅 macOS）→ 挂到 GitHub Releases 并同步 OSS 镜像，老用户自动
更新；大陆用户可用 `DSH_GUI_UPDATE_URL` 指向镜像源。
未配置签名 secrets 时（如 fork），构建自动退回未签名版——功能不受影响，
只是首次打开需右键 →「打开」。
Releases are built on GitHub Actions with Developer ID signing +
notarization; without signing secrets the workflow falls back to unsigned
artifacts automatically.

## License

MIT © Caxson. DSH engine © DeepSeek — see the official
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) repository.
