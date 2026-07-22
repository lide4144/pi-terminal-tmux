---
name: terminal-tmux
description: Interactive TTY terminal management via tmux — terminal_spawn, terminal_send, terminal_capture, terminal_list, terminal_stop. Use when the user wants to run interactive programs (vim, htop, python3 -i, ssh, psql, lazygit, nano, less, fzf, REPLs, database CLIs, kubectl exec -it, etc.) or when bash pipe mode can't satisfy the need for a real TTY.
---

# Terminal Tmux — Interactive TTY Programs

pi-terminal-tmux 扩展提供 5 个 `terminal_*` 工具，让你通过 tmux 在**真实 TTY** 中运行交互式程序。

## 核心概念：管道 vs TTY

| | bash 工具 | terminal_* 工具 |
|---|---|---|
| 本质 | 管道（pipe）字节流 | tmux 虚拟终端（TTY） |
| 屏幕 | 无，只有 stdout 累积输出 | 80×24 字符网格，有光标 |
| 颜色/TUI | 程序检测到非 TTY → 降级/拒绝 | 完整 TUI 支持 |
| 适用 | ls, grep, cat, git, npm, curl | vim, htop, python, ssh, psql |

**核心判断**：这个程序需不需要「屏幕 + 键盘」交互？
- 不需要 → **bash**
- 需要 → **terminal_\***

## 工具一览

| 工具 | 作用 | tmux 对应 |
|------|------|-----------|
| `terminal_spawn` | 启动交互式程序，创建新 pane | `split-window -d` |
| `terminal_send` | 发送按键/文本到 pane | `send-keys` |
| `terminal_capture` | "截图"——读取 pane 当前屏幕 | `capture-pane -p` |
| `terminal_list` | 列出所有活跃 terminal 会话 | 注册表遍历 |
| `terminal_stop` | 终止一个 terminal pane | `kill-pane` |

## 交互流程

每个交互周期遵循三步循环：

```
① terminal_spawn("程序名")
    → 创建 pane，程序在 TTY 中启动

② terminal_send(pane, input, press_enter?) / key?
    等待 ~500ms（程序处理输入需要时间）

③ terminal_capture(pane)
    → 看看屏幕上发生了什么变化

   重复 ②⇄③ 直到完成

⑤ terminal_stop(pane)
```

**始终在每次 send 后 capture**——你不 capture 就不知道程序的状态。

### 为什么不能在 send 后直接继续？

交互式程序的输出不是即时的。vim 可能在处理命令、ssh 可能在等待网络、htop 的排序需要时间。capture 给你的是**此刻的快照**，让你看清楚结果再决定下一步。

## 何时用 terminal_\*

### 必须用 terminal_spawn 的程序

| 类别 | 程序 | 原因 |
|------|------|------|
| 编辑器 | vim, nano, helix, micro, emacs -nw | 全屏 TUI，拒绝 pipe |
| 系统监控 | htop, top, btop, iotop, nethogs | 全屏刷新，需要 TTY |
| 交互式 REPL | python3 -i, node -i, irb, iex, ghci | 交互式提示符 |
| 远程连接 | ssh, telnet, mosh | 需要 TTY 分配 |
| 数据库 | psql, mysql, sqlite3, mongosh, redis-cli | 交互式查询 |
| Git 工具 | lazygit, tig, gitui, git interactive rebase | 全屏 TUI |
| 文件浏览 | less, more, most, fzf, ranger, lf | 翻页/搜索 |
| 容器 | kubectl exec -it, docker exec -it, docker attach | 需要 TTY |
| 调试器 | gdb, lldb, pdb, ipdb | 交互式调试 |
| 配置工具 | raspi-config, hwconfig, nmtui, dpkg-reconfigure | TUI 界面 |

### 用 bash 就够了的情况

```
ls, grep, cat, find, rg  → bash
git log, git diff, git status  → bash
npm install, pip install  → bash
mkdir, cp, mv, rm         → bash
sed -i 's/foo/bar/' file → bash（一行搞定）
read / edit / write       → pi 文件工具（优先于 terminal）
```

## 按键参考

### 命名键

`terminal_send(pane, key="Enter")` 的形式：

| 键名 | 说明 |
|------|------|
| `Enter`, `Return` | 回车 |
| `Escape`, `Esc` | 退出/Escape |
| `Tab`, `BTab` | Tab / Shift+Tab |
| `Space` | 空格 |
| `Backspace`, `Bspace` | 退格 |

### 光标/导航

| 键名 | 说明 |
|------|------|
| `Up`, `Down`, `Left`, `Right` | 方向键 |
| `Home`, `End` | 行首/行尾 |
| `PageUp`, `PageDown`, `PgUp`, `PgDn` | 翻页 |

### Ctrl 组合

`C-c`, `C-d`, `C-l` 等格式：

