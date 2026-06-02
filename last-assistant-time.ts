/**
 * Last Assistant Response Time
 *
 * Shows the timestamp of the most recent assistant response in the footer
 * status area. The timestamp comes from the in-memory SessionManager, walking
 * the *current branch* (not the raw jsonl file), so /tree navigation and /fork
 * are handled correctly.
 *
 * Trigger points:
 *  - session_start : restore the value when a session is loaded/resumed
 *  - message_end   : refresh as soon as an assistant message finishes
 *  - a 30s interval: refresh the relative "Xm ago" portion while idle
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "last-assistant-ts";

/**
 * Return the Unix-ms timestamp of the last assistant message on the current
 * branch, or undefined if none.
 */
function readLastAssistantTs(ctx: ExtensionContext): number | undefined {
	const branch = ctx.sessionManager.getBranch();
	// getBranch() returns entries root -> leaf; walk from the leaf backwards.
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "assistant") continue;

		// Prefer the message-level Unix-ms timestamp; fall back to the entry's
		// ISO timestamp (SessionEntryBase.timestamp).
		if (typeof msg.timestamp === "number") return msg.timestamp;
		const t = Date.parse(entry.timestamp);
		return Number.isNaN(t) ? undefined : t;
	}
	return undefined;
}

function formatRelative(tsMs: number): string {
	const diffSec = Math.max(0, Math.round((Date.now() - tsMs) / 1000));
	if (diffSec < 60) return `${diffSec}s ago`;
	const diffMin = Math.round(diffSec / 60);
	if (diffMin < 60) return `${diffMin}m ago`;
	const diffHr = Math.round(diffMin / 60);
	if (diffHr < 24) return `${diffHr}h ago`;
	return `${Math.round(diffHr / 24)}d ago`;
}

function formatClock(tsMs: number): string {
	const d = new Date(tsMs);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

export default function (pi: ExtensionAPI) {
	let lastTs: number | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	const render = (ctx: ExtensionContext) => {
		const theme = ctx.ui.theme;
		if (lastTs === undefined) {
			ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", "last reply: —"));
			return;
		}
		const text = `last reply: ${formatClock(lastTs)} (${formatRelative(lastTs)})`;
		ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", text));
	};

	const refresh = (ctx: ExtensionContext) => {
		lastTs = readLastAssistantTs(ctx);
		render(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		refresh(ctx);
		// Keep the relative time fresh while idle.
		if (timer) clearInterval(timer);
		timer = setInterval(() => render(ctx), 30_000);
		// Don't keep the process alive just for this timer.
		if (typeof timer === "object" && "unref" in timer) (timer as any).unref?.();
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		refresh(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	});
}
