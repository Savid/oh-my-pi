import { describe, expect, it } from "bun:test";
import { parseRequest } from "@oh-my-pi/pi-ai/providers/openai-chat-server";
import { convertCodexResponsesMessages } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { parseRequest as parseResponsesRequest } from "@oh-my-pi/pi-ai/providers/openai-responses-server";
import type { ResponseInput } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { Api, AssistantMessage, Context, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createCodexModel } from "./helpers";

/**
 * Auth-gateway clients send back the reasoning summaries the gateway streamed
 * them: chat clients (pi, OpenCode v2) as `reasoning_content`, Responses
 * clients (Codex) as `reasoning` items. For a Codex target that text must not
 * reach the model: demoted, it arrives as the model's own `<think>`-tagged
 * `output_text`, which a native Codex client never sends.
 */
const ROUTE_SUMMARY = "**Planning the route east**";
const MAP_SUMMARY = "**Checking the map for stairs**";
const ORPHAN_SUMMARY = "**Weighing a retreat**";

function chatClientContext(): Context {
	return parseRequest({
		model: "openai-codex/gpt-6-luna",
		messages: [
			{ role: "system", content: "Play NetHack." },
			{ role: "user", content: "Find the down stairs." },
			{
				role: "assistant",
				content: "Heading east.",
				reasoning_content: ROUTE_SUMMARY,
				tool_calls: [{ id: "call_move", type: "function", function: { name: "nh", arguments: '{"cmd":"l"}' } }],
			},
			{ role: "tool", tool_call_id: "call_move", content: "You see a staircase." },
			{ role: "assistant", content: "Found the stairs.", reasoning_content: MAP_SUMMARY },
			{ role: "user", content: "Keep going." },
			{ role: "assistant", content: null, reasoning_content: ORPHAN_SUMMARY },
			{ role: "user", content: "Descend." },
		],
	}).context;
}

/** Every free-text field a Responses input item can carry, including reasoning summaries. */
function wireText(items: ResponseInput): string {
	return JSON.stringify(items);
}

function assistantOutputTexts(items: ResponseInput): string[] {
	const texts: string[] = [];
	for (const item of items) {
		if (!("role" in item) || item.role !== "assistant" || !Array.isArray(item.content)) continue;
		for (const part of item.content) {
			if (part && typeof part === "object" && "text" in part && typeof part.text === "string") texts.push(part.text);
		}
	}
	return texts;
}

function makeModel<T extends Api>(api: T, provider: string, id: string): Model<T> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl: "",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
	} as ModelSpec<T>);
}

describe("auth-gateway replay of streamed reasoning to Codex", () => {
	it("drops a chat client's reasoning_content and keeps the visible turn and tool pairing", () => {
		const input = convertCodexResponsesMessages(createCodexModel("gpt-6-luna"), chatClientContext());
		const text = wireText(input);

		for (const summary of [ROUTE_SUMMARY, MAP_SUMMARY, ORPHAN_SUMMARY]) expect(text).not.toContain(summary);
		expect(text).not.toContain("<think>");
		expect(input.some(item => "type" in item && item.type === "reasoning")).toBe(false);

		// The reasoning-only turn leaves no empty assistant message behind.
		expect(assistantOutputTexts(input)).toEqual(["Heading east.", "Found the stairs."]);
		const call = input.find(item => "type" in item && item.type === "function_call");
		const output = input.find(item => "type" in item && item.type === "function_call_output");
		expect(call && "call_id" in call ? call.call_id : undefined).toBe("call_move");
		expect(output && "call_id" in output ? output.call_id : undefined).toBe("call_move");
	});

	it("drops a Responses client's reasoning item summary", () => {
		const { context } = parseResponsesRequest({
			model: "openai-codex/gpt-6-luna",
			input: [
				{ type: "message", role: "user", content: [{ type: "input_text", text: "Find the down stairs." }] },
				{ type: "reasoning", id: "rs_client", summary: [{ type: "summary_text", text: ROUTE_SUMMARY }] },
				{ type: "function_call", call_id: "call_move", name: "nh", arguments: '{"cmd":"l"}' },
				{ type: "function_call_output", call_id: "call_move", output: "You see a staircase." },
				{ type: "message", role: "user", content: [{ type: "input_text", text: "Descend." }] },
			],
		});
		const input = convertCodexResponsesMessages(createCodexModel("gpt-6-luna"), context);

		expect(wireText(input)).not.toContain(ROUTE_SUMMARY);
		expect(assistantOutputTexts(input)).toEqual([]);
		expect(input.some(item => "type" in item && item.type === "function_call")).toBe(true);
	});

	it("still replays Codex's own encrypted reasoning item on a same-model turn", () => {
		const reasoningItem = {
			type: "reasoning",
			id: "rs_own",
			summary: [{ type: "summary_text", text: ROUTE_SUMMARY }],
			encrypted_content: "opaque-encrypted-reasoning",
		};
		const own: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: ROUTE_SUMMARY, thinkingSignature: JSON.stringify(reasoningItem) },
				{ type: "text", text: "Heading east." },
			],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-6-luna",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
		const input = convertCodexResponsesMessages(createCodexModel("gpt-6-luna"), {
			messages: [{ role: "user", content: "Find the down stairs.", timestamp: 0 }, own],
		});

		const replayed = input.find(item => "type" in item && item.type === "reasoning");
		expect(replayed && "encrypted_content" in replayed ? replayed.encrypted_content : undefined).toBe(
			"opaque-encrypted-reasoning",
		);
		expect(wireText(input)).not.toContain("<think>");
	});

	it("leaves the demoted text in place for a non-Codex Responses target", () => {
		const target = makeModel("openai-responses", "openai", "gpt-6-luna");
		const out = transformMessages(chatClientContext().messages, target);
		const demoted = out
			.filter((m): m is AssistantMessage => m.role === "assistant")
			.flatMap(m => m.content)
			.filter(block => block.type === "text" && block.text.includes("<think>"));
		expect(demoted).toHaveLength(3);
	});
});