| 键 | 说明 | 常用场景 |
|----|------|---------|
| `C-c` | 中断（SIGINT） | 终止当前程序 |
| `C-d` | EOF | 退出 shell / Python |
| `C-l` | 清屏 | 刷新屏幕 |
| `C-z` | 挂起（SIGTSTP） | 暂停程序 |
| `C-a` | 行首 | shell 行编辑 |
| `C-e` | 行尾 | shell 行编辑 |
| `C-u` | 删至行首 | shell 行编辑 |
| `C-w` | 删前一词 | shell 行编辑 |
| `C-r` | 反向搜索历史 | shell 历史搜索 |

### Meta/Alt 组合

`M-a` 到 `M-z` 格式。例如 `M-x` = Alt+X（Emacs 中常用）。

## 交互示例

### Vim 编辑文件

```
Step  动作                                        解释
────  ─────────────────────────────────────────  ─────────────────────
  1   terminal_spawn("vim main.go")              启动 vim
  2   terminal_capture(%123)                     看到 vim 界面
  3   terminal_send(%123, "/func main")          搜索 "func main"
  4   terminal_send(%123, key="Enter")           确认搜索
  5   terminal_capture(%123)                     光标在 func main() 行
  6   terminal_send(%123, "O")                   上方插入空行
  7   terminal_send(%123, '  log.Println("start")')  输入新代码
  8   terminal_send(%123, key="Escape")          退出插入模式
  9   terminal_send(%123, ":wq")                 保存退出
 10   terminal_send(%123, key="Enter")
 11   terminal_capture(%123)                     确认回到 shell
```

**Vim 注意**：
- 按完 `:` 后 vim 进入命令行模式，输入会显示在底部
- `:wq` 后必须按 Enter 才执行
- 如果 vim 打开了多个文件，`:n` 到下一个，`:prev` 到上一个

### Python REPL

```
Step  动作
────  ───────────────────────────────────
  1   terminal_spawn("python3")
  2   terminal_capture(%124)    看到 Python banner + >>>
  3   terminal_send(%124, "import os")
  4   terminal_send(%124, key="Enter")
  5   terminal_capture(%124)    看到 >>>
  6   terminal_send(%124, "os.listdir('.')")
  7   terminal_send(%124, key="Enter")
  8   terminal_capture(%124)    看到文件列表
  9   terminal_send(%124, key="C-d")  退出 Python
```

**Python REPL 注意**：
- 等待 `>>>` 提示符出现再输入下一行
- 多行语句（def/for/if）会自动缩进，等待 `...` 提示符出现后再继续
- 用 `C-d` 或 `exit()` 退出

### SSH 远程

```
Step  动作
────  ───────────────────────────────────
  1   terminal_spawn("ssh user@server")
  2   terminal_capture(%125)    看到主机密钥确认
  3   terminal_send(%125, "yes")
  4   terminal_send(%125, key="Enter")
  5   terminal_capture(%125)    看到密码提示
  6   terminal_send(%125, "********")
  7   terminal_send(%125, key="Enter")
  8   terminal_capture(%125)    看到服务器 shell 提示符
  9   terminal_send(%125, "systemctl status nginx")
 10   terminal_send(%125, key="Enter")
 11   terminal_capture(%125)    看到 Nginx 状态
 12   terminal_send(%125, "exit")
 13   terminal_send(%125, key="Enter")
```

**SSH 注意**：
- 第一次连接会询问主机密钥，输入 `yes` 确认
- 密码输入时 capture 看不到密码字符（不回显），但可以看到 `password:` 提示
- 连接建立后注意 shell 提示符（`$`, `#`, `user@host:~$`）来判断状态
- 如果密钥认证失败需要密码，不要直接发送密码——先询问用户

### htop 系统监控

```
Step  动作
────  ───────────────────────────────────
  1   terminal_spawn("htop")
  2   terminal_capture(%126)    看到 htop 界面
  3   terminal_send(%126, key="F6")    排序菜单
  4   terminal_capture(%126)    看到排序选项
  5   terminal_send(%126, key="Down")  选择排序条件
  6   terminal_send(%126, key="Enter") 确认排序
  7   terminal_capture(%126)    看到排序后的结果
  8   terminal_send(%126, key="q")     退出 htop
```

**htop 注意**：
- htop 全屏刷新，capture 得到的是瞬间截图
- 按 `q` 退出，按 `F10` 也退出
- `F1` 帮助，`F5` 树形视图，`F6` 排序，`F9` 杀进程

### less 翻页浏览

```
Step  动作
────  ───────────────────────────────────
  1   terminal_spawn("less bigfile.log")
  2   terminal_capture(%127)    看到文件前几行
  3   terminal_send(%127, key="Down")    向下翻一行
  4   terminal_send(%127, key="PageDown")  向下翻一页
  5   terminal_send(%127, "/ERROR")      搜索 "ERROR"
  6   terminal_send(%127, key="Enter")
  7   terminal_capture(%127)    看到搜索结果
  8   terminal_send(%127, "n")           下一个匹配
  9   terminal_send(%127, key="q")       退出 less
```

