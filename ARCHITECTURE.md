# Architecture

pi-terminal-tmux 的架构设计文档。

## 系统概览

```
┌─────────────────────────────────────────────────────────────┐
│  pi coding agent (LLM)                                      │
│                                                             │
│  ┌─────────────┐  ┌──────────┐  ┌──────────────┐           │
│  │ bash tool   │  │ read/    │  │ terminal_*   │           │
│  │ (pipe)      │  │ write/   │  │ (tmux TTY)   │           │
│  │             │  │ edit     │  │              │           │
│  │ ls, grep,   │  │ 文件操作  │  │ spawn/send/  │           │
│  │ curl, npm   │  │          │  │ capture/stop │           │
│  └──────┬──────┘  └──────────┘  └──────┬───────┘           │
│         │                              │                    │
└─────────┼──────────────────────────────┼────────────────────┘
          │                              │
          ▼                              ▼
   spawn("bash -c ...")           spawn("tmux send-keys ...")
   stdout → pipe                  spawn("tmux capture-pane -p")
                                   stdout → screen snapshot
          │                              │
          ▼                              ▼
   ┌──────────────┐            ┌──────────────────┐
   │ 普通 shell   │            │ tmux pane (TTY)  │
   │ (无 TTY)     │            │ 虚拟屏幕 80×24    │
   │ 字节流       │            │ 光标 + 键盘队列    │
   └──────────────┘            └──────────────────┘
```

## 核心架构

### 扩展加载流程

```
pi 启动
  │
  ├─ 扫描 ~/.pi/agent/extensions/*.ts
  │     ↓
  │  发现 terminal-tmux.ts
  │     ↓
  │  jiti 加载 TypeScript
  │     ↓
  │  执行 default export function(pi: ExtensionAPI)
  │     ↓
  │  pi.registerTool() × 5  ← 注册工具
  │     ↓
  │  pi.on("session_start")  ← 设置状态栏 🐚 TTY
  │     ↓
  │  pi.on("before_agent_start")  ← 注入 tmux 环境提示
  │
  └─ LLM 工具列表包含 5 个 terminal_* 工具
```

### 模块结构

```
extensions/index.ts
│
├── 常量和类型
│   ├── PaneMeta          pane 元数据接口
│   ├── TmuxResult        tmux 命令结果类型
│   └── VALID_KEYS        特殊按键映射表
│
├── tmux 命令封装层
│   ├── tmux(args)        通用 tmux 调用（spawnSync）
│   ├── assertInTmux()    检查 $TMUX 环境变量
│   ├── paneIsAlive()     检查 pane 是否存活
│   ├── getPaneCommand()  获取 pane 当前运行命令
│   ├── resizePane()      调整 pane 大小
│   └── setPaneTitle()    设置 pane 标题
│
├── 注册表
│   └── panes: Map<PaneID, PaneMeta>  跟踪扩展创建的所有 pane
│
├── 工具注册（×5）
│   ├── terminal_spawn    tmux split-window
│   ├── terminal_send     tmux send-keys
│   ├── terminal_capture  tmux capture-pane
│   ├── terminal_list     遍历注册表
│   └── terminal_stop     tmux kill-pane
│
└── 事件处理
    ├── session_shutdown  清理所有 pane
    ├── session_start     状态栏 + 通知
    └── before_agent_start 注入环境提示词
```

### 数据流

#### terminal_spawn

```
agent 调用 terminal_spawn("vim main.go")
  │
  ├─ 1. assertInTmux() → 检查 $TMUX
  │
  ├─ 2. tmux(["split-window", "-d", "-P",
  │           "-F", "#{pane_id}\t#{pane_pid}",
  │           "-l", "24",
  │           "bash", "-c", "vim main.go"])
  │     │
  │     ├─ tmux 创建新 pane，运行 bash -c "vim main.go"
  │     ├─ vim 在真实 TTY 中启动，显示全屏界面
  │     └─ 返回 pane_id（如 %123）和 PID
  │
  ├─ 3. setPaneTitle(%123, "🐚 vim main.go")
  │
  ├─ 4. panes.set(%123, { command, name, createdAt })
  │
  └─ 5. 返回 { pane_id: "%123", command: "vim main.go", ... }
```

#### terminal_send

```
agent 调用 terminal_send(%123, input="/func", press_enter=true)
  │
  ├─ 1. 验证 key 是否合法（如果在 VALID_KEYS 中）
  │
  ├─ 2. input 按 \n 分割，每段逐段发送
  │     for each segment:
  │       tmux(["send-keys", "-t", %123, "-l", segment])
  │       if not last: tmux(["send-keys", "-t", %123, "Enter"])
  │
  ├─ 3. 如果指定了 key：
  │     tmux(["send-keys", "-t", %123, key])
  │
  ├─ 4. 如果 press_enter：
  │     tmux(["send-keys", "-t", %123, "Enter"])
  │
  └─ 5. 返回 { sent: "...", ... }
```

