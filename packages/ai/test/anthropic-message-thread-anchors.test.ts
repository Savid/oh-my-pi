/**
 * What a session's thread anchor keeps between requests. An anchor outlives
 * its request, so it must not pin the conversation: a gateway retains one per
 * conversation it serves, and an agent conversation with screenshots runs to
 * tens of megabytes.
 */
import { describe, expect, it } from "bun:test";
import {
	type AnthropicThreadChain,
	AnthropicThreadTurn,
	messageDigest,
} from "@oh-my-pi/pi-ai/providers/anthropic-threads";
import type { MessageCreateParamsStreaming, MessageParam } from "@oh-my-pi/pi-ai/providers/anthropic-wire";

const SCREENSHOT = "A".repeat(2_000_000);

function params(messages: MessageParam[]): MessageCreateParamsStreaming {
	return { model: "claude-opus-5-5", max_tokens: 1024, stream: true, messages };
}

describe("messageDigest", () => {
	it("ignores cache breakpoints and key order", () => {
		const plain: MessageParam = {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "out" }] }],
		};
		const marked: MessageParam = {
			content: [
				{
					content: [{ text: "out", type: "text" }],
					tool_use_id: "t1",
					type: "tool_result",
					cache_control: { type: "ephemeral" },
				},
			],
			role: "user",
		};
		expect(messageDigest(marked)).toBe(messageDigest(plain));
	});

	it("digests string content like the lone text block caching rewrites it into", () => {
		expect(messageDigest({ role: "user", content: "hi" })).toBe(
			messageDigest({ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }),
		);
	});

	it("tells apart messages that differ in role or content", () => {
		const base = messageDigest({ role: "user", content: "hi" });
		expect(messageDigest({ role: "assistant", content: "hi" })).not.toBe(base);
		expect(messageDigest({ role: "user", content: "hi!" })).not.toBe(base);
		expect(
			messageDigest({
				role: "user",
				content: [
					{ type: "text", text: "hi" },
					{ type: "text", text: "" },
				],
			}),
		).not.toBe(base);
	});
});

describe("AnthropicThreadTurn anchors", () => {
	it("keeps digests, not the conversation, and still continues it", () => {
		const chain: AnthropicThreadChain = { refusedContinues: 0, disabled: false };
		const first: MessageParam[] = [
			{
				role: "user",
				content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: SCREENSHOT } }],
			},
		];
		const reply: MessageParam = { role: "assistant", content: [{ type: "text", text: "seen" }] };

		const turn = new AnthropicThreadTurn(chain, { resendSystemAndTools: false });
		expect(turn.plan(params(first), "", 1_000)?.kind).toBe("create");
		turn.settle({ messageId: "msg_1", message: reply }, 1_000);

		expect(chain.anchor?.messageId).toBe("msg_1");
		expect(JSON.stringify(chain.anchor).length).toBeLessThan(1_000);

		// The next request carries the conversation again, the screenshot as a fresh copy.
		const again: MessageParam[] = [
			{
				role: "user",
				content: [
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: `${SCREENSHOT.slice(0, -1)}A` },
					},
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "seen", cache_control: { type: "ephemeral" } }] },
			{ role: "user", content: "next" },
		];
		const next = new AnthropicThreadTurn(chain, { resendSystemAndTools: false }).plan(params(again), "", 2_000);
		expect(next?.kind).toBe("continue");
		expect(next?.body.messages).toHaveLength(1);
		expect(next?.body.thread).toEqual({ type: "continue", previous_message_id: "msg_1" });
	});

	it("starts a new thread when an earlier message changed", () => {
		const chain: AnthropicThreadChain = { refusedContinues: 0, disabled: false };
		const turn = new AnthropicThreadTurn(chain, { resendSystemAndTools: false });
		turn.plan(params([{ role: "user", content: "first" }]), "", 1_000);
		turn.settle({ messageId: "msg_1", message: { role: "assistant", content: "ok" } }, 1_000);

		const edited = new AnthropicThreadTurn(chain, { resendSystemAndTools: false }).plan(
			params([
				{ role: "user", content: "first, edited" },
				{ role: "assistant", content: "ok" },
				{ role: "user", content: "next" },
			]),
			"",
			2_000,
		);
		expect(edited?.kind).toBe("create");
	});
});
