import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { parseRequest as parseMessagesRequest } from "@oh-my-pi/pi-ai/providers/anthropic-messages-server";
import { parseRequest } from "@oh-my-pi/pi-ai/providers/openai-chat-server";
import {
	buildTransformedCodexRequestBody,
	convertCodexResponsesMessages,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { encodeStream, parseRequest as parseResponsesRequest } from "@oh-my-pi/pi-ai/providers/openai-responses-server";
import type { ResponseInput } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type {
	Api,
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	ModelSpec,
	ProviderSessionState,
} from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as piUtils from "@oh-my-pi/pi-utils";
import { createCodexModel } from "./helpers";

/**
 * Auth-gateway clients send back the reasoning the gateway streamed them: chat
 * clients (pi, OpenCode v2) as `reasoning_content`, Responses clients (Codex)
 * as `reasoning` items, Messages clients (Claude Code) as signed thinking. A
 * Codex target replays only its own encrypted reasoning items; any other
 * reasoning text would reach the model as its own `<think>`-tagged
 * `output_text`.
 */
const ROUTE_SUMMARY = "**Planning the route east**";
const MAP_SUMMARY = "**Checking the map for stairs**";
const ORPHAN_SUMMARY = "**Weighing a retreat**";
const ENCRYPTED = "opaque-encrypted-reasoning";

/** The reasoning item Codex returns, as its provider keeps it in the thinking signature. */
const CODEX_REASONING_ITEM = {
	type: "reasoning",
	id: "rs_own",
	summary: [{ type: "summary_text", text: ROUTE_SUMMARY }],
	encrypted_content: ENCRYPTED,
};

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

function encryptedReasoning(items: ResponseInput): unknown[] {
	return items.flatMap(item =>
		"type" in item && item.type === "reasoning" && "encrypted_content" in item ? [item.encrypted_content] : [],
	);
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

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** The items a Responses client keeps from the gateway's stream of one Codex turn: each `output_item.done`. */
async function streamedCodexTurn(): Promise<Record<string, unknown>[]> {
	const toolCall = { type: "toolCall" as const, id: "call_move|fc_upstream", name: "nh", arguments: { cmd: "l" } };
	const turn: AssistantMessage = {
		role: "assistant",
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-6-luna",
		content: [
			{
				type: "thinking",
				thinking: ROUTE_SUMMARY,
				thinkingSignature: JSON.stringify(CODEX_REASONING_ITEM),
				itemId: "rs_own",
			},
			toolCall,
		],
		usage: zeroUsage(),
		stopReason: "toolUse",
		timestamp: 0,
	};
	// The provider sets the signature when the upstream item is done.
	const streaming: AssistantMessage = {
		...turn,
		content: [{ type: "thinking", thinking: "", itemId: "rs_own" }],
	};
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...turn, content: [] } });
		stream.push({ type: "thinking_start", contentIndex: 0, partial: streaming });
		stream.push({ type: "thinking_delta", contentIndex: 0, delta: ROUTE_SUMMARY, partial: streaming });
		stream.push({ type: "thinking_end", contentIndex: 0, content: ROUTE_SUMMARY, partial: turn });
		stream.push({ type: "toolcall_start", contentIndex: 1, partial: turn });
		stream.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial: turn });
		stream.push({ type: "done", reason: "toolUse", message: turn });
	});
	const raw = await new Response(encodeStream(stream, "openai-codex/gpt-6-luna")).text();
	const items: Record<string, unknown>[] = [];
	for (const frame of raw.split("\n\n")) {
		const data = frame.split("\n").find(line => line.startsWith("data: {"));
		if (!data) continue;
		const event = JSON.parse(data.slice("data: ".length)) as { type: string; item?: Record<string, unknown> };
		if (event.type === "response.output_item.done" && event.item) items.push(event.item);
	}
	return items;
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

	it("replays the encrypted reasoning a Codex client kept from the gateway's stream", async () => {
		const { context } = parseResponsesRequest({
			model: "openai-codex/gpt-6-luna",
			include: ["reasoning.encrypted_content"],
			input: [
				{ type: "message", role: "user", content: [{ type: "input_text", text: "Find the down stairs." }] },
				...(await streamedCodexTurn()),
				{ type: "function_call_output", call_id: "call_move", output: "You see a staircase." },
				{ type: "message", role: "user", content: [{ type: "input_text", text: "Descend." }] },
			],
		});
		const input = convertCodexResponsesMessages(createCodexModel("gpt-6-luna"), context);

		expect(encryptedReasoning(input)).toEqual([ENCRYPTED]);
		const types = input.map(item => ("type" in item ? item.type : "message"));
		expect(types).toEqual(["message", "reasoning", "function_call", "function_call_output", "message"]);
		expect(assistantOutputTexts(input)).toEqual([]);
		expect(wireText(input)).not.toContain("<think>");
	});

	it("replays Codex's encrypted reasoning a Claude client sends back as a thinking signature", () => {
		const { context } = parseMessagesRequest({
			model: "openai-codex/gpt-6.1-sol",
			max_tokens: 1_000,
			messages: [
				{ role: "user", content: "Find the down stairs." },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: ROUTE_SUMMARY, signature: JSON.stringify(CODEX_REASONING_ITEM) },
						{ type: "tool_use", id: "toolu_move", name: "nh", input: { cmd: "l" } },
					],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "toolu_move", content: "You see a staircase." }],
				},
			],
		});
		const input = convertCodexResponsesMessages(createCodexModel("gpt-6.1-sol"), context);

		expect(encryptedReasoning(input)).toEqual([ENCRYPTED]);
		expect(assistantOutputTexts(input)).toEqual([]);
		expect(wireText(input)).not.toContain("<think>");
	});

	it("does not replay encrypted reasoning from a turn another provider produced", () => {
		const platformTurn: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: ROUTE_SUMMARY, thinkingSignature: JSON.stringify(CODEX_REASONING_ITEM) },
				{ type: "text", text: "Heading east." },
			],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-6-luna",
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: 0,
		};
		const input = convertCodexResponsesMessages(createCodexModel("gpt-6-luna"), {
			messages: [{ role: "user", content: "Find the down stairs.", timestamp: 0 }, platformTurn],
		});

		expect(encryptedReasoning(input)).toEqual([]);
		expect(wireText(input)).not.toContain(ROUTE_SUMMARY);
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

