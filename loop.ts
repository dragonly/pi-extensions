/**
 * /loop extension
 *
 * Schedule a recurring task in the current pi session.
 *
 * Usage:
 *   /loop                                            # interactive manage panel
 *   /loop 10m 检查一下这个 PR：https://github.com/foo/bar/pull/42
 *   /loop 30s ping me a haiku
 *   /loop 10m --max=20 keep watching ...             # custom fire cap
 *   /loop 10m --max=0 keep watching ...              # 0 = unlimited
 *   /loop list                                       # toast list
 *   /loop stop            # stop all tasks
 *   /loop stop <id>       # stop one task
 *
 * Fire cap:
 *   - Each task has a maximum number of *successful* fires (default 10).
 *     Skipped ticks (because the agent was busy) do NOT count.
 *   - When the cap is reached the task is auto-stopped.
 *   - Override per task with --max=N (or --max N). Use --max=0 for unlimited.
 *
 * Behaviour:
 *   - Each tick is delivered as a custom message via pi.sendMessage(...)
 *     with triggerTurn=true, deliverAs="followUp" so it never interrupts
 *     a running turn but does start one when the agent is idle.
 *   - If the agent is busy (streaming or has pending follow-ups) when a
 *     tick fires, the tick is *skipped* rather than queued. This avoids
 *     stacking multiple follow-up messages when a turn outlasts the loop
 *     interval. The skip count is shown in the manage panel.
 *   - The footer status bar shows the active task count and time-to-next-tick.
 *   - Tasks live for the duration of the session; they are cleared on
 *     session_shutdown and not persisted.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";

const CUSTOM_TYPE = "loop";
const DEFAULT_MAX_FIRES = 10;

interface LoopMessageDetails {
	taskId: number;
	intervalLabel: string;
	fire: number;
	prompt: string;
}

interface LoopTask {
	id: number;
	intervalMs: number;
	intervalLabel: string; // human form, e.g. "10m"
	prompt: string;
	createdAt: number;
	nextFireAt: number;
	timer: NodeJS.Timeout;
	fires: number;
	/** Number of ticks dropped because the agent was busy. */
	skipped: number;
	/** Maximum number of successful fires before the task auto-stops. 0 = unlimited. */
	maxFires: number;
}

