# Dsh GUI — 设计系统

**家族：Terminal-Core × Data-Dense Pro。**

不是新选的，是把已经存在的东西命名下来。这个产品本体就是终端、文件树、diff 和一个
在跑的 agent——等宽、硬边、暗色优先、信息密度优先，是它的实质，不是贴上去的皮肤。
换成别的家族会和产品打架。

写下来是因为：**没有这份文件，下一次改动会漂成另一套视觉**，而这正是「每次改都变样」
的根因。

---

## 一条铁律：调色板不在任何页面里

调色板由 `src/themes/palettes.json`（10 套开源主题）+ `src/themes/index.js` 生成，
主进程通过 `panel:theme` 下发给**每一个我们自己皮肤化的窗口**。

- 页面的 `:root` 里只放**降级默认值**，因为 `var()` 未定义会让整条声明失效
  （边框会整片消失，不是回退成默认边框）。
- **不要在页面里再抄一份调色板。** 配对窗口曾经这么干过，结果它对主题切换免疫——
  全局换肤时它自己保持深色不动。
- 新窗口必须加进 `themedTargets()`，否则它拿不到主题。

引擎主视图走另一条路：`insertCSS(engineCss(theme))`，且**每条声明必须带 `!important`**
——引擎在 hydrate 之后才写自己的主题表，层叠顺序排在我们后面。

## 色 token（语义，不是具体颜色）

| token | 用途 |
|---|---|
| `--bg` / `--bg-2` / `--bg-3` / `--bg-hover` | 底 / 区块 / 控件 / 悬停 |
| `--text` / `--text-mid` / `--text-dim` | 正文 / 次要 / 元信息 |
| `--border` / `--border-strong` | 分隔 / 控件边 |
| `--accent` | 唯一强调色，只用于主操作与焦点 |
| `--green` / `--yellow` / `--red` | 连上 / 进行中 / 失败，**只用于状态** |

形态 token：`--radius`、`--radius-sm`、`--border-width`、`--shadow-hard`、`--font-scale`。
主题可以改它们（neon-brutal 就是 radius 0 + 2px 边 + 硬投影），所以**不要硬编码圆角和边框宽度**。

## 字体三角色

| 角色 | 变量 | 用在哪 |
|---|---|---|
| display | `--font-ui` 600 / -0.01em | 窗口标题 |
| body | `--font-ui` | 中文正文、说明 |
| data | `--mono` + `tabular-nums` | **一切机器产生的值**：房间号、地址、路径、端口、时间 |
| label | `--mono` 10px / uppercase / .14em | 分区标题 |

层级来自**字族 + 字距 + 尺寸**，不来自再多加一档灰。

**中文必须显式落到 PingFang SC。** 有格调的英文字体基本不含中文字形，中文会静默
fallback，风格当场塌掉。等宽尤其要注意——中文没有真等宽，让拉丁和数字吃等宽、中文落
PingFang 是有意为之：

```css
--mono: "SF Mono", ui-monospace, Menlo, "PingFang SC", monospace;
--font-ui: -apple-system, "SF Pro Text", "PingFang SC", sans-serif;
```

## 间距

基数 **4px**。区块内距 14/16，区块间距 22。紧凑优先——这是 Data-Dense 的部分，
不为好看牺牲一行信息。

## 禁令（本项目自查）

- 不用 `Inter`、`Space Grotesk`
- 不堆**视觉等重的卡片列表**：三个一模一样的圆角卡片＝没有层级。一个界面里同时出现
  「操作」「密钥」「参考信息」时，它们的权重不同，形态就该不同。
- emoji 不作分区标记
- 强调色只出现在主操作和焦点态，状态色只表示状态
- `01/02/03` 编号只在真是序列时用

## 自审

改任何界面后截图看，至少一轮。必查：中文是否真的用上了指定字体、**换到几个反差大的
主题**（midnight / solarized-light / neon-brutal）是否都成立、窄宽是否溢出、对比度。
