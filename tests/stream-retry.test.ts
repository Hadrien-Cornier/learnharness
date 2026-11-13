import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream, createFauxCore, normalizeContext, type AssistantMessage, type StreamFunction, type Usage } from "@earendil-works/pi-ai";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";
import { retrySubagentStream } from "../src/agent/subagents/stream-retry.ts";

const model = createFauxCore({}).getModel();
function message(stopReason: AssistantMessage["stopReason"], tokens = 1, errorMessage?: string, tool = false): AssistantMessage {
	return {
		role: "assistant", api: model.api, provider: model.provider, model: model.id,
		content: tool ? [{ type: "toolCall", id: "call-submit", name: "submit", arguments: {} }] : [{ type: "text", text: "accepted" }],
		usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason, errorMessage, timestamp: Date.now(),
	};
}
function assertRetryOptions(current: Parameters<StreamFunction>[2], previous: Parameters<StreamFunction>[2]) {
	assert.ok(current && previous);
	const { signal: currentSignal, ...currentOptions } = current;
	const { signal: previousSignal, ...previousOptions } = previous;
	assert.deepEqual(currentOptions, previousOptions);
	assert.notEqual(currentSignal, previousSignal);
	assert.equal(previousSignal?.aborted, true);
	assert.equal(currentSignal?.aborted, false);
}

function terminal(value: AssistantMessage, partial = false) {
	const stream = createAssistantMessageEventStream();
	if (partial) {
		stream.push({ type: "start", partial: value });
		stream.push({ type: "toolcall_start", contentIndex: 0, partial: value });
	}
	if (value.stopReason === "error" || value.stopReason === "aborted") stream.push({ type: "error", reason: value.stopReason, error: value });
	else stream.push({ type: "done", reason: value.stopReason as "stop" | "toolUse", message: value });
	return stream;
}

for (const role of ["extractor", "auditor", "researcher"] as const) {
	test(`${role}: a failed partial tool call retries the same request and executes the accepted tool once`, async () => {
		let calls = 0;
		let executions = 0;
		const usages: Usage[] = [];
		const messages: { message: AssistantMessage; step: number }[] = [];
		let first: Parameters<StreamFunction> | undefined;
		const streamFn: StreamFunction = (...args) => {
			calls++;
			if (!first) first = args;
			else { assert.equal(args[0], first[0]); assert.equal(args[1], first[1]); assertRetryOptions(args[2], first[2]); }
			return terminal(calls === 1 ? message("error", 3, "503 overloaded", true) : message("toolUse", 7, undefined, true), true);
		};
		const result = await runSubagent([{
			name: "submit", label: "Submit", description: "Submit result",
			parameters: { type: "object", properties: {} } as any,
			execute: async () => { executions++; return { content: [{ type: "text", text: "saved" }], details: {} }; },
		}], {
			role, engine: { model, streamFn }, systemPrompt: "Test", prompt: "Submit", maxTurns: 1,
			retryDelaysMs: [0, 0], onUsage: (usage) => usages.push(usage),
			onAssistantMessage: (value, step) => messages.push({ message: value, step }),
		});
		assert.equal(calls, 2); assert.equal(executions, 1);
		assert.deepEqual(usages.map((usage) => usage.input), [3, 7]);
		assert.deepEqual(messages.map(({ step }) => step), [1, 2]);
		assert.equal(messages[0]!.message.content.some((block) => block.type === "toolCall"), false);
		assert.equal(messages[1]!.message.content.some((block) => block.type === "toolCall"), true);
		assert.equal(result.newMessages.filter((value) => value.role === "assistant").length, 1);
	});
}

test("the provider retry cap emits one terminal error and accounts for each attempt once", async () => {
	let calls = 0;
	const discarded: AssistantMessage[] = [];
	const stream = retrySubagentStream(() => terminal(message("error", ++calls, "429 rate limit", true), true), {
		retryDelaysMs: [0, 0, 0], onDiscardedMessage: (value) => discarded.push(value),
	})(model, normalizeContext({ messages: [] }));
	const events = [];
	for await (const event of stream) events.push(event);
	assert.equal(calls, 3);
	assert.deepEqual(discarded.map((value) => value.usage.input), [1, 2]);
	assert.equal(events.length, 1); assert.equal(events[0]!.type, "error");
	assert.equal((await stream.result()).usage.input, 3);
});

test("permanent failures and explicit opt-out make one provider request", async () => {
	for (const opts of [{ reason: "401 unauthorized", retryProviderCalls: true }, { reason: "503 overloaded", retryProviderCalls: false }]) {
		let calls = 0;
		await assert.rejects(runSubagent([], {
			role: "extractor", engine: { model, streamFn: () => { calls++; return terminal(message("error", 1, opts.reason)); } },
			systemPrompt: "Test", prompt: "Test", maxTurns: 1, retryDelaysMs: [0, 0], retryProviderCalls: opts.retryProviderCalls,
		}), new RegExp(opts.reason));
		assert.equal(calls, 1);
	}
});

