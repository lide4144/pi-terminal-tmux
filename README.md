# pi-terminal-tmux

**Interactive TTY programs for pi coding agent, powered by tmux.**

LLM agent 的 bash 工具只能读管道（pipe）字节流。交互式程序（vim、htop、python3 -i、ssh……）需要的是真实 TTY——有屏幕、光标、键盘语义。这个扩展通过 tmux 给 agent 装上「眼睛和手」：

```
terminal_capture = tmux capture-pane  → 看屏幕（截图）
terminal_send    = tmux send-keys     → 按键盘（输入）
terminal_spawn   = tmux split-window  → 启动程序
terminal_list    = 注册表遍历          → 列出会话
terminal_stop    = tmux kill-pane      → 终止
```

## 目录

- [为什么需要它](#为什么需要它)
- [原理：管道 vs TTY](#原理管道-vs-tty)
- [快速开始](#快速开始)
- [安装](#安装)
- [工具参考](#工具参考)
- [使用指南](#使用指南)
  - [交互流程](#交互流程)
  - [按键参考](#按键参考)
  - [什么时候用 terminal\_\* 什么时候用 bash](#什么时候用-terminal_-什么时候用-bash)
- [示例](#示例)
  - [编辑文件](#编辑文件)
  - [Python REPL](#python-repl)
  - [SSH 远程操作](#ssh-远程操作)
- [常见问题](#常见问题)
- [许可证](#许可证)

## 为什么需要它

```
你让 agent "帮我 ssh 到服务器部署一下"
  → agent 用 bash("ssh user@host")
  → ssh: 拒绝在非 TTY 下运行
  → 挂了 ❌

你让 agent "打开 htop 看看系统负载"
  → agent 用 bash("htop")
  → htop: Error: terminal not found
  → 挂了 ❌

你让 agent "帮我在 vim 里打开 config.yml 改一个选项"
  → agent 用 bash("vim config.yml")
  → vim: Warning: Output is not to a terminal
  → 无法交互 ❌
```

这些不是 agent 不够聪明，是 **bash 工具给的管道（pipe）根本就不是交互式程序要的环境**。

这个扩展把 agent 的 bash 工具从「只能读 stdout 字节流」升级成「能看屏幕 + 能按键盘」的完整终端操控能力。

## 原理：管道 vs TTY

### bash 工具（管道模式）

```
agent → bash -c "ls -la"
       → stdout 是 pipe
       → ls 检测到 pipe，去掉颜色和表格线
       → agent 收到纯文本输出
```

管道模式下：
- stdout 是字节流，**没有**屏幕、光标、行编辑
- 程序检测到不是 TTY，行为自动降级（没有颜色、没有交互提示）
- **全屏程序直接拒绝运行**

### terminal\_\* 工具（TTY 模式）

```
agent → terminal_spawn("htop")
       → tmux split-window -d htop
       → htop 认为自己在真实终端里
       → 全屏 TUI 正常显示
       → agent 用 terminal_capture 截图
       → agent 用 terminal_send 按 q 退出
```

TTY 模式下：
- 程序获得一块真实的**虚拟屏幕**（80×24 字符网格）
- 有**光标位置**、**色彩**、**行编辑**
- 全屏 TUI 程序完美运行

### 为什么是 tmux

tmux 已经为每个 pane **维护了一块虚拟屏幕**和**键盘队列**：

```
tmux pane (PID 12345)
┌────────────────────────────────────┐
│ top - 15:23:01 up 3 days           │  ← tmux 内部维护的
│ Tasks: 123 total, 1 running        │     字符网格（屏幕）
│ %Cpu(s): 2.3 us, 1.1 sy           │
│   PID USER      PR  NI    RES    S │
│  1234 root      20   0   123M   R  │
└────────────────────────────────────┘

  capture-pane = 读取这块网格（截图）
  send-keys    = 往键盘队列塞按键
```

用 tmux 而非自己造 PTY 的原因：

| 方案 | 截图语义 | 持久性 | agent 接口 |
|------|---------|--------|-----------|
| **tmux capture-pane** | 屏幕快照 ✅ | pane 持续到被 kill ✅ | send-keys / capture-pane ✅ |
| **node-pty** | 只有累积字节流 ❌ | 进程退出就丢 ❌ | data event / write() ⚠️ |

tmux 的 `capture-pane` 给的是**当前瞬间的屏幕快照**，这在 agent 交互中至关重要——agent 需要知道"现在屏幕上显示什么"，而不是"迄今为止所有输出"。

## 快速开始

```bash
# 1. 启动 tmux
tmux new-session -s pi

# 2. 在 tmux 里启动 pi
pi

# 3. 在 pi 里安装扩展
pi install git:github.com/lide4144/pi-terminal-tmux

# 4. 重启 pi（或 /reload）
# 新的对话中 agent 就能用 terminal_* 工具了
```

## 安装

### 作为 pi package（推荐）

```bash
pi install git:github.com/lide4144/pi-terminal-tmux
```

### 自动发现（单文件）

将 `extensions/index.ts` 复制到：

```
~/.pi/agent/extensions/terminal-tmux.ts
```

## 工具参考

### terminal_spawn

启动一个交互式程序，在 tmux 中创建一个新的 pane。

```
参数:
  command (string, 必填)  要运行的命令
  name?    (string)       显示名（默认取命令前 40 字符）
  width?   (number, 80)   列数
  height?  (number, 24)   行数

返回:
  pane_id  string   pane 的 tmux ID（如 %123）
  command  string   运行的命令
  pid      string   进程 PID
  name     string   显示名
```

### terminal_send

向一个运行的 terminal pane 发送输入。

```
参数:
  pane_id      (string, 必填)  目标 pane ID
  input?       (string)        文本输入
  press_enter? (boolean)       输入后按 Enter？
  key?         (string)        特殊按键

返回:
  pane_id  string   目标 pane ID
  input    string   发送的文本
  key      string   发送的特殊键
  press_enter  boolean  是否按了 Enter

按键参考：
  命名键: Enter, Escape, Tab, Backspace, Space, Up, Down, Left, Right,
          Home, End, PageUp, PageDown, Delete, Insert, F1-F12
  Ctrl:   C-c (中断), C-d (EOF), C-l (清屏), C-z (挂起),
          C-a (行首), C-e (行尾), C-u (删至行首), C-w (删前一词)
  Alt:    M-a 到 M-z
```

### terminal_capture

读取 terminal pane 当前屏幕内容——就像拍一张快照。

```
参数:
  pane_id     (string, 必填)  目标 pane ID
  scrollback? (boolean)       是否包含回滚历史

返回:
  content  string   屏幕内容文本
  lines    number   行数
  size     string   宽×高（如 "80×24"）
```

### terminal_list

列出扩展管理的所有活跃 terminal 会话。

```
参数: 无

返回:
  panes  array   会话列表
    pane_id     string  pane ID
    command     string  启动命令
    name        string  显示名
    created_at  string  创建时间
    running     boolean 是否存活
```

### terminal_stop

终止一个 terminal pane。

```
参数:
  pane_id (string, 必填)  要终止的 pane ID

返回:
  pane_id  string   终止的 pane ID
  command  string   原命令
  stopped  boolean  是否成功终止
```

## 使用指南

### 交互流程

```
每个交互周期三步：

  ① terminal_spawn("程序名")
  ② terminal_send(pane, "输入内容", press_enter=true)
     等待 ~500ms（程序处理输入需要时间）
  ③ terminal_capture(pane)
     看看屏幕上发生了什么变化

  重复 ②→③ 直到完成
  ⑤ terminal_stop(pane)
```

### 什么时候用 terminal\_\* 什么时候用 bash

| 你要做的事 | 用什么 |
|-----------|--------|
| `ls`, `grep`, `cat`, `git log` | **bash** |
| `npm install`, `mkdir`, `cp`, `mv` | **bash** |
| `curl`, `wget` | **bash** |
| `node script.js`, `python script.py`（非交互） | **bash** |
| **vim**, **nano**, **helix** | **terminal_spawn** |
| **htop**, **top**, **btop** | **terminal_spawn** |
| **python3 -i**（交互式 REPL） | **terminal_spawn** |
| **ssh user@host** | **terminal_spawn** |
| **psql**, **mysql**, **sqlite3** | **terminal_spawn** |
| **lazygit**, **tig**, **gitui** | **terminal_spawn** |
| **fzf** | **terminal_spawn** |
| **less 'bigfile.log'**（要翻页） | **terminal_spawn** |
| **kubectl exec -it pod -- bash** | **terminal_spawn** |
| `sed -i 's/foo/bar/' file` | **bash**（一行搞定） |
| `read()` / `edit()` / `write()` | pi 文件工具（优先于 terminal） |

**核心判断**：这个程序需不需要「屏幕 + 键盘」交互？

- 不需要 → **bash**
- 需要 → **terminal\_\***

## 示例

### 编辑文件

```
Step  Agent 动作                             解释
────  ─────────────────────────────────────  ────────────────────
  1   terminal_spawn("vim main.go")          启动 vim 打开文件
  2   terminal_capture(%123)                看 vim 界面
  3   terminal_send(%123, "/func main")      搜索 "func main"
  4   terminal_send(%123, key="Enter")       确认搜索
  5   terminal_capture(%123)                看搜索结果：光标在 func main() 行
  6   terminal_send(%123, "O")              当前行上方插入空行
  7   terminal_send(%123, "log.Println(\"start\")")  输入新代码
  8   terminal_send(%123, key="Escape")      退出插入模式
  9   terminal_send(%123, ":wq")             保存退出
 10   terminal_send(%123, key="Enter")
 11   terminal_capture(%123)                确认回到 shell
```

### Python REPL

```
Step  Agent 动作
────  ──────────────────────────────
  1   terminal_spawn("python3 -i")
  2   terminal_capture(%124)       看到 Python banner + >>>
  3   terminal_send(%124, "import os")
  4   terminal_send(%124, key="Enter")
  5   terminal_capture(%124)       看到 >>>
  6   terminal_send(%124, "os.listdir('.')")
  7   terminal_send(%124, key="Enter")
  8   terminal_capture(%124)       看到文件列表
  9   terminal_send(%124, key="C-d") 退出 Python
```

### SSH 远程操作

```
Step  Agent 动作
────  ──────────────────────────────
  1   terminal_spawn("ssh root@server")
  2   terminal_capture(%125)       看到 SSH 主机密钥确认
  3   terminal_send(%125, "yes")   确认连接
  4   terminal_send(%125, key="Enter")
  5   wait + capture               看到输入密码提示
  6   terminal_send(%125, "********")  输入密码
  7   terminal_send(%125, key="Enter")
  8   wait + capture               看到服务器 Shell 提示符
  9   terminal_send(%125, "systemctl status nginx")
 10   terminal_send(%125, key="Enter")
 11   terminal_capture(%125)       看到 Nginx 状态
 12   terminal_send(%125, "exit")  退出 SSH
 13   terminal_send(%125, key="Enter")
```

## 常见问题

### 为什么必须在 tmux 里？

tmux 的 `capture-pane` 和 `send-keys` 通过 `$TMUX` 环境变量找到当前 tmux 会话。没有 `$TMUX`，这些命令就不知道对谁操作。

### 为什么不用 node-pty 直接造一个 PTY？

node-pty 可以创建一个伪终端，但它缺少**截图语义**——你只能从累积的字节流里猜当前画面。tmux 的 `capture-pane` 给你的是**当前瞬间的屏幕快照**，这对 agent 来说更自然（就像人看一眼屏幕）。

### 多个 pane 会不会弄乱 tmux 布局？

每个 `terminal_spawn` 用 `split-window -d` 在**当前窗口**创建一个新 pane，但不抢焦点。如果 pane 太多了，你可以用 `tmux select-layout tiled` 整理布局。

### 程序已经退出了怎么办？

`terminal_capture` 会检测 pane 是否存活。如果程序已退出，它会返回错误信息。用 `terminal_list` 查看哪些 pane 还活着。

### 跨对话持久性

tmux pane 在 pi 重启后仍然存活。如果 agent 在一个对话里启动了 vim，然后在另一个对话里用 `terminal_list` 能看到它还在——但 pane ID 需要记录下来才能继续交互。

### 特殊按键如何工作

`terminal_send` 的 `key` 参数直接传给 `tmux send-keys`。`C-c` 表示 Ctrl+C，`C-d` 表示 Ctrl+D，`Enter` 表示回车，以此类推。不支持的自定义按键可以先用 `terminal_send` 发 `input` 再组合。

## 许可证

MIT