注意：文字用 `-l`（literal）发送以避免被误解释为按键名，特殊按键用独立的 tmux 调用。

#### terminal_capture

```
agent 调用 terminal_capture(%123, scrollback=false)
  │
  ├─ 1. paneIsAlive(%123) → 检查 pane 存活
  │
  ├─ 2. tmux(["capture-pane", "-t", %123, "-p"])
  │     │
  │     ├─ -p: 输出到 stdout（纯文本，无 ANSI 转义）
  │     ├─ -S -: 如果在 scrollback 模式下包含全部历史
  │     └─ 返回当前屏幕内容
  │
  ├─ 3. 获取 pane 大小信息
  │     tmux(["display-message", "-p", "-t", %123,
  │           "#{pane_width}x#{pane_height}"])
  │
  └─ 4. 返回 { content: "...", lines: 24, size: "80×24", ... }
```

### 生命周期管理

```
        创建                    交互                     终止
    terminal_spawn         terminal_send +          terminal_stop
                          terminal_capture
    ┌──────────┐          ┌──────────────┐          ┌──────────┐
    │ pane 创建 │          │   交互循环    │          │ pane 关闭 │
    │          │          │              │          │          │
    │ split    │─ ─ ─ ─ ▶ │ send input   │─ ─ ─ ─ ▶ │ kill     │
    │ -window  │          │    ↓ 等待     │          │ -pane    │
    │ setTitle │          │ capture      │          │          │
    │ resize   │          │    ↓ 分析     │          │ 移除     │
    │ registry │          │ send next... │          │ registry │
    └──────────┘          └──────────────┘          └──────────┘

    session_shutdown（pi 退出时）
          │
          ├─ 遍历 panes 注册表
          └─ 对每个 pane 执行 kill-pane
```

### 按键映射

tmux `send-keys` 支持以下按键类别，扩展完整透传：

| 类别 | 示例 | 说明 |
|------|------|------|
| 命名键 | `Enter`, `Escape`, `Tab`, `Space`, `Backspace` | 常见控制键 |
| 光标 | `Up`, `Down`, `Left`, `Right` | 方向键 |
| 导航 | `Home`, `End`, `PageUp`, `PageDown` | 翻页/跳转 |
| 编辑 | `Delete`, `Insert` | 编辑键 |
| 功能键 | `F1`–`F12` | 功能键 |
| Ctrl 组合 | `C-c`, `C-d`, `C-l`, `C-z`, `C-a`…`C-z` | 控制字符 |
| Meta 组合 | `M-a`…`M-z` | Alt 组合键 |

### System Prompt 注入

`before_agent_start` 事件在每次 LLM 请求前触发，向 system prompt 追加环境块：

```
── TMUX TERMINAL ENVIRONMENT ──
You are running inside tmux. You have REAL TERMINAL access.

KEY RULE:
  bash  = for non-interactive commands
  terminal_* = for interactive TTY programs

WORKFLOW: spawn → send → capture → analyze → repeat
```

这确保即使在新对话中，LLM 也知道自己的终端环境和工具选择策略。

## 关键设计决策

### 为什么 spawnSync 而非 spawn/exec

tmux 命令（`send-keys`, `capture-pane`, `split-window`）都是**快速操作**（<100ms），不需要流式处理。`spawnSync` 更简单，错误处理更直接。

例外：`maxBuffer: 10MB` 用于应对大尺寸 capture-pane 输出。

### 为什么在当前窗口 split-window 而非专用窗口

在当前窗口创建 pane 让用户**可见** agent 在做什么。如果 pane 太多，用户可以用 `select-layout tiled` 整理。

不创建专用窗口的原因是保持简单——每个 `terminal_spawn` 只是创建一个新 pane，用户可以根据需要手动整理。

### 为什么用 Type.Object({}) 而非自定义 schema

所有工具参数都用 `TypeBox` 定义，与 pi 的扩展 API 保持一致。`Type.Object({})` 用于无参数工具如 `terminal_list`。

## 扩展点

- **窗口管理**：添加 `window` 参数让 agent 指定 pane 创建到哪个窗口/会话
- **文件传输**：在 capture 输出中加入 BASE64 编码的文件传输能力
- **大小自适应**：自动调整 pane 大小匹配程序需求
- **会话恢复**：保存 pane 状态，跨 pi 重启恢复
