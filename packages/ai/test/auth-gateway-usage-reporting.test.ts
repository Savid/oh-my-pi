import { describe, expect, it } from "bun:test";
import { encodeResponse as encodeAnthropicResponse } from "@oh-my-pi/pi-ai/providers/anthropic-messages-server";
import {
	encodeResponse as encodeChatResponse,
	parseRequest as parseChatRequest,
} from "@oh-my-pi/pi-ai/providers/openai-chat-server";
import { applyProviderReportedCost, catalogCostEstimate } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai/types";

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 10,
		output: 20,
		cacheRead: 4,
		cacheWrite: 0,
		totalTokens: 34,
		cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0031 },
		...overrides,
	};
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-completions",
		provider: "openrouter",
		model: "test-model",
		usage: usage(),
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

const openrouter = { provider: "openrouter" } as const;

describe("auth-gateway usage: upstream-reported cost", () => {
	it("records OpenRouter's charge and rescales the catalog components to it", () => {
		const u = usage();
		applyProviderReportedCost(openrouter, u, { cost: 0.0062 });
		expect(u.reportedCost).toBe(0.0062);
		expect(u.cost.total).toBe(0.0062);
		expect(u.cost.input + u.cost.output + u.cost.cacheRead + u.cost.cacheWrite).toBeCloseTo(0.0062, 10);
		expect(catalogCostEstimate(u)).toBeUndefined();
	});

	it("adds the BYOK upstream inference cost to OpenRouter's credits charge", () => {
		const u = usage();
		applyProviderReportedCost(openrouter, u, {
			cost: 0.0001,
			is_byok: true,
			cost_details: { upstream_inference_cost: 0.002 },
		});
		expect(u.reportedCost).toBeCloseTo(0.0021, 10);
		expect(u.byokFee).toBeUndefined();
	});

	it("reports neither a charge nor an estimate for a BYOK fee without the inference cost", () => {
		const u = usage();
		applyProviderReportedCost(openrouter, u, { cost: 0, is_byok: true });
		expect(u.reportedCost).toBeUndefined();
		expect(u.byokFee).toBe(true);
		expect(catalogCostEstimate(u)).toBeUndefined();
	});

	it("ignores reported costs from providers other than OpenRouter-style ones", () => {
		const u = usage();
		applyProviderReportedCost({ provider: "anthropic" }, u, { cost: 9 });
		expect(u.reportedCost).toBeUndefined();
		expect(catalogCostEstimate(u)).toBe(0.0031);
	});
});