test("cancellation during backoff prevents another request and keeps failed usage", async () => {
	const controller = new AbortController();
	let calls = 0;
	const usages: number[] = [];
	const run = runSubagent([], {
		role: "auditor", engine: { model, streamFn: () => { calls++; return terminal(message("error", 4, "503 overloaded")); } },
		systemPrompt: "Test", prompt: "Test", maxTurns: 1, abortSignal: controller.signal, retryDelaysMs: [1000, 1000],
		onUsage: (usage) => { usages.push(usage.input); setTimeout(() => controller.abort(), 10); },
	});
	await assert.rejects(run, (error: Error) => error.name === "AbortError");
	assert.equal(calls, 1); assert.deepEqual(usages, [4]);
});

test("a pre-aborted run stops before engine resolution or provider requests", async () => {
	const controller = new AbortController(); controller.abort();
	await assert.rejects(runSubagent([], { role: "extractor", systemPrompt: "Test", prompt: "Test", maxTurns: 1, abortSignal: controller.signal }),
		(error: Error) => error.name === "AbortError" && error.message === "aborted");
});

test("retrying a later request preserves prior collector results without executing the collector again", async () => {
	let calls = 0;
	let collected = 0;
	let submitted = 0;
	let failedArgs: Parameters<StreamFunction> | undefined;
	const streamFn: StreamFunction = (...args) => {
		calls++;
		if (calls === 1) {
			const value = message("toolUse", 2, undefined, true);
			value.content = [{ type: "toolCall", id: "collect-once", name: "collect", arguments: {} }];
			return terminal(value);
		}
		assert.ok(args[1].messages.some((value) => value.role === "toolResult" && value.toolName === "collect"));
		if (!failedArgs) failedArgs = args;
		else { assert.equal(args[1], failedArgs[1]); assertRetryOptions(args[2], failedArgs[2]); }
		return terminal(calls === 2 ? message("error", 3, "503 overloaded", true) : message("toolUse", 5, undefined, true));
	};
	const result = await runSubagent(["collect", "submit"].map((name) => ({
		name, label: name, description: name, parameters: { type: "object", properties: {} } as any,
		execute: async () => { if (name === "collect") collected++; else submitted++; return { content: [{ type: "text" as const, text: "saved" }], details: {} }; },
	})), { role: "extractor", engine: { model, streamFn }, systemPrompt: "Test", prompt: "Test", maxTurns: 2, retryDelaysMs: [0, 0] });
	assert.equal(calls, 3); assert.equal(collected, 1); assert.equal(submitted, 1);
	assert.equal(result.newMessages.filter((value) => value.role === "assistant").length, 2);
});

test("an exhausted run records each failed request once through both callbacks", async () => {
	let calls = 0;
	const usage: number[] = [];
	const logged: number[] = [];
	await assert.rejects(runSubagent([], {
		role: "auditor", engine: { model, streamFn: () => terminal(message("error", ++calls, "503 overloaded", true), true) },
		systemPrompt: "Test", prompt: "Test", maxTurns: 1, retryDelaysMs: [0, 0],
		onUsage: (value) => usage.push(value.input),
		onAssistantMessage: (value, step) => { logged.push(step); assert.equal(value.content.some((block) => block.type === "toolCall"), false); },
	}), /503 overloaded/);
	assert.equal(calls, 3); assert.deepEqual(usage, [1, 2, 3]); assert.deepEqual(logged, [1, 2, 3]);
});

test("a synchronous temporary provider exception retries without changing request options", async () => {
	let calls = 0;
	const options = { signal: new AbortController().signal };
	const stream = retrySubagentStream((_model, _context, current) => {
		assert.equal(current, options);
		if (++calls === 1) throw new Error("fetch failed");
		return terminal(message("stop", 6));
	}, { retryDelaysMs: [0, 0] })(model, normalizeContext({ messages: [] }), options);
	for await (const _event of stream) { /* Drain the accepted terminal. */ }
	assert.equal(calls, 2); assert.equal((await stream.result()).stopReason, "stop");
});


test("a silent provider end retries within the cap and retains partial usage", { timeout: 1000 }, async () => {
	let calls = 0;
	const discarded: number[] = [];
	const stream = retrySubagentStream(() => {
		calls++;
		const source = createAssistantMessageEventStream();
		source.push({ type: "start", partial: message("pending", calls, undefined, true) });
		source.end();
		return source;
	}, { retryDelaysMs: [0, 0], onDiscardedMessage: (value) => discarded.push(value.usage.input) })(model, normalizeContext({ messages: [] }));
	const events = [];
	for await (const event of stream) events.push(event);
	assert.equal(calls, 3);
	assert.deepEqual(discarded, [1, 2]);
	assert.equal(events.length, 1);
	const final = await stream.result();
	assert.equal(final.stopReason, "error");
	assert.equal(final.errorMessage, "Stream ended without a result");
	assert.equal(final.usage.input, 3);
});
