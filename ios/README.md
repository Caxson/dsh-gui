# Dsh GUI for iPhone

看 Mac 上的会话、翻历史、发消息。**不能**跑命令、开终端或读文件——这不是一个开关，
是桌面端网关的词表里根本没有这些操作（`src/mobile-gateway.js`）。

View your Mac's sessions, read their history, send a message. It **cannot** run
a command, open a terminal, or read a file — not as a setting, but because
those operations do not exist in the desktop gateway's vocabulary
(`src/mobile-gateway.js`).

## 配对 / Pairing

Mac 上打开菜单里的「手机连接」，开启后扫二维码。二维码里带着配对密钥本身——
中转看不到它，这正是「已配对的手机」能和「只是知道房间号的人」区分开的原因。

On the Mac, open **手机连接** in the app menu, turn it on, and scan the QR code.
The code carries the pairing secret itself, which the relay never sees — that is
exactly what separates a paired phone from anyone who merely learned the room id.

配对链接也可以直接打开（App 注册了 `dsh-gui://` scheme），所以它能从消息里点开，
也能交给模拟器：

A pairing link is also openable — the app registers the `dsh-gui://` scheme — so
it works from a message, and can be handed to a simulator:

```
xcrun simctl openurl booted 'dsh-gui://pair?relay=…&secret=…'
```

## 构建 / Building

```
xcodebuild -project ios/DshGUI.xcodeproj -scheme DshGUI \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

如果报 `iOS <version> is not installed`：这台机器装了模拟器运行时但没装真机平台组件，
scheme 解析会因此拿不到任何可用目标。绕开的办法是直接构建 target：

If it reports `iOS <version> is not installed`: this machine has simulator
runtimes but not the device platform component, which leaves scheme resolution
with no eligible destination. Build the target directly instead:

```
xcodebuild -project ios/DshGUI.xcodeproj -target DshGUI \
  -sdk iphonesimulator -configuration Debug build
```

## 验证 / Verifying

```
npm run verify:ios
```

起一个真中转和一个真桌面端连接器（引擎换成桩），把 App 自己的
`Pairing/RelayClient/Models` 编成命令行程序跑一遍完整对话。

这条协议被实现了两次、用两种语言。两边不一致时**不会报错**——手机只会待在一个
没有别人的房间里，或者把 2026 年的会话显示成 1970 年。所以这个检查跑的是真代码，
不是模拟。

Starts a real relay and a real desktop link (with the engine stubbed), compiles
the app's own `Pairing`/`RelayClient`/`Models` into a command-line program, and
runs a whole conversation through it.

This protocol is implemented twice, in two languages. Where the two disagree,
**nothing errors** — the phone simply sits in a room nobody else is in, or
renders a 2026 conversation as 1970. So the check runs the real code rather
than a mock of it.

## 状态 / Status

模拟器上跑通了：配对、会话列表、历史、发消息。**没有在真机上跑过**，相机扫码那一段
也没有——模拟器没有相机。TestFlight 之前需要在真机上验一遍。

Working on the simulator: pairing, session list, history, sending. It has
**never run on a physical device**, and neither has the camera path — a
simulator has no camera. Both need checking on real hardware before TestFlight.