describe("auth-gateway usage: Chat Completions wire", () => {
	it("sends the upstream charge as usage.cost and no estimate", () => {
		const out = encodeChatResponse(assistant({ usage: usage({ reportedCost: 0.0062 }) }), "m");
		const wire = out.usage as Record<string, unknown>;
		expect(wire.cost).toBe(0.0062);
		expect(wire.estimated_cost).toBeUndefined();
	});

	it("sends the catalog price as usage.estimated_cost when no charge was reported", () => {
		const wire = encodeChatResponse(assistant(), "m").usage as Record<string, unknown>;
		expect(wire.cost).toBeUndefined();
		expect(wire.estimated_cost).toBe(0.0031);
	});

	it("omits both when the catalog has no price", () => {
		const unpriced = usage({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
		const wire = encodeChatResponse(assistant({ usage: unpriced }), "m").usage as Record<string, unknown>;
		expect(wire.cost).toBeUndefined();
		expect(wire.estimated_cost).toBeUndefined();
	});

	it("sends a reported zero cache write and omits an unreported one", () => {
		const reported = encodeChatResponse(assistant({ usage: usage({ cacheWriteReported: true }) }), "m");
		expect((reported.usage as { prompt_tokens_details: unknown }).prompt_tokens_details).toEqual({
			cached_tokens: 4,
			cache_write_tokens: 0,
		});
		const unreported = encodeChatResponse(assistant(), "m");
		expect((unreported.usage as { prompt_tokens_details: unknown }).prompt_tokens_details).toEqual({
			cached_tokens: 4,
		});
	});

	it("sends Anthropic's cache-write TTL split as usage.cache_creation", () => {
		const u = usage({ cacheWrite: 7, cttl: { ephemeral1h: 7 } });
		const wire = encodeChatResponse(assistant({ usage: u }), "m").usage as Record<string, unknown>;
		expect(wire.cache_creation).toEqual({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 7 });
	});
});

describe("auth-gateway usage: Anthropic Messages wire", () => {
	it("sends the TTL split, the reported charge and no estimate", () => {
		const u = usage({ cacheWrite: 7, cttl: { ephemeral5m: 3, ephemeral1h: 4 }, reportedCost: 0.01 });
		const out = encodeAnthropicResponse(assistant({ api: "anthropic-messages", usage: u }), "claude-test");
		expect(out.usage).toMatchObject({
			cache_creation_input_tokens: 7,
			cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 4 },
			cost: 0.01,
		});
		expect((out.usage as Record<string, unknown>).estimated_cost).toBeUndefined();
	});

	it("sends the catalog estimate when no charge was reported", () => {
		const out = encodeAnthropicResponse(assistant({ api: "anthropic-messages" }), "claude-test");
		expect((out.usage as Record<string, unknown>).estimated_cost).toBe(0.0031);
		expect((out.usage as Record<string, unknown>).cost).toBeUndefined();
	});
});

describe("auth-gateway Chat Completions: signed Anthropic thinking round trip", () => {
	it("emits signed and redacted thinking as reasoning_details and replays them", () => {
		const message = assistant({
			api: "anthropic-messages",
			provider: "anthropic",
			content: [
				{ type: "thinking", thinking: "plan the move", thinkingSignature: "sig-1" },
				{ type: "redactedThinking", data: "opaque" },
				{ type: "text", text: "done" },
			],
		});
		const choice = (encodeChatResponse(message, "claude-test").choices as Array<{ message: Record<string, unknown> }>)[0]!;
		expect(choice.message.reasoning_details).toEqual([
			{ type: "reasoning.text", text: "plan the move", signature: "sig-1", format: "anthropic-claude-v1", index: 0 },
			{ type: "reasoning.encrypted", data: "opaque", format: "anthropic-claude-v1", index: 1 },
		]);

		const parsed = parseChatRequest({
			model: "claude-test",
			messages: [
				{ role: "user", content: "go" },
				{ role: "assistant", content: "done", reasoning_details: choice.message.reasoning_details },
				{ role: "user", content: "again" },
			],
		});
		const replayed = parsed.context.messages[1] as AssistantMessage;
		expect(replayed.content).toEqual([
			{ type: "thinking", thinking: "plan the move", thinkingSignature: "sig-1" },
			{ type: "redactedThinking", data: "opaque" },
			{ type: "text", text: "done" },
		]);
	});

	it("does not emit reasoning_details for non-Anthropic messages", () => {
		const message = assistant({
			content: [{ type: "thinking", thinking: "t", thinkingSignature: "reasoning_content" }],
		});
		const choice = (encodeChatResponse(message, "m").choices as Array<{ message: Record<string, unknown> }>)[0]!;
		expect(choice.message.reasoning_details).toBeUndefined();
		expect(choice.message.reasoning_content).toBe("t");
	});

	it("ignores unsigned or foreign-format reasoning_details on replay", () => {
		const parsed = parseChatRequest({
			model: "m",
			messages: [
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: "done",
					reasoning_details: [
						{ type: "reasoning.text", text: "no sig", format: "anthropic-claude-v1" },
						{ type: "reasoning.text", text: "other", signature: "s", format: "openai-responses-v1" },
					],
				},
				{ role: "user", content: "again" },
			],
		});
		expect((parsed.context.messages[1] as AssistantMessage).content).toEqual([{ type: "text", text: "done" }]);
	});
});
