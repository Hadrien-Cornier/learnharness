import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type Usage } from "@earendil-works/pi-ai";
import { withAgentRetry, isRetryableAgentFailure } from "../src/agent/subagents/retry.ts";
import { runResearcherAgent } from "../src/agent/subagents/researcher.ts";
import { runDemoBuilder } from "../src/agent/subagents/demo-builder.ts";
import { runVisualMaker } from "../src/agent/subagents/visual-maker.ts";
import { runPdfReaderAgent } from "../src/agent/subagents/pdf-reader.ts";
import type { HeadlessApi } from "../src/agent/subagents/headless.ts";

const overloaded = '429: {"message":"Provider returned error","code":429,"metadata":{"raw":"xiaomi/mimo-v2.6-pro is temporarily rate-limited upstream. Please retry shortly, or add your own provider key to use your own limits","provider_name":"DeepInfra","provider_error_code":"engine_overloaded","limit_source":"upstream_provider_shared_pool"}}';
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==", "base64");
const headless: HeadlessApi = {
	available: () => true, unavailableReason: () => null,
	runDemo: async () => ({ ok: true, consoleErrors: [], pageErrors: [], failedRequests: [] }),
	renderSvg: async () => PNG,
	renderPdfPages: async (_file, pages) => pages.map(page => ({ page, png: PNG })),
};

describe("shared background retry policy", () => {
	it("recognizes the actual provider overload and rejects permanent failures", () => {
		assert.equal(isRetryableAgentFailure(overloaded), true);
		for (const reason of ["401 Unauthorized", "429 quota exceeded", "429 insufficient_quota", "429 FreeUsageLimitError", "out of budget", "Monthly usage limit reached", "subscription_sharing_daily_usage_limit_exceeded", "402 insufficient credits", "No model configured", "content_filter", "Aborted by learner", "PDF file not found", "context_length_exceeded"]) {
			assert.equal(isRetryableAgentFailure(reason), false, reason);
		}
	});

	it("caps both thrown and returned failures at three attempts", async () => {
		for (const throwing of [true, false]) {
			let calls = 0;
			const operation = async () => { calls++; if (throwing) throw new Error(overloaded); return { error: overloaded }; };
			const promise = withAgentRetry(operation, value => value.error, { retryDelaysMs: [0, 0, 0, 0] });
			if (throwing) await assert.rejects(promise, /429/);
			else assert.equal((await promise).error, overloaded);
			assert.equal(calls, 3);
		}
	});

	it("cancels either wait and never starts another attempt", async () => {
		for (const cancelAt of [1, 2]) {
			let calls = 0;
			const controller = new AbortController();
			const result = await withAgentRetry(async () => { calls++; return "Connection error."; }, value => value, {
				retryDelaysMs: [0, 0], abortSignal: controller.signal,
				onActivity: line => { if (line.startsWith(`Automatic retry ${cancelAt}/`)) controller.abort(); },
			});
			assert.equal(result, "Connection error.");
			assert.equal(calls, cancelAt);
		}
	});
});

describe("all four agents recover from the actual provider overload", () => {
	for (const kind of ["research", "demo", "visual", "pdf"] as const) {
		it(kind, async () => {
			const faux = createFauxCore({ tokenSize: { min: 1024, max: 1024 } });
			const usage: Usage[] = [];
			const failures = kind === "research" ? 2 : 1;
			const replies = Array.from({ length: failures }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage: overloaded }));
			if (kind === "demo") replies.push(fauxAssistantMessage([fauxToolCall("write_demo", { html: "<!doctype html><html><body>Fixture</body></html>" }, { id: "w" }), fauxToolCall("run_demo", {}, { id: "r" })], { stopReason: "toolUse" }));
			if (kind === "visual") replies.push(fauxAssistantMessage([fauxToolCall("write_svg", { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>' }, { id: "w" }), fauxToolCall("render_svg", {}, { id: "r" })], { stopReason: "toolUse" }));
			if (kind === "pdf") replies.push(fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "1" }, { id: "p" })], { stopReason: "toolUse" }));
			replies.push(fauxAssistantMessage("Verified fixture brief (p. 1)."));
			faux.setResponses(replies);
			let attempts = 0;
			let requests = 0;
			const opts = {
				engine: { model: faux.getModel(), streamFn: ((...args) => { requests++; return faux.streamSimple(...args); }) as typeof faux.streamSimple },
				headless, retryDelaysMs: [0, 0], onUsage: (step: Usage) => usage.push(step), onActivity: (line: string) => { if (line.startsWith("Automatic retry")) attempts++; },
			};
			const result = kind === "research" ? await runResearcherAgent("Synthetic research", opts)
				: kind === "demo" ? await runDemoBuilder({ title: "Fixture", brief: "Synthetic demo" }, opts)
				: kind === "visual" ? await runVisualMaker({ brief: "Synthetic figure" }, opts)
				: await runPdfReaderAgent({ path: path.join(import.meta.dirname, "fixtures/sample-3page.pdf"), question: "Read page 1" }, opts);
			assert.equal(attempts, failures);
			assert.equal(requests, failures + (kind === "research" ? 1 : 2));
			assert.equal(usage.length, requests, "all admitted model calls contribute usage, including failed attempts");
			assert.ok(usage.reduce((sum, step) => sum + step.input + step.output, 0) > 0);
			if (typeof result === "string") assert.match(result, /Verified fixture/);
			else if ("html" in result) assert.ok(result.html);
			else if ("svg" in result) assert.ok(result.svg);
			else { assert.match(result.brief, /Verified fixture/); assert.deepEqual(result.pagesConsulted, [1]); }
		});
	}

	it("research retries an unfinished final tool turn instead of returning partial text", async () => {
		const faux = createFauxCore({ tokenSize: { min: 1024, max: 1024 } });
		faux.setResponses([
			fauxAssistantMessage([ { type: "text", text: "Still researching" }, fauxToolCall("web_search", { query: "fixture" }, { id: "s" }) ], { stopReason: "toolUse" }),
			fauxAssistantMessage("Final brief."),
		]);
		let attempts = 0;
		const result = await runResearcherAgent("Question", { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, maxTurns: 1, retryDelaysMs: [0, 0], onAttempt: () => { attempts++; } });
		assert.equal(result, "Final brief.");
		assert.equal(attempts, 2);
	});
});
