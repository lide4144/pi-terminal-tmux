# pi-terminal-tmux

**Interactive TTY programs for pi coding agent, powered by tmux.**

Stop fighting with `bash` tool limitations — `terminal_spawn`, `terminal_send`, and `terminal_capture` give the LLM real terminal access: screen, cursor, keystrokes, full TTY semantics.

## How it works

Instead of pipes (which lose all TTY context), this extension uses **tmux virtual terminals**:

```
terminal_spawn   → tmux split-window     — create a pane
terminal_send    → tmux send-keys        — type keystrokes / special keys
terminal_capture → tmux capture-pane -p  — "screenshot" the screen
terminal_list    → tmux list-panes       — show active sessions
terminal_stop    → tmux kill-pane        — terminate
```

## Requirements

- **tmux 3.x+** installed and available in `$PATH`
- pi must be running **inside a tmux session** (`$TMUX` must be set)

```bash
tmux new-session -s pi
pi
```

## Install

```bash
pi install git:github.com/YOUR_USERNAME/pi-terminal-tmux
```

Or auto-discover by placing the file in:

```
~/.pi/agent/extensions/terminal-tmux.ts
```

## Usage

Once loaded, pi adds 5 tools the LLM can call:

| Tool | What it does |
|------|-------------|
| `terminal_spawn` | Start an interactive program (vim, htop, python3, ssh, etc.) |
| `terminal_send` | Type input, press Enter, send Ctrl+C / Escape / Tab... |
| `terminal_capture` | Read the current screen content ("screenshot") |
| `terminal_list` | List active terminal sessions |
| `terminal_stop` | Kill a terminal pane |

### Example: edit a file in vim

```
1. terminal_spawn("vim main.go")     → starts vim in a tmux pane
2. terminal_capture(pane_id)         → see the vim screen
3. terminal_send(pane_id, "/func")   → search for "func"
4. terminal_send(pane_id, key="Enter")
5. terminal_capture(pane_id)         → see search result
6. terminal_send(pane_id, ":wq", press_enter=true)  → save and quit
7. terminal_capture(pane_id)         → verify shell prompt is back
```

### When to use terminal_* vs bash

| Task | Tool |
|------|------|
| `ls`, `grep`, `cat`, `git log` | `bash` |
| `npm install`, `mkdir`, `cp` | `bash` |
| `vim`, `htop`, `lazygit` | `terminal_spawn` |
| `python3 -i`, `psql`, `ssh` | `terminal_spawn` |
| `fzf`, `less`, `nano` | `terminal_spawn` |

## License

MIT
