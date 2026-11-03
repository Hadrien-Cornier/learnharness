import { setTimeout as delay } from "node:timers/promises";

/** One retry policy for the four background job kinds. */
export interface AgentRetryOptions {
	abortSignal?: AbortSignal;
	onActivity?: (line: string) => void;
	/** Test seam. Production uses 5 and 15 seconds; at most two retries. */
	retryDelaysMs?: readonly number[];
}

export function isRetryableAgentFailure(reason: string): boolean {
	// Provider remedies may mention keys even for a temporary shared-pool 429.
	// Reject actual credential/billing failures, not arbitrary mentions of keys.
	if (/\b(?:400|401|402|403|404)\b|\babort(?:ed)?\b|\bcancel(?:led|ed)?\b|content_filter|content filter|safety refusal|unauthorized|forbidden|invalid api.?key|missing api.?key|no provider key|not configured|insufficient (?:credits|funds|balance)|quota exceeded|insufficient_quota|FreeUsageLimitError|out of budget|monthly usage limit|usage_limit_exceeded|available balance|billing|payment required|context length|context_length_exceeded|ENOENT|EACCES|no such file|not a PDF/i.test(reason)) return false;
	return /\b(?:408|429|500|502|503|504)\b|rate.?limit|engine_overloaded|overload|temporar|timed? ?out|timeout|ECONNRESET|ETIMEDOUT|fetch failed|connection error|connection reset|connection closed|stream ended without a result|iteration limit|max(?:imum)? (?:turns|steps|iterations)|turn limit|never passed headless verification|produced no text/i.test(reason);
}

/** Fresh attempts share usage callbacks and cancellation, but never deliver
 * intermediate failures. Permanent failures remain available for manual retry.
 */
export async function withAgentRetry<T>(
	operation: () => Promise<T>,
	failureOf: (result: T) => string | undefined,
	opts: AgentRetryOptions,
): Promise<T> {
	const waits = (opts.retryDelaysMs ?? [5_000, 15_000]).slice(0, 2);
	for (let attempt = 0; ; attempt++) {
		let result: T | undefined;
		let thrown: unknown;
		let didThrow = false;
		let reason: string | undefined;
		try {
			result = await operation();
			reason = failureOf(result);
		} catch (error) {
			didThrow = true;
			thrown = error;
			reason = error instanceof Error ? error.message : String(error);
		}
		if (!reason || opts.abortSignal?.aborted || attempt >= waits.length || !isRetryableAgentFailure(reason)) {
			if (didThrow) throw thrown;
			return result as T;
		}
		opts.onActivity?.(`Automatic retry ${attempt + 1}/${waits.length} in ${waits[attempt]! / 1000}s`);
		try {
			await delay(waits[attempt], undefined, { signal: opts.abortSignal });
			if (opts.abortSignal?.aborted) {
				if (didThrow) throw thrown;
				return result as T;
			}
		} catch {
			if (didThrow) throw thrown;
			return result as T;
		}
	}
}
