/**
 * Replayed reasoning the Codex backend refuses.
 *
 * A request replays earlier turns' reasoning items with their
 * `encrypted_content`. When the backend refuses one (content minted for
 * another account after a usage-limit or auth failover, or an item without the
 * output item it led to) it fails the whole request: 400
 * `invalid_encrypted_content`, or "…was provided without its required
 * following item". Nothing in the replayed history says which account minted
 * an item, so the request is replayed once without any reasoning, and the
 * refused items are remembered for the session so later turns leave them out
 * instead of failing on them again.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { InputItem, RequestBody } from "./request-transformer";

const REJECTION_CODES: Readonly<Record<string, true>> = {
	invalid_encrypted_content: true,
};
/** "The encrypted content for item rs_… could not be verified." and the missing-following-item rejection. */
const REJECTION_PATTERN = /\bencrypted content\b.*\bcould not be\b|\bwithout its required following item\b/i;

/** Hashes of the `encrypted_content` a session's requests carried when the backend rejected them. */
export type RejectedCodexReasoning = Set<string>;

function encryptedContentKey(item: InputItem): string | undefined {
	if (item.type !== "reasoning" || !("encrypted_content" in item)) return undefined;
	const encrypted = item.encrypted_content;
	return typeof encrypted === "string" && encrypted.length > 0 ? Bun.hash(encrypted).toString(36) : undefined;
}

/** Leave out of `body` the reasoning items an earlier request of this session had rejected. */
export function dropRememberedRejectedCodexReasoning(
	body: RequestBody,
	rejected: RejectedCodexReasoning | undefined,
): void {
	if (!rejected?.size || !body.input) return;
	body.input = body.input.filter(item => {
		const key = encryptedContentKey(item);
		return key === undefined || !rejected.has(key);
	});
}

/**
 * Strip every reasoning item from `body` when `error` is the backend rejecting
 * replayed reasoning, remembering their content in `rejected`. Returns `true`
 * when the caller should replay the request; at most once per body, since no
 * reasoning is left to strip.
 */
export function dropRejectedCodexReasoning(
	body: RequestBody,
	error: unknown,
	rejected: RejectedCodexReasoning | undefined,
): boolean {
	if (!body.input?.some(item => item.type === "reasoning") || !isReplayedReasoningRejection(error)) return false;
	for (const item of body.input) {
		const key = encryptedContentKey(item);
		if (key !== undefined) rejected?.add(key);
	}
	body.input = body.input.filter(item => item.type !== "reasoning");
	logger.warn("Codex rejected the replayed reasoning; retrying without it", {
		model: body.model,
		error: error instanceof Error ? error.message : String(error),
	});
	return true;
}

function isReplayedReasoningRejection(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
	if (code !== undefined && Object.hasOwn(REJECTION_CODES, code)) return true;
	return REJECTION_PATTERN.test(error.message);
}
