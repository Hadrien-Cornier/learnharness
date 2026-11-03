import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream, type AssistantMessage, type StreamFunction } from "@earendil-works/pi-ai";
import { isRetryableAgentFailure } from "./retry.ts";

export interface StreamRetryOptions {
	/** Failed requests still contribute to the caller's usage ledger. */
	onDiscardedMessage?: (message: AssistantMessage) => void;
	/** Test seam. Production permits two retries after 5 and 15 seconds. */
	retryDelaysMs?: readonly number[];
}

/** Retry one provider request with its original context and options. Only a
 * final response reaches Agent, so failed partial tool calls cannot execute.
 */
export function retrySubagentStream(streamFn: StreamFunction, opts: StreamRetryOptions = {}): StreamFunction {
	return (model, context, options) => {
		const output = createAssistantMessageEventStream();
		const waits = (opts.retryDelaysMs ?? [5_000, 15_000]).slice(0, 2);
		const failure = (error: unknown, aborted = false): AssistantMessage => ({
			role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: aborted ? "aborted" : "error", errorMessage: aborted ? "aborted" : error instanceof Error ? error.message : String(error), timestamp: Date.now(),
		});
		const finish = (message: AssistantMessage) => {
			if (message.stopReason === "pending") message = { ...message, stopReason: "error", errorMessage: "Stream ended without a result" };
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				output.push({ type: "error", reason: message.stopReason, error: message });
			} else {
				output.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse" | "deferred", message });
			}
		};
		void (async () => {
			for (let attempt = 0; ; attempt++) {
				if (options?.signal?.aborted) { finish(failure("aborted", true)); return; }
				let message: AssistantMessage;
				let partial: AssistantMessage | undefined;
				let terminal: AssistantMessage | undefined;
				try {
					const stream = streamFn(model, context, options);
					// Drain the provider even when its terminal message arrives first.
					for await (const event of stream) {
						if ("partial" in event) partial = event.partial;
						else terminal = event.type === "done" ? event.message : event.error;
					}
					// An empty end() never resolves result(). Use only observed terminals.
					message = terminal ?? { ...(partial ?? failure("Stream ended without a result")),
						stopReason: "error", errorMessage: "Stream ended without a result" };
				} catch (error) {
					const terminal = failure(error, options?.signal?.aborted || (error instanceof Error && error.name === "AbortError"));
					message = partial ? { ...partial, stopReason: terminal.stopReason, errorMessage: terminal.errorMessage } : terminal;
				}
				if (message.stopReason === "pending") message = { ...message, stopReason: "error", errorMessage: "Stream ended without a result" };
				if (message.stopReason !== "error" || options?.signal?.aborted || attempt >= waits.length ||
					!isRetryableAgentFailure(message.errorMessage ?? "")) {
					finish(message); return;
				}
				opts.onDiscardedMessage?.(message);
				try {
					await delay(waits[attempt], undefined, { signal: options?.signal });
				} catch {
					finish(failure("aborted", true)); return;
				}
			}
		})().catch((error) => finish(failure(error, options?.signal?.aborted)));
		return output;
	};
}
