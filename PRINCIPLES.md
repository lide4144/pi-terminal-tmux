# 设计原则

pi-terminal-tmux 的设计原则和哲学。

## 核心矛盾

LLM agent 操作终端时面临一个根本矛盾：

```
agent 只有管道（pipe）  ←→  交互式程序需要终端（TTY）

管道给的是字节流         TTY 给的是屏幕 + 键盘
stdout 是累加的          屏幕是快照的
没有光标/行编辑          有完整 TUI 语义
```

这个矛盾不是 agent 的能力问题，是**工具抽象层**的问题。pi-terminal-tmux 解决的就是这个抽象层。

## 原则

### 1. 截图语义优先于字节流

```
agent 问："htop 现在显示什么？"
  字节流回答："这些是迄今为止 htop 输出的所有字符…（长到离谱）"
  截图回答："当前屏幕上显示这些内容（刚好一屏）"

哪个对 agent 更有用？
```

agent 需要的不是「所有历史输出」，而是**当前屏幕上有什么**。就像人处理终端交互一样——你看一眼屏幕，知道当前状态，然后决定下一步做什么。

这就是 `terminal_capture` 用 `tmux capture-pane` 而非 `pty.onData()` 的原因。后者给你堆积的字节流，前者给你**此刻的快照**。

### 2. 所见即所得（WYSIWYG）

```
agent 在 tmux pane 里看到的 = 用户在 tmux 窗口里看到的
```

agent 创建的每个 pane 都**真实可见**。用户切换到 tmux 窗口就能看到 agent 在做什么。没有隐藏状态，没有暗中操作。

这带来三个好处：
- **调试透明**：用户能看到 agent 敲了什么、程序回了什么
- **人工介入**：用户可以在 agent 的 pane 里直接操作
- **信任建立**：黑盒操作 → 白盒观察

### 3. 最小侵入

```
扩展只做五件事：
  spawn   ← tmux 本来就有的能力
  send    ← tmux 本来就有的能力
  capture ← tmux 本来就有的能力
  list    ← 注册表遍历
  stop    ← tmux 本来就有的能力
```

不引入新的协议、不修改 tmux 行为、不劫持现有工具。扩展只是把 tmux 的现有能力暴露给 LLM，用 agent 能理解的方式（工具 + 描述 + 环境提示）包装起来。

### 4. 用描述驱动行为，而非硬编码

```
❌ 硬编码："如果命令包含 vim/htop/python3，强制用 terminal_spawn"
✅ 描述："terminal_spawn 用于交互式 TTY 程序，bash 用于非交互命令"

让 LLM 自己判断——它比你更懂上下文。
```

扩展不硬编码哪些命令走 `terminal_*`、哪些走 `bash`。而是通过：
- **工具描述**（`description`）
- **工具提示**（`promptSnippet`）
- **指南**（`promptGuidelines`）
- **环境注入**（`before_agent_start`）

让 LLM **理解**背后的原则，自己做出正确选择。

### 5. 失败可恢复

```
pane 死了 → terminal_capture 告诉你它死了
          → terminal_list 显示哪些还活着
          → terminal_spawn 重新启动
```

每个工具都检查 pane 存活状态。如果 pane 已死：
- `terminal_send` 返回明确错误
- `terminal_capture` 返回 pane_dead
- `terminal_list` 标记死掉的 pane
- `terminal_stop` 安全清理注册表

### 6. tmux 是基础设施，而非依赖

扩展依赖 tmux，但不要求用户学习 tmux。用户只需要知道：

```bash
tmux new-session -s pi   # 启动
pi                         # 用 pi
Ctrl+B d                   # 离开
tmux attach -t pi          # 回来
```

tmux 的复杂性（窗口、会话、布局管理）对用户透明。扩展只用 tmux 的两个命令：`send-keys` 和 `capture-pane`。

### 7. 按键即 API

```
terminal_send(pane_id, input="hello", press_enter=true)
  → tmux send-keys -t pane_id -l "hello"
  → tmux send-keys -t pane_id "Enter"
```

扩展不抽象按键——`tmux send-keys` 的按键模型直接暴露给 LLM。`C-c` 就是 Ctrl+C，`Enter` 就是回车。LMM 需要理解终端按键模型（就像它需要理解文件路径一样），而不是通过一个更高层的抽象。

## 对比其他方案

### tmux 方案（本扩展）

```
优势：
  ✅ 截图语义——当前屏幕快照
  ✅ 持久 pane——跨对话存活
  ✅ tmux 命令成熟稳定
  ✅ pane 可见——用户能看到 agent 在做什么

代价：
  ⚠️ 需要 tmux
  ⚠️ 需要 $TMUX 环境变量
  ⚠️ pane 会占用窗口空间
```

### node-pty 方案

```
node-pty 直接创建一个 PTY：

  const pty = spawn("vim", [], { cols: 80, rows: 24 });
  pty.write(":q!\r");
  pty.on("data", (data) => { buffer += data; });

问题：
  ❌ 没有"截图"语义——buffer 是累积字节流
  ❌ 没有持久性——进程退出就丢
  ❌ agent 需要自己从字节流中"猜"屏幕内容

但可以配合 ANSI 解析器（如 xterm.js）来渲染屏幕，
然而这对 agent 来说太重了（完整终端模拟器）。
```

### expect/pexpect 方案

```
expect 也是一种 PTY 自动化方案：

  spawn("ftp")
  expect("Name:")
  send("anonymous\r")
  expect("Password:")
  send("guest\r")

但 expect 的模式匹配是针对"最近的输出"而非"当前屏幕"。
对要求精确知道屏幕状态的交互来说不够用。
```

### 为什么不纯用 bash + pipe

```
❌ htop 拒绝运行
❌ vim 报 "Output is not to a terminal"
❌ ssh "stdin is not a terminal"
❌ python3 -i 交互式输出/输入混在一起
❌ psql "WARNING: psql is running in non-interactive mode"
❌ fzf 什么都不显示
```

管道在碰到第一个交互式程序时就彻底不够用了。

## 总结

```
设计原则                 对应的实现
──────────────────────────────────────────────────
截图语义优先              terminal_capture → capture-pane
所见即所得                split-window 在用户窗口中创建 pane
最小侵入                  只包装 tmux 现有命令
描述驱动行为              promptSnippet + promptGuidelines + before_agent_start
失败可恢复                每个工具检查 pane 存活
tmux 是基础设施           用户只 tmux new-session + pi
按键即 API                send-keys 按键名直接暴露
```