describe("auth-gateway replay of streamed reasoning to Anthropic", () => {
	it("drops a Codex client's reasoning summary instead of printing it as assistant text", () => {
		const { context } = parseResponsesRequest({
			model: "anthropic/claude-sonnet-5-5",
			input: [
				{ type: "message", role: "user", content: [{ type: "input_text", text: "Find the down stairs." }] },
				{ type: "reasoning", id: "rs_client", summary: [{ type: "summary_text", text: ROUTE_SUMMARY }] },
				{ type: "function_call", call_id: "call_move", name: "nh", arguments: '{"cmd":"l"}' },
				{ type: "function_call_output", call_id: "call_move", output: "You see a staircase." },
				{ type: "message", role: "user", content: [{ type: "input_text", text: "Descend." }] },
			],
		});
		const out = transformMessages(
			context.messages,
			makeModel("anthropic-messages", "anthropic", "claude-sonnet-5-5"),
		);
		const blocks = out.filter((m): m is AssistantMessage => m.role === "assistant").flatMap(m => m.content);

		expect(JSON.stringify(blocks)).not.toContain(ROUTE_SUMMARY);
		expect(blocks.map(block => block.type)).toEqual(["toolCall"]);
	});
});

/** Every item Codex receives for `context`, as `type` (and `:role` for messages); item ids, if any, follow `#`. */
async function codexWire(context: Context, model = createCodexModel("gpt-6-luna")): Promise<string[]> {
	const body = await buildTransformedCodexRequestBody(model, context, undefined);
	return (body.input ?? []).map(item => {
		const type = item.type ?? "message";
		const role = type === "message" ? `:${item.role}` : "";
		return `${type}${role}${item.id ? `#${item.id}` : ""}`;
	});
}

