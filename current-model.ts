/**
 * current-model extension
 *
 * Exposes the currently active pi model to the agent itself.
 *
 * Why: AGENTS.md (~/AGENTS.md) requires every commit message to end with a
 *   `Co-authored-by: pi with <model> <pi@local>` trailer, where `<model>` is
 *   the exact model id. Without this extension the agent has no way to read
 *   that id from inside a session and is told to "ask the user instead of
 *   guessing". This extension closes that gap.
 *
 * What it provides:
 *   1. A `get_current_model` tool the LLM can call any time to retrieve
 *      provider, id, and a ready-to-paste `Co-authored-by` trailer.
 *   2. A `/current-model` slash command for humans to inspect the same info
 *      from the TUI.
 *
 * Notes:
 *   - We deliberately do NOT inject the model id into the system prompt.
 *     System-prompt content is cached across turns; baking a value that
 *     can change mid-session (via /model or Ctrl+P) would either bust the
 *     cache on every change or go stale. A tool call is cheap and always
 *     fresh.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

function describeSession(
	model: { provider: string; id: string; contextWindow?: number } | undefined,
	thinkingLevel: ThinkingLevel,
) {
	if (!model) {
		return {
			available: false as const,
			thinkingLevel,
			text: `No model is currently active in this pi session.\nthinkingLevel: ${thinkingLevel}`,
		};
	}
	const trailer = `Co-authored-by: pi with ${model.id} <pi@local>`;
	const lines = [
		`provider: ${model.provider}`,
		`id: ${model.id}`,
		model.contextWindow ? `contextWindow: ${model.contextWindow}` : undefined,
		`thinkingLevel: ${thinkingLevel}`,
		"",
		"git commit trailer (per ~/AGENTS.md):",
		trailer,
	].filter(Boolean) as string[];
	return {
		available: true as const,
		provider: model.provider,
		id: model.id,
		contextWindow: model.contextWindow,
		thinkingLevel,
		coAuthoredByTrailer: trailer,
		text: lines.join("\n"),
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "get_current_model",
		label: "Get Current Model",
		description:
			"Return the pi model and thinking level currently driving this " +
			"agent session (provider, id, contextWindow, thinkingLevel) plus " +
			"a ready-to-paste `Co-authored-by: pi with <model> <pi@local>` " +
			"git trailer. Use this whenever you need the active model id or " +
			"thinking level, especially before writing a git commit message " +
			"that requires the trailer.",
		promptSnippet:
			"Look up the current pi model id, thinking level, and Co-authored-by trailer for this session.",
		promptGuidelines: [
			"Before writing a git commit message that needs the `Co-authored-by: pi with <model>` trailer, call get_current_model to fetch the exact model id instead of guessing or asking the user.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const info = describeSession(ctx.model, pi.getThinkingLevel());
			return {
				content: [{ type: "text", text: info.text }],
				details: info,
			};
		},
	});

	pi.registerCommand("current-model", {
		description: "Show the model and thinking level active in this pi session",
		handler: async (_args, ctx) => {
			const info = describeSession(ctx.model, pi.getThinkingLevel());
			ctx.ui.notify(info.text, info.available ? "info" : "warning");
		},
	});
}