**less 注意**：
- `/` 搜索，`n` 下一个，`N` 上一个
- `g` 到文件头，`G` 到文件尾
- `q` 退出
- `-N` 启动时显示行号：`less -N file.log`

### fzf 模糊搜索

```
Step  动作
────  ───────────────────────────────────
  1   terminal_spawn("find . -type f | fzf")
  2   terminal_capture(%128)    看到 fzf 界面
  3   terminal_send(%128, "main.go")   输入搜索词
  4   terminal_capture(%128)    看到过滤结果
  5   terminal_send(%128, key="Enter") 选择当前选中项
```

**fzf 注意**：
- fzf 在终端底部显示搜索框，上方是匹配列表
- 输入即过滤，键盘上下选择
- Enter 确认选择，C-c/C-d 取消
- 如果 fzf 没输出结果到 stdout，capture 可以看到界面但 agent 拿不到选中项——`terminal_spawn` 启动的 fzf 结果需要通过 capture 屏幕内容获取

## 进阶技巧

### 等待程序处理

terminal_send 后**不要立即 capture**——程序需要时间处理输入。建议的大致等待时间：

| 场景 | 建议等待 |
|------|---------|
| shell 命令执行 | 300-500ms |
| vim 命令 | 300-500ms |
| SSH 连接建立 | 1-3s |
| 大型文件搜索 | 1-5s |
| 网络操作 | 2-10s |

如果 capture 发现结果还没出现，可以再次 capture（程序运行期间持续 capture 是安全的）。

### 处理程序卡住

如果程序没有响应你的输入：

1. **先 capture**——看看屏幕上有什么，可能程序在等待其他东西
2. **尝试 C-c**——用 `terminal_send(pane, key="C-c")` 发送中断
3. **检查 pane 存活**——用 `terminal_list` 看 pane 是否还活着
4. **重新 spawn**——如果程序死了，用 `terminal_stop` 清理，重新 spawn

### 跨对话持久性

tmux pane 在 pi 重启后仍然存活。如果你在一个对话里启动了 vim，在另一个对话里 `terminal_list` 能看到它还在——但 pane ID 需要记录下来才能继续交互。

建议在每个对话开始时用 `terminal_list` 检查是否有遗留在跑的 pane。

### 多 pane 管理

你可能同时有多个 terminal pane 在运行（比如一个 vim + 一个 htop）。`terminal_list` 会列出所有活跃的 pane。

如果 tmux 窗口里 pane 太多，建议定期 `terminal_stop` 不再需要的 pane，或者在 tmux 里按 `Ctrl+B` 然后 `Ctrl+方向键` 调整 pane 布局。

### 避免输出的误判

`terminal_capture` 返回的是纯文本（无 ANSI 转义）。这意味着：
- 颜色信息丢失——不要期望看到彩色输出
- 某些 TUI 元素的边框/线条可能用 ASCII 字符绘制（如 `─`, `│`, `┌` 等）
- 光标位置不可见——你只能看到静态内容

### 从 terminal 获取文件内容

如果需要在交互式程序中查看文件内容，优先用 `read()` 工具而不是 `terminal_spawn + less`。但以下情况 terminal 更合适：
- 文件太大 read() 放不下，需要 `less` 翻页
- 需要在 vim 中编辑后实时看到修改效果
- 文件在远程服务器上，需要通过 ssh 查看

## 错误处理

| 症状 | 原因 | 修复 |
|------|------|------|
| `tmux session required` | pi 不在 tmux 中运行 | `tmux new-session -s pi` 后重启 pi |
| `pane no longer exists` | 程序已退出 | `terminal_list` 检查后重新 spawn |
| `Invalid key` | 按键名写错 | 参考按键参考部分 |
| `Failed to send to terminal` | pane 已死 | `terminal_stop` 清理，重新 spawn |
| capture 显示空白 | 程序还没输出 | 等一会儿再 capture |
| 输入没反应 | 程序在处理其他东西 | C-c 中断，capture 看状态 |

## 设计哲学

- **截图语义**：capture 给你当前屏幕快照，不是累积字节流——这对 agent 理解状态至关重要
- **所见即所得**：你在 tmux 窗口里看到的 = agent 在 pane 里操作的，完全透明
- **最小侵入**：只包装 tmux 的 `send-keys`, `capture-pane`, `split-window`, `kill-pane` 四个命令
- **描述驱动**：不硬编码什么程序走 terminal，让 LLM 根据工具描述和上下文自己判断
- **失败可恢复**：每个工具都检查 pane 存活，死掉的 pane 安全清理

## 安装

将本 skill 安装到 pi 的 skills 目录：

```bash
# 方式 1：直接链接
ln -sf /path/to/pi-terminal-tmux/skills/terminal-tmux ~/.pi/agent/skills/terminal-tmux

# 方式 2：复制
cp -r skills/terminal-tmux ~/.pi/agent/skills/terminal-tmux
```

确保 `pi-terminal-tmux` 扩展已安装：

```bash
pi install git:github.com/lide4144/pi-terminal-tmux
```