function responsesUser(text: string) {
	return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

describe("Codex reasoning reaches the wire only with the item it led to", () => {
	it("sends a Codex client's reasoning, commentary and call as one turn", async () => {
		const { context } = parseResponsesRequest({
			model: "openai-codex/gpt-6-luna",
			input: [
				responsesUser("Find the stairs."),
				CODEX_REASONING_ITEM,
				{
					type: "message",
					role: "assistant",
					id: "msg_own",
					phase: "commentary",
					content: [{ type: "output_text", text: "Looking around." }],
				},
				{ type: "function_call", id: "fc_own", call_id: "call_move", name: "nh", arguments: '{"cmd":"l"}' },
				{ type: "function_call_output", call_id: "call_move", output: "A staircase." },
			],
		});

		expect(context.messages.map(m => m.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(await codexWire(context)).toEqual([
			"message:user",
			"reasoning",
			"message:assistant",
			"function_call",
			"function_call_output",
		]);
	});

	it("sends a Codex client's reasoning with the final answer it led to", async () => {
		const { context } = parseResponsesRequest({
			model: "openai-codex/gpt-6-luna",
			input: [
				responsesUser("Hi."),
				CODEX_REASONING_ITEM,
				{
					type: "message",
					role: "assistant",
					id: "msg_own",
					phase: "final_answer",
					content: [{ type: "output_text", text: "Hello." }],
				},
				responsesUser("Next."),
			],
		});

		expect(await codexWire(context)).toEqual(["message:user", "reasoning", "message:assistant", "message:user"]);
	});

	it("leaves out a Codex client's reasoning whose call never reached it", async () => {
		const { context } = parseResponsesRequest({
			model: "openai-codex/gpt-6-luna",
			input: [responsesUser("Find the stairs."), CODEX_REASONING_ITEM, responsesUser("Continue.")],
		});

		expect(await codexWire(context)).toEqual(["message:user", "message:user"]);
	});

	it("leaves out a Claude client's thinking whose tool_use never reached it", async () => {
		const { context } = parseMessagesRequest({
			model: "openai-codex/gpt-6-luna",
			max_tokens: 1_000,
			messages: [
				{ role: "user", content: "Find the stairs." },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: ROUTE_SUMMARY, signature: JSON.stringify(CODEX_REASONING_ITEM) },
					],
				},
				{ role: "user", content: "Continue." },
			],
		});

		expect(await codexWire(context)).toEqual(["message:user", "message:user"]);
	});

	it("drops a cut thinking-only turn and keeps a later turn's reasoning", async () => {
		const later = { ...CODEX_REASONING_ITEM, id: "rs_later", encrypted_content: "later-encrypted-reasoning" };
		const { context } = parseMessagesRequest({
			model: "openai-codex/gpt-6-luna",
			max_tokens: 1_000,
			messages: [
				{ role: "user", content: "Find the stairs." },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: ROUTE_SUMMARY, signature: JSON.stringify(CODEX_REASONING_ITEM) },
					],
				},
				{ role: "user", content: "Continue." },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: MAP_SUMMARY, signature: JSON.stringify(later) },
						{ type: "tool_use", id: "toolu_move", name: "nh", input: { cmd: "l" } },
					],
				},
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_move", content: "A staircase." }] },
			],
		});
		const body = await buildTransformedCodexRequestBody(createCodexModel("gpt-6-luna"), context, undefined);

		expect(await codexWire(context)).toEqual([
			"message:user",
			"message:user",
			"reasoning",
			"function_call",
			"function_call_output",
		]);
		expect(encryptedReasoning((body.input ?? []) as ResponseInput)).toEqual(["later-encrypted-reasoning"]);
	});
});

const COMPLETED_SSE = `${[
	{ type: "response.output_text.delta", delta: "Down we go." },
	{
		type: "response.completed",
		response: {
			status: "completed",
			usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
		},
	},
]
	.map(event => `data: ${JSON.stringify(event)}`)
	.join("\n\n")}\n\n`;

