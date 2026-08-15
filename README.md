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
  - **文件** — 改动按文件聚合成卡片，真·逐行 diff（LCS + 上下文折叠）、+N/−N 统计、展开/收起（⌘P）
  - **浏览器** — agent 驱动的无头 Chromium 实时画面 + 搜索/抓取活动流
  - **侧边聊天** — 临时轻量聊天（⌥⌘S），流式回复，关闭应用即消失，不打扰主会话
- 🔌 桌面行为全部以 DSH 插件（profile patch overlay）实现：`bridge/`（活动采集 + 共享 PTY + `terminal_send` 工具）、`browser/`（实时浏览器）
- 🔒 引擎只绑定 127.0.0.1，外部链接自动走系统浏览器
- 🔄 自动更新走 GitHub Releases；大陆用户可用 `DSH_GUI_UPDATE_URL` 指向镜像源

## 安装 / Install

> 目前仅提供 Apple Silicon (arm64) 版本。Currently Apple Silicon (arm64) only.

1. 从 [Releases](https://github.com/Caxson/dsh-gui/releases) 下载最新 `Dsh.GUI-<版本>-arm64.dmg`
2. 双击打开，把 **Dsh GUI** 拖进「应用程序」
3. **首次打开前**在终端执行一次（见下方说明）：

   ```bash
   xattr -cr "/Applications/Dsh GUI.app"
   ```

4. 打开后进入 **设置 → 模型** 填入 DeepSeek（或任意 OpenAI 兼容）API Key，开聊

> 数据目录：机器上已有 `~/.dsh`（用过 dsh CLI / `dsh web`）时直接复用它——
> 会话、模型、插件与命令行侧完全同步；没有才使用
> `~/Library/Application Support/Dsh GUI/dsh-home`。`DSH_GUI_HOME` 环境变量可覆盖。

### 为什么会提示「已损坏，无法打开」？

这不是文件真的损坏。本项目未购买 Apple 开发者证书（$99/年），macOS Gatekeeper
会拦截所有从网络下载的未签名应用，并把它们统一报成「已损坏」。上面的 `xattr`
命令只是移除下载时附加的隔离标记，App 本身开源可审计，构建产物由
GitHub Releases 直出。First launch of an unsigned app is blocked by Gatekeeper
with a misleading "damaged" alert — the one-time `xattr -cr` above clears the
quarantine flag; the app is open source and built straight from this repo.
数据在 `~/Library/Application Support/Dsh GUI/dsh-home`，独立于你已有的 `~/.dsh`；
想复用现有 home：`DSH_GUI_HOME="$HOME/.dsh" open "/Applications/Dsh GUI.app"`。

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

`package.json` 改版本号 → `npm run dist` → 产物（dmg / zip / blockmap /
latest-mac.yml）传 GitHub Releases，老用户自动更新。
未签名构建也能检测新版本，但会退回「打开下载页手动装」；
完整自动替换需要 Apple Developer 签名 + 公证（配置已就绪，见 electron-builder.yml）。

## License

MIT © Caxson. DSH engine © DeepSeek — see the official
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) repository.