export default function (pi: ExtensionAPI) {
	const tasks = new Map<number, LoopTask>();
	let nextId = 1;
	let statusTimer: NodeJS.Timeout | undefined;
	let lastCtx: ExtensionContext | undefined;

	// ---- helpers --------------------------------------------------------

	function parseInterval(token: string): { ms: number; label: string } | null {
		// Support: 30s, 10m, 10min, 1h, 1.5m
		const m = token.match(
			/^(\d+(?:\.\d+)?)(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/i,
		);
		if (!m) return null;
		const n = Number.parseFloat(m[1]);
		if (!Number.isFinite(n) || n <= 0) return null;
		const unit = (m[2] ?? "s").toLowerCase();
		let ms: number;
		let label: string;
		if (unit.startsWith("h")) {
			ms = n * 3600_000;
			label = `${trimNum(n)}h`;
		} else if (unit.startsWith("m") && !unit.startsWith("ms")) {
			ms = n * 60_000;
			label = `${trimNum(n)}m`;
		} else {
			ms = n * 1000;
			label = `${trimNum(n)}s`;
		}
		// hard floor: 5 seconds, to avoid runaway loops
		if (ms < 5000) return null;
		return { ms, label };
	}

	function trimNum(n: number): string {
		return Number.isInteger(n) ? String(n) : String(n);
	}

	function formatDuration(ms: number): string {
		if (ms < 0) ms = 0;
		const sec = Math.round(ms / 1000);
		if (sec < 60) return `${sec}s`;
		const m = Math.floor(sec / 60);
		const s = sec % 60;
		if (m < 60) return s === 0 ? `${m}m` : `${m}m${s}s`;
		const h = Math.floor(m / 60);
		const mm = m % 60;
		return mm === 0 ? `${h}h` : `${h}h${mm}m`;
	}

	function formatPreview(text: string, max = 60): string {
		const oneLine = text.replace(/\s+/g, " ").trim();
		return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
	}

	function refreshStatus(ctx?: ExtensionContext) {
		if (ctx) lastCtx = ctx;
		const ui = lastCtx?.ui;
		if (!ui) return;

		if (tasks.size === 0) {
			ui.setStatus("loop", undefined);
			if (statusTimer) {
				clearInterval(statusTimer);
				statusTimer = undefined;
			}
			return;
		}

		const now = Date.now();
		// pick the task that fires soonest for the countdown
		let soonest: LoopTask | undefined;
		for (const t of tasks.values()) {
			if (!soonest || t.nextFireAt < soonest.nextFireAt) soonest = t;
		}
		const remaining = soonest ? soonest.nextFireAt - now : 0;
		const label =
			tasks.size === 1
				? `⏱ loop ${soonest!.intervalLabel} · next ${formatDuration(remaining)}`
				: `⏱ ${tasks.size} loops · next ${formatDuration(remaining)}`;
		ui.setStatus("loop", label);

		if (!statusTimer) {
			statusTimer = setInterval(() => refreshStatus(), 1000);
			// Don't keep the process alive just for the status ticker.
			(statusTimer as unknown as { unref?: () => void }).unref?.();
		}
	}

	/**
	 * Decide whether the agent is busy enough that we should drop this tick
	 * instead of queuing yet another follow-up. We treat "busy" as either
	 * actively streaming or having any pending messages waiting to be
	 * delivered (which includes earlier loop ticks that haven't been
	 * consumed yet).
	 */
	function shouldSkipTick(): boolean {
		if (!lastCtx) return false;
		try {
			if (!lastCtx.isIdle()) return true;
			if (lastCtx.hasPendingMessages()) return true;
		} catch {
			// If the context APIs throw (e.g. session torn down), be safe and skip.
			return true;
		}
		return false;
	}

	function fireTask(task: LoopTask) {
		// Always advance nextFireAt by exactly one interval, regardless of
		// whether we deliver. This keeps the cadence stable.
		task.nextFireAt = Date.now() + task.intervalMs;

		if (shouldSkipTick()) {
			task.skipped += 1;
			refreshStatus();
			return;
		}

		task.fires += 1;

		const capLabel = task.maxFires > 0 ? `/${task.maxFires}` : "";
		const decorated = `[loop #${task.id} · every ${task.intervalLabel} · fire #${task.fires}${capLabel}]\n${task.prompt}`;
		const details: LoopMessageDetails = {
			taskId: task.id,
			intervalLabel: task.intervalLabel,
			fire: task.fires,
			prompt: task.prompt,
		};

		try {
			pi.sendMessage(
				{
					customType: CUSTOM_TYPE,
					content: decorated,
					display: true,
					details,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch (err) {
			console.error(`[loop] failed to send message for task ${task.id}:`, err);
			stopTask(task.id);
			return;
		}

		// Auto-stop when we hit the configured fire cap. We do this *after*
		// sending so the final tick still gets delivered.
		if (task.maxFires > 0 && task.fires >= task.maxFires) {
			stopTask(task.id);
			try {
				lastCtx?.ui.notify(
					`Loop #${task.id} reached its cap (${task.maxFires} fires) and was stopped.`,
					"info",
				);
			} catch {
				// best-effort
			}
			return;
		}

		refreshStatus();
	}

	function startTask(
		intervalMs: number,
		intervalLabel: string,
		prompt: string,
		maxFires: number,
	): LoopTask {
		const id = nextId++;
		const task: LoopTask = {
			id,
			intervalMs,
			intervalLabel,
			prompt,
			createdAt: Date.now(),
			nextFireAt: Date.now() + intervalMs,
			timer: undefined as unknown as NodeJS.Timeout,
			fires: 0,
			skipped: 0,
			maxFires,
		};
		task.timer = setInterval(() => fireTask(task), intervalMs);
		(task.timer as unknown as { unref?: () => void }).unref?.();
		tasks.set(id, task);
		return task;
	}

	function stopTask(id: number): boolean {
		const t = tasks.get(id);
		if (!t) return false;
		clearInterval(t.timer);
		tasks.delete(id);
		refreshStatus();
		return true;
	}

	function stopAll(): number {
		const n = tasks.size;
		for (const t of tasks.values()) clearInterval(t.timer);
		tasks.clear();
		refreshStatus();
		return n;
	}

	// Build a one-line summary for a task, used in the manage selector.
	function taskRow(t: LoopTask): string {
		const remaining = formatDuration(t.nextFireAt - Date.now());
		const skippedPart = t.skipped > 0 ? `  skipped=${t.skipped}` : "";
		const firesPart = t.maxFires > 0 ? `fires=${t.fires}/${t.maxFires}` : `fires=${t.fires}`;
		return `#${t.id}  every ${t.intervalLabel}  next ${remaining}  ${firesPart}${skippedPart}  ${formatPreview(t.prompt)}`;
	}

	// ---- interactive manage panel --------------------------------------

	async function showManage(ctx: ExtensionCommandContext): Promise<void> {
		// loop until the user picks "Close" or escapes
		// (so they can inspect / cancel multiple tasks in one session)
		// note: select() returns undefined on escape
		while (true) {
			if (tasks.size === 0) {
				ctx.ui.notify("No active loop tasks.", "info");
				return;
			}

			const sorted = [...tasks.values()].sort((a, b) => a.id - b.id);
			const ROW_TO_TASK: number[] = []; // index in options -> task id
			const options: string[] = [];

			for (const t of sorted) {
				options.push(taskRow(t));
				ROW_TO_TASK.push(t.id);
			}
			options.push("─── Stop all ───");
			const STOP_ALL_INDEX = options.length - 1;
			options.push("Close");
			const CLOSE_INDEX = options.length - 1;

			const picked = await ctx.ui.select(`Loop tasks (${tasks.size})`, options);
			if (!picked) return; // escape
			const idx = options.indexOf(picked);
			if (idx < 0 || idx === CLOSE_INDEX) return;

			if (idx === STOP_ALL_INDEX) {
				const ok = await ctx.ui.confirm("Stop all", `Stop all ${tasks.size} loop task(s)?`);
				if (ok) {
					const n = stopAll();
					ctx.ui.notify(`Stopped ${n} loop task(s).`, "info");
				}
				continue;
			}

			const taskId = ROW_TO_TASK[idx];
			const t = tasks.get(taskId);
			if (!t) continue; // task disappeared (e.g. timer fired stop)

			// Inspect detail. Use editor() for read-only-ish multi-line view.
			const capStr = t.maxFires > 0 ? `${t.maxFires}` : "unlimited";
			const detail = [
				`ID:        #${t.id}`,
				`Interval:  every ${t.intervalLabel} (${t.intervalMs} ms)`,
				`Created:   ${new Date(t.createdAt).toLocaleString()}`,
				`Next fire: in ${formatDuration(t.nextFireAt - Date.now())}`,
				`Fires:     ${t.fires} / ${capStr}`,
				`Skipped:   ${t.skipped}  (ticks dropped because the agent was busy)`,
				`Prompt:`,
				t.prompt,
			].join("\n");

			const action = await ctx.ui.select(`Loop #${t.id}`, [
				"Stop this loop",
				"Show full detail",
				"Back",
			]);

			if (action === "Stop this loop") {
				const ok = await ctx.ui.confirm(
					`Stop loop #${t.id}`,
					`Every ${t.intervalLabel} · fired ${t.fires} time(s)\n\n${formatPreview(t.prompt, 120)}`,
				);
				if (ok) {
					stopTask(t.id);
					ctx.ui.notify(`Stopped loop #${t.id}.`, "info");
				}
			} else if (action === "Show full detail") {
				// editor() shows a multi-line view that the user can scroll.
				// We don't care about the returned text.
				await ctx.ui.editor(`Loop #${t.id}`, detail);
			}
			// fall through: re-show the manage list
		}
	}

	// ---- the /loop command ---------------------------------------------

	pi.registerCommand("loop", {
		description:
			"Schedule a recurring prompt: /loop <interval> [--max=N] <prompt> | /loop (manage) | /loop list | /loop stop [id]. Default cap: 10 fires; --max=0 = unlimited.",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const trimmed = args.trim();

			// /loop  (no args) -> interactive manage panel
			if (!trimmed) {
				if (tasks.size === 0) {
					ctx.ui.notify(
						"No active loop tasks.\nUsage: /loop <interval> <prompt>   e.g. /loop 10m check PR https://...",
						"info",
					);
					return;
				}
				await showManage(ctx);
				return;
			}

			// /loop list (toast snapshot, no interaction)
			if (trimmed === "list" || trimmed === "ls") {
				if (tasks.size === 0) {
					ctx.ui.notify("No active loop tasks.", "info");
					return;
				}
				const lines = [...tasks.values()].sort((a, b) => a.id - b.id).map(taskRow);
				ctx.ui.notify(`Active loops:\n${lines.join("\n")}`, "info");
				return;
			}

			// /loop manage (explicit alias)
			if (trimmed === "manage") {
				await showManage(ctx);
				return;
			}

			// /loop stop [id]
			if (trimmed === "stop" || trimmed.startsWith("stop ")) {
				const rest = trimmed.slice(4).trim();
				if (!rest) {
					if (tasks.size === 0) {
						ctx.ui.notify("No active loop tasks.", "info");
						return;
					}
					const ok = await ctx.ui.confirm("Stop all", `Stop all ${tasks.size} loop task(s)?`);
					if (!ok) return;
					const n = stopAll();
					ctx.ui.notify(`Stopped ${n} loop task(s).`, "info");
					return;
				}
				const id = Number.parseInt(rest, 10);
				if (!Number.isFinite(id)) {
					ctx.ui.notify(`Bad task id: ${rest}`, "warning");
					return;
				}
				const ok = stopTask(id);
				ctx.ui.notify(ok ? `Stopped loop #${id}.` : `No loop task #${id}.`, ok ? "info" : "warning");
				return;
			}

			// /loop <interval> [--max=N | --max N] <prompt>
			const spaceIdx = trimmed.search(/\s/);
			if (spaceIdx < 0) {
				ctx.ui.notify("Missing prompt. Usage: /loop <interval> [--max=N] <prompt>", "warning");
				return;
			}
			const intervalToken = trimmed.slice(0, spaceIdx);
			let rest = trimmed.slice(spaceIdx + 1).trim();

			const parsed = parseInterval(intervalToken);
			if (!parsed) {
				ctx.ui.notify(
					`Bad interval "${intervalToken}". Use forms like 30s, 10m, 1h. Minimum 5s.`,
					"warning",
				);
				return;
			}

			// Optional --max=N / --max N flag, anywhere up front.
			let maxFires = DEFAULT_MAX_FIRES;
			// --max=N
			let maxMatch = rest.match(/^--max=(\S+)\s*/);
			if (maxMatch) {
				const v = Number.parseInt(maxMatch[1], 10);
				if (!Number.isFinite(v) || v < 0) {
					ctx.ui.notify(`Bad --max value "${maxMatch[1]}". Use a non-negative integer (0 = unlimited).`, "warning");
					return;
				}
				maxFires = v;
				rest = rest.slice(maxMatch[0].length);
			} else {
				// --max N
				maxMatch = rest.match(/^--max\s+(\S+)\s*/);
				if (maxMatch) {
					const v = Number.parseInt(maxMatch[1], 10);
					if (!Number.isFinite(v) || v < 0) {
						ctx.ui.notify(`Bad --max value "${maxMatch[1]}". Use a non-negative integer (0 = unlimited).`, "warning");
						return;
					}
					maxFires = v;
					rest = rest.slice(maxMatch[0].length);
				}
			}

			const prompt = rest.trim();
			if (!prompt) {
				ctx.ui.notify("Missing prompt body.", "warning");
				return;
			}

			const task = startTask(parsed.ms, parsed.label, prompt, maxFires);
			const capStr = task.maxFires > 0 ? ` (max ${task.maxFires} fires)` : " (unlimited)";
			ctx.ui.notify(
				`Loop #${task.id} scheduled every ${task.intervalLabel}${capStr}. /loop to manage, /loop stop ${task.id} to cancel.`,
				"info",
			);
			refreshStatus(ctx);
		},

		// argument completion: "list" | "stop" | "manage"
		getArgumentCompletions: (prefix: string) => {
			const items = ["list", "stop", "manage"]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s }));
			return items.length > 0 ? items : null;
		},
	});

	// ---- message rendering ---------------------------------------------

	pi.registerMessageRenderer<LoopMessageDetails>(CUSTOM_TYPE, (message, { expanded }, theme) => {
		const details = (message.details ?? {}) as Partial<LoopMessageDetails>;
		const id = details.taskId ?? "?";
		const interval = details.intervalLabel ?? "?";
		const fire = details.fire ?? "?";

		const header = theme.fg("accent", `⏱ loop #${id} · every ${interval} · fire #${fire}`);

		// Always show the prompt, fall back to raw content if details missing.
		const body =
			typeof details.prompt === "string" && details.prompt.length > 0
				? details.prompt
				: typeof message.content === "string"
					? message.content
					: "";

		const visibleBody = expanded ? body : formatPreview(body, 200);

		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${header}\n${theme.fg("dim", visibleBody)}`, 0, 0));
		return box;
	});

	// ---- lifecycle ------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		// Fresh session: nothing to restore. Just make sure status is clean.
		refreshStatus();
	});

	pi.on("session_shutdown", async () => {
		stopAll();
		if (statusTimer) {
			clearInterval(statusTimer);
			statusTimer = undefined;
		}
	});
}