function codexToken(accountId: string): string {
	const claims = { "https://api.openai.com/auth": { chatgpt_account_id: accountId } };
	return `aaa.${Buffer.from(JSON.stringify(claims), "utf8").toBase64()}.bbb`;
}

function requestInput(body: RequestInit["body"]): Record<string, unknown>[] {
	const text = typeof body === "string" ? body : new TextDecoder().decode(Bun.zstdDecompressSync(body as Uint8Array));
	return (JSON.parse(text) as { input: Record<string, unknown>[] }).input;
}

/**
 * A Codex account that refuses every request replaying {@link ENCRYPTED} (minted for another
 * account) with `refusal`, and records the reasoning each request carried.
 */
function codexBackend(refusal: () => Response, sentReasoning: unknown[][]): FetchImpl {
	return (async (input: string | URL, init?: RequestInit) => {
		if (!String(input).endsWith("/responses")) return new Response("not found", { status: 404 });
		const encrypted = requestInput(init?.body)
			.filter(item => item.type === "reasoning")
			.map(item => item.encrypted_content);
		sentReasoning.push(encrypted);
		if (encrypted.includes(ENCRYPTED)) return refusal();
		return new Response(COMPLETED_SSE, { headers: { "content-type": "text/event-stream" } });
	}) as FetchImpl;
}

/** A Codex client's next request on gpt-6.1-sol, replaying a turn whose reasoning another account or model minted. */
function sessionContext(extra: unknown[] = []): Context {
	return parseResponsesRequest({
		model: "openai-codex/gpt-6.1-sol",
		input: [
			responsesUser("Find the stairs."),
			CODEX_REASONING_ITEM,
			{ type: "function_call", call_id: "call_move", name: "nh", arguments: '{"cmd":"l"}' },
			{ type: "function_call_output", call_id: "call_move", output: "A staircase." },
			...extra,
			responsesUser("Descend."),
		],
	} as never).context;
}

describe("Codex rejecting replayed reasoning", () => {
	const model = createCodexModel("gpt-6.1-sol", { preferWebsockets: false });

	beforeEach(() => {
		vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("retries once without the reasoning and leaves it out for the rest of the session", async () => {
		const sent: unknown[][] = [];
		const providerSessionState = new Map<string, ProviderSessionState>();
		const rejection = () =>
			Response.json(
				{
					error: {
						message: "The encrypted content for item rs_own could not be verified.",
						type: "invalid_request_error",
						param: null,
						code: "invalid_encrypted_content",
					},
				},
				{ status: 400 },
			);
		const run = (context: Context) =>
			streamOpenAICodexResponses(model, context, {
				apiKey: codexToken("acct-b"),
				fetch: codexBackend(rejection, sent),
				providerSessionState,
			}).result();

		expect((await run(sessionContext())).stopReason).toBe("stop");
		expect(sent).toEqual([[ENCRYPTED], []]);

		// The next turn adds reasoning this account minted; only that one is sent.
		sent.length = 0;
		const ownTurn = [
			{ ...CODEX_REASONING_ITEM, id: "rs_new", encrypted_content: "minted-by-acct-b" },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Stairs found." }] },
		];
		expect((await run(sessionContext(ownTurn))).stopReason).toBe("stop");
		expect(sent).toEqual([["minted-by-acct-b"]]);
	});

	it("retries without the reasoning when the stream reports it lacks its following item", async () => {
		const sent: unknown[][] = [];
		const missingFollowingItem = () =>
			new Response(
				`data: ${JSON.stringify({
					type: "error",
					error: {
						type: "invalid_request_error",
						message: "Item 'rs_own' of type 'reasoning' was provided without its required following item.",
						param: "input",
					},
				})}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		const result = await streamOpenAICodexResponses(model, sessionContext(), {
			apiKey: codexToken("acct-b"),
			fetch: codexBackend(missingFollowingItem, sent),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(sent).toEqual([[ENCRYPTED], []]);
	});
});
