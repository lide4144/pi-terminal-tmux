/**
 * Terminal Tmux Extension
 *
 * Lets the agent interact with interactive TTY programs (vim, htop, ssh, python,
 * database CLIs, lazygit, etc.) by managing tmux panes.
 *
 * Instead of reading byte streams through pipes (which lose screen/cursor semantics),
 * this extension uses tmux's virtual terminal:
 *
 *   terminal_send     → tmux send-keys     — type into the program
 *   terminal_capture  → tmux capture-pane  — "take a screenshot" of the screen
 *   terminal_spawn    → tmux split-window  — start a program in a new pane
 *   terminal_stop     → tmux kill-pane     — terminate
 *   terminal_list     → registry lookup    — list active sessions
 *
 * == Usage ==
 *   pi must be running inside tmux ($TMUX must be set).
 *   Auto-discovered: put in ~/.pi/agent/extensions/ and restart pi.
 *
 * == Prompt for the agent ==
 * These tools give you real terminal access. They work like tmux:
 * - Programs have a visual "screen" with cursor, not just input/output streams.
 * - After sending input, wait a moment (~500ms), then capture to see the updated screen.
 * - terminal_capture returns a flat text snapshot of the current display.
 * - Each pane is a persistent, interactive terminal session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PaneMeta {
	command: string;
	name: string;
	createdAt: number;
}

interface TmuxResult {
	stdout: string;
	code: number;
}

// ---------------------------------------------------------------------------
// Registry — tracks panes this extension created
// ---------------------------------------------------------------------------

const panes = new Map<string, PaneMeta>();

// ---------------------------------------------------------------------------
// tmux helper — safe argument passing
// ---------------------------------------------------------------------------

function tmux(args: string[]): TmuxResult {
	const result = spawnSync("tmux", args, {
		encoding: "utf-8",
		timeout: 10_000,
		maxBuffer: 10 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});

	if (result.error) {
		throw new Error(`tmux error: ${result.error.message}`);
	}
	if (result.status !== 0 && result.status !== null) {
		const stderr = (result.stderr ?? "").trim();
		const stdout = (result.stdout ?? "").trim();
		const detail = stderr || stdout || `exit code ${result.status}`;
		throw new Error(`tmux ${args[0] ?? ""} failed: ${detail}`);
	}

	return { stdout: (result.stdout ?? "").trimEnd(), code: result.status ?? 0 };
}

// ---------------------------------------------------------------------------
// Check tmux is available and we are inside a tmux session
// ---------------------------------------------------------------------------

function assertInTmux(): void {
	if (!process.env.TMUX) {
		throw new Error(
			"tmux session required — pi must be running inside tmux.\n" +
				"Start tmux first: tmux new-session -s pi\n" +
				"Then run pi inside it.",
		);
	}

	// Quick check: is tmux actually in PATH and working?
	try {
		tmux(["-V"]);
	} catch (e: unknown) {
		throw new Error(
			`tmux not found or not working. Is tmux installed?\n` + `Detail: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Pane state helpers
// ---------------------------------------------------------------------------

function getPaneCommand(paneId: string): string | null {
	try {
		const r = tmux(["display-message", "-p", "-t", paneId, "#{pane_current_command}"]);
		return r.stdout || null;
	} catch {
		return null;
	}
}

function paneIsAlive(paneId: string): boolean {
	try {
		tmux(["display-message", "-p", "-t", paneId, "#{pane_id}"]);
		return true;
	} catch {
		return false;
	}
}

function resizePane(paneId: string, width: number, height: number): void {
	try {
		tmux(["resize-pane", "-t", paneId, "-x", String(width), "-y", String(height)]);
	} catch {
		// best-effort
	}
}

function setPaneTitle(paneId: string, title: string): void {
	try {
		tmux(["select-pane", "-t", paneId, "-T", title]);
	} catch {
		// best-effort
	}
}

// ---------------------------------------------------------------------------
// Special key names that tmux send-keys understands
// ---------------------------------------------------------------------------

const VALID_KEYS = new Set([
	// Named keys
	"Enter",
	"Return",
	"Tab",
	"BTab",
	"Space",
	"Backspace",
	"Bspace",
	"Escape",
	"Esc",
	// Cursor
	"Up",
	"Down",
	"Left",
	"Right",
	// Navigation
	"Home",
	"End",
	"PageUp",
	"PageDown",
	"PgUp",
	"PgDn",
	// Editing
	"Delete",
	"DC",
	"Insert",
	// Function keys
	"F1", "F2", "F3", "F4", "F5", "F6",
	"F7", "F8", "F9", "F10", "F11", "F12",
	// Ctrl combos (tmux uses C- prefix)
	"C-a", "C-b", "C-c", "C-d", "C-e", "C-f",
	"C-g", "C-h", "C-i", "C-j", "C-k", "C-l",
	"C-m", "C-n", "C-o", "C-p", "C-q", "C-r",
	"C-s", "C-t", "C-u", "C-v", "C-w", "C-x",
	"C-y", "C-z",
	"C-@", "C-[", "C-\\", "C-]", "C-^", "C-_",
	// Meta (Alt) combos
	"M-a", "M-b", "M-c", "M-d", "M-e", "M-f",
	"M-g", "M-h", "M-i", "M-j", "M-k", "M-l",
	"M-m", "M-n", "M-o", "M-p", "M-q", "M-r",
	"M-s", "M-t", "M-u", "M-v", "M-w", "M-x",
	"M-y", "M-z",
]);

function isValidKey(key: string): boolean {
	return VALID_KEYS.has(key);
}

// ---------------------------------------------------------------------------
// Schema definitions
// ---------------------------------------------------------------------------

const terminalSpawnParams = Type.Object({
	command: Type.String({
		description: "Shell command to run in the terminal pane (e.g. 'vim file.txt', 'htop', 'python3', 'ssh user@host')",
		minLength: 1,
	}),
	name: Type.Optional(
		Type.String({
			description: "Optional display name for the terminal session",
		}),
	),
	width: Type.Optional(
		Type.Integer({
			description: "Terminal width in columns (default: 80)",
			minimum: 20,
			maximum: 400,
		}),
	),
	height: Type.Optional(
		Type.Integer({
			description: "Terminal height in rows (default: 24)",
			minimum: 5,
			maximum: 200,
		}),
	),
});

const terminalSendParams = Type.Object({
	pane_id: Type.String({
		description: "Target pane ID from terminal_spawn or terminal_list",
	}),
	input: Type.Optional(
		Type.String({
			description: "Literal text to type into the terminal. Newlines are sent as Enter.",
		}),
	),
	press_enter: Type.Optional(
		Type.Boolean({
			description: "Press Enter after the input text (default: false)",
		}),
	),
	key: Type.Optional(
		Type.String({
			description:
				"Special key to press instead of text input. Common values: Enter, C-c (Ctrl+C to interrupt), C-d (EOF), C-l (clear screen), C-z (suspend), Escape, Tab, Backspace, Up, Down, Left, Right, Home, End, Delete. When provided with input, the key is pressed after the text is typed.",
		}),
	),
});

const terminalCaptureParams = Type.Object({
	pane_id: Type.String({
		description: "Pane ID to capture screen content from",
	}),
	scrollback: Type.Optional(
		Type.Boolean({
			description:
				"Include scrollback history (default: false — only the visible screen is captured)",
		}),
	),
});

const terminalStopParams = Type.Object({
	pane_id: Type.String({
		description: "Pane ID to terminate",
	}),
});

// ── Smart split helpers ───────────────────────────────────────────────────────────────

const SMART_SPLIT_CONF = `
# pi-terminal-tmux: smart splits — landscape = horizontal, portrait = vertical
bind '"' if -F '#{e|<:#{window_width},#{window_height}}' 'split-window' 'split-window -h'
bind % if -F '#{e|<:#{window_width},#{window_height}}' 'split-window -h' 'split-window'
`;

function setupSmartSplits(): void {
	try {
		tmux(["bind", '"', "if", "-F", '#{e|<:#{window_width},#{window_height}}', "split-window", "split-window", "-h"]);
		tmux(["bind", "%", "if", "-F", '#{e|<:#{window_width},#{window_height}}', "split-window", "-h", "split-window"]);
	} catch {
		// best-effort, tmux may lack if -F support
	}
}

function ensureTmuxConfSmartSplits(): boolean {
	const confPath = join(process.env.HOME || "/root", ".tmux.conf");
	try {
		const existing = readFileSync(confPath, "utf-8");
		if (existing.includes("pi-terminal-tmux: smart splits")) return false;
		appendFileSync(confPath, SMART_SPLIT_CONF);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function terminalTmuxExtension(pi: ExtensionAPI): void {
	// ── Guard: require tmux ──────────────────────────────────────────────
	let tmuxOk = false;
	try {
		assertInTmux();
		tmuxOk = true;
	} catch {
		// will be checked on each tool call
	}

	// ── Helper: check tmux on each call ──────────────────────────────────
	function requireTmux(): void {
		if (!tmuxOk) {
			assertInTmux(); // re-throws with the right message
		}
	}

	// ── Cleanup on shutdown ──────────────────────────────────────────────
	pi.on("session_shutdown", async () => {
		for (const [paneId] of panes) {
			try {
				tmux(["kill-pane", "-t", paneId]);
			} catch {
				// pane may already be dead
			}
		}
		panes.clear();
	});

	// ── Tool: terminal_spawn ─────────────────────────────────────────────
	pi.registerTool({
		name: "terminal_spawn",
		label: "Start Terminal",
		description:
			"Start an interactive terminal program in a new tmux pane. " +
			"The program runs with a real TTY, so it supports cursor positioning, " +
			"line editing, and full terminal UI. Use terminal_capture to read the " +
			"current screen content, and terminal_send to type input into it.",
		promptSnippet: "Run interactive TTY programs (vim, htop, python3, ssh, etc.) in a real tmux terminal",
		promptGuidelines: [
			"Use terminal_spawn INSTEAD OF bash for interactive programs: vim, htop, python3 -i, ssh, psql, lazygit, nano, less, fzf, or anything that shows a full-screen UI or reads keystrokes.",
			"Each terminal_spawn creates a persistent tmux pane — it stays alive across turns until you terminal_stop it.",
			"After spawning, always terminal_capture to see what the program displayed. Then terminal_send to type, then terminal_capture again to see the result.",
		],
		parameters: terminalSpawnParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			requireTmux();

			const label = params.name ?? params.command.slice(0, 40);

			// Build command — run via $SHELL -c for proper PATH/aliases
			const shell = process.env.SHELL || "/bin/sh";
			const result = tmux([
				"split-window",
				"-d", // don't switch focus
				"-P", // print pane ID
				"-F", "#{pane_id}\t#{pane_pid}",
				"-l", String(params.height ?? 24),
				shell, "-c", params.command,
			]);

			const parts = result.stdout.split("\n");
			const paneLine = parts[0]?.trim() ?? "";
			const [paneId, pid] = paneLine.split("\t");
			if (!paneId) {
				return {
					content: [{ type: "text", text: `Failed to create terminal pane: empty pane ID from tmux.\nRaw output: ${result.stdout}` }],
					details: {},
					isError: true,
				};
			}

			// Set pane title
			setPaneTitle(paneId, `🐚 ${label}`);

			// Resize if requested (split-window -l sets height; also set width)
			resizePane(paneId, params.width ?? 80, params.height ?? 24);

			// Track
			panes.set(paneId, {
				command: params.command,
				name: label,
				createdAt: Date.now(),
			});

			return {
				content: [
					{
						type: "text",
						text: [
							`Started terminal: ${label}`,
							`  Pane ID:    ${paneId}`,
							`  Command:    ${params.command}`,
							`  PID:        ${pid || "unknown"}`,
							`  Size:       ${params.width ?? 80}×${params.height ?? 24}`,
							"",
							"Use terminal_capture to read the screen, terminal_send to type.",
						].join("\n"),
					},
				],
				details: { pane_id: paneId, name: label, command: params.command, pid },
			};
		},
	});

	// ── Tool: terminal_send ────────────────────────────────────────────
	pi.registerTool({
		name: "terminal_send",
		label: "Send to Terminal",
		description:
			"Send input (keystrokes or text) to a running terminal pane. " +
			"Use this to type commands, navigate in vim, answer prompts, or press special keys " +
			"like Ctrl+C (key: 'C-c') or Enter (key: 'Enter'). " +
			"After sending, call terminal_capture to see the result.",
		promptSnippet: "Type keystrokes or send special keys (Enter, Ctrl+C, etc.) into a terminal pane",
		parameters: terminalSendParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			requireTmux();

			const { pane_id, input, press_enter, key } = params;

			if (!input && !key && !press_enter) {
				return {
					content: [{ type: "text", text: "Nothing to send — provide input, key, or press_enter." }],
					details: {},
					isError: true,
				};
			}

			// Validate key if provided
			if (key && !isValidKey(key)) {
				return {
					content: [
						{
							type: "text",
							text: [
								`Invalid key: "${key}".`,
								"Valid special keys: Enter, Escape, Tab, Backspace, Space, Up, Down, Left, Right, Home, End, Delete, PageUp, PageDown, F1-F12",
								"Ctrl combos: C-a through C-z (e.g. C-c = Ctrl+C, C-d = Ctrl+D)",
								"Alt combos: M-a through M-z (e.g. M-x = Alt+X)",
							].join("\n"),
						},
					],
					details: {},
					isError: true,
				};
			}

			// Send input as separate tmux calls to avoid key-name misinterpretation.
			// - Literal text uses -l (no key-name lookup).
			// - Newlines in input are sent as Enter key presses.
			// - Named keys use their tmux key name.
			try {
				if (input) {
					const segments = input.split("\n");
					for (let i = 0; i < segments.length; i++) {
						if (segments[i]) {
							tmux(["send-keys", "-t", pane_id, "-l", segments[i]]);
						}
						if (i < segments.length - 1) {
							tmux(["send-keys", "-t", pane_id, "Enter"]);
						}
					}
				}
				if (key) {
					tmux(["send-keys", "-t", pane_id, key]);
				}
				if (press_enter) {
					tmux(["send-keys", "-t", pane_id, "Enter"]);
				}
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				// Check if pane still exists
				if (!paneIsAlive(pane_id)) {
					return {
						content: [
							{
								type: "text",
								text: `Pane ${pane_id} no longer exists. The program may have exited.\nUse terminal_list to see active panes.`,
							},
						],
						details: {},
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: `Failed to send to terminal: ${msg}` }],
					details: {},
					isError: true,
				};
			}

			const sentItems: string[] = [];
			if (input) sentItems.push(JSON.stringify(input));
			if (key) sentItems.push(`key:${key}`);
			if (press_enter) sentItems.push("Enter");

			return {
				content: [
					{
						type: "text",
						text: [
							`Sent to pane ${pane_id}:`,
							...sentItems.map((a) => `  ${a}`),
							"",
							"Call terminal_capture after a short delay to see the updated screen.",
						].join("\n"),
					},
				],
				details: { pane_id, input, key, press_enter },
			};
		},
	});

	// ── Tool: terminal_capture ──────────────────────────────────────────
	pi.registerTool({
		name: "terminal_capture",
		label: "Capture Terminal Screen",
		description:
			"Read the current visual content of a terminal pane — like taking a screenshot. " +
			"Returns the text currently displayed on the program's screen. " +
			"Use this after terminal_send to see the program's response. " +
			"The output is plain text (no ANSI codes), showing exactly what a user would see.",
		promptSnippet: "Take a visual 'screenshot' of a terminal pane — see what's on the screen right now",
		parameters: terminalCaptureParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			requireTmux();

			const { pane_id, scrollback } = params;

			if (!paneIsAlive(pane_id)) {
				// Pane might be dead but we can still read its last content
				// Check if we tracked it
				const meta = panes.get(pane_id);
				return {
					content: [
						{
							type: "text",
							text: [
								`Pane ${pane_id} is no longer running.`,
								meta ? `It was: ${meta.command} (${meta.name})` : "Not tracked by this extension.",
								"Use terminal_list to see active panes.",
							].join("\n"),
						},
					],
					details: { pane_id, error: "pane_dead" },
					isError: true,
				};
			}

			const args = ["capture-pane", "-t", pane_id, "-p"];
			if (scrollback) {
				args.push("-S", "-");
			}

			try {
				const result = tmux(args);

				// Get pane size for context
				let sizeInfo = "";
				try {
					const size = tmux(["display-message", "-p", "-t", pane_id, "#{pane_width}x#{pane_height}"]);
					sizeInfo = size.stdout;
				} catch {
					// ignore
				}

				const lines = result.stdout.split("\n");
				const visibleLines = scrollback ? `~${lines.length}` : `${lines.length}`;

				const header = [
					`── Terminal ${pane_id} ──${sizeInfo ? ` (${sizeInfo})` : ""} ──`,
				].join("\n");

				// Build the output — header + a subtle separator around the screen
				const content = result.stdout || "(blank screen)";

				return {
					content: [
						{
							type: "text",
							text: [
								header,
								content,
							].join("\n"),
						},
					],
					details: {
						pane_id,
						lines: lines.length,
						size: sizeInfo,
						scrollback: !!scrollback,
					},
				};
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				return {
					content: [{ type: "text", text: `Failed to capture terminal: ${msg}` }],
					details: {},
					isError: true,
				};
			}
		},
	});

	// ── Tool: terminal_list ──────────────────────────────────────────────
	pi.registerTool({
		name: "terminal_list",
		label: "List Active Terminals",
		description:
			"List all active terminal sessions managed by this extension. " +
			"Shows pane ID, command, and running status for each session.",
		promptSnippet: "List all active terminal (tmux) sessions and their pane IDs",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			requireTmux();

			if (panes.size === 0) {
				return {
					content: [{ type: "text", text: "No active terminal sessions. Use terminal_spawn to create one." }],
					details: { panes: [] },
				};
			}

			const lines: string[] = ["Active terminal sessions:"];
			for (const [paneId, meta] of panes) {
				const alive = paneIsAlive(paneId);
				const currentCmd = alive ? getPaneCommand(paneId) : null;
				const aliveMarker = alive ? "●" : "○";
				const age = Math.round((Date.now() - meta.createdAt) / 1000);
				lines.push(
					`  ${aliveMarker} ${paneId}`,
					`      Name:    ${meta.name}`,
					`      Command: ${meta.command}`,
					`      Age:     ${age}s`,
					currentCmd ? `      Running: ${currentCmd}` : "",
				);
			}

			return {
				content: [{ type: "text", text: lines.filter(Boolean).join("\n") }],
				details: {
					panes: Array.from(panes.entries()).map(([id, meta]) => ({
						pane_id: id,
						command: meta.command,
						name: meta.name,
						created_at: new Date(meta.createdAt).toISOString(),
						running: paneIsAlive(id),
					})),
				},
			};
		},
	});

	// ── Tool: terminal_stop ──────────────────────────────────────────────
	pi.registerTool({
		name: "terminal_stop",
		label: "Stop Terminal Session",
		description:
			"Terminate a terminal session by killing its tmux pane. " +
			"The pane and its contents are destroyed. Use terminal_list first if you're not sure of the pane ID.",
		promptSnippet: "Kill a tmux pane and destroy the interactive TTY session",
		parameters: terminalStopParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			requireTmux();

			const { pane_id } = params;
			const meta = panes.get(pane_id);

			try {
				tmux(["kill-pane", "-t", pane_id]);
			} catch (e: unknown) {
				// Maybe already dead
				const msg = e instanceof Error ? e.message : String(e);
				// Still clean up from registry
				panes.delete(pane_id);
				return {
					content: [
						{
							type: "text",
							text: `Pane ${pane_id} could not be killed: ${msg}.\nRemoved from registry anyway.`,
						},
					],
					details: { pane_id, stopped: false },
				};
			}

			panes.delete(pane_id);

			return {
				content: [
					{
						type: "text",
						text: [
							`Terminal stopped: ${pane_id}`,
							meta ? `  Command: ${meta.command}` : "",
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: { pane_id, command: meta?.command, stopped: true },
			};
		},
	});

	// ── Inject tmux environment awareness into system prompt ────────────
	// This tells the LLM it can use tmux + terminal_* tools for interactive programs.
	pi.on("before_agent_start", async (event) => {
		if (!tmuxOk) return;

		const tmuxBlock = [
			"",
			"── TMUX TERMINAL ENVIRONMENT ──",
			"You are running inside tmux (a terminal multiplexer). This means you have",
			"REAL TERMINAL (TTY) access through the terminal_* tools below.",
			"",
			"KEY RULE: When to use bash vs terminal_*:",
			"  bash  ........  Non-interactive commands: ls, grep, cat, git log, find,",
			"                    npm install, curl, mkdir, etc.",
			"  terminal_*  ..  Interactive TTY programs: vim, htop, python3 -i, ssh,",
			"                    psql, lazygit, tig, fzf, nano, less (when browsing),",
			"                    REPL languages, database CLIs, kubectl exec -it, etc.",
			"",
			"INTERACTIVE SESSION WORKFLOW:",
			"  1. terminal_spawn(command)  → starts the program in a tmux pane",
			"  2. terminal_send(pane, input) → types keystrokes / text",
			"  3. terminal_capture(pane)   → reads the current screen (like a photo)",
			"  4. Repeat 2-3 to interact. Always capture AFTER sending.",
			"  5. terminal_stop(pane)       → terminates the session",
			"",
			"WHY NOT BASH? The bash tool uses pipes (stdout/stderr), which lose TTY",
			"semantics — no screen, no cursor, no line editing. vim/htop/ssh refuse to",
			"run properly under bash. terminal_* uses tmux virtual terminals instead.",
			"",
			"Note: terminal_* panes are visible in the tmux window. You can manage them",
			"just like regular tmux sessions — they persist across conversation turns.",
			"───────────────────────────────────────",
		].join("\n");

		return {
			systemPrompt: event.systemPrompt + tmuxBlock,
		};
	});

	// ── Command: /terminal-tmux-setup ───────────────────────────────────
	pi.registerCommand("terminal-tmux-setup", {
		description: "Configure tmux with smart splits (landscape=horizontal, portrait=vertical split)",
		handler: async (_args, ctx) => {
			if (!tmuxOk) {
				ctx.ui.notify("Not in tmux — nothing to configure.", "warning");
				return;
			}
			setupSmartSplits();
			const wrote = ensureTmuxConfSmartSplits();
			if (wrote) {
				ctx.ui.notify("Smart splits written to ~/.tmux.conf and applied to current session.", "success");
			} else {
				ctx.ui.notify("Smart splits applied to current session (already in ~/.tmux.conf or couldn't write).", "info");
			}
		},
	});

	// ── Notify on load, auto-configure smart splits ────────────────────
	pi.on("session_start", async (_event, ctx) => {
		try {
			assertInTmux();
			setupSmartSplits();
			ctx.ui.setStatus("tmux-term", ctx.ui.theme.fg("accent", "🐚 TTY"));
			ctx.ui.notify("Terminal Tmux loaded. Smart splits active. Run /terminal-tmux-setup to persist.", "info");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			ctx.ui.setStatus("tmux-term", ctx.ui.theme.fg("error", "⚠ no tmux"));
			ctx.ui.notify(`Terminal Tmux: tmux not available — ${msg}`, "warning");
		}
	});
}
