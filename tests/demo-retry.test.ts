import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { JobRetryError, retryDemoJob, retryJob, setJobRespawn } from "../src/server/jobs.ts";
import type { JobKind } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const chats: string[] = [];
const input = { title: "Policy gradient", brief: "Compare the two gradient estimators with a mean slider." };
function fixture(savedInput: unknown = input, kind: JobKind = "demo") {
	const chat = chatStore.createChat("Test: retry failed demo");
	chats.push(chat.id);
	const job = jobStore.createJob({ chatId: chat.id, toolCallId: "call-demo", kind, input: savedInput });
	jobStore.updateJob(job.id, {
		status: "error", activity: "failed", error: "Provider error",
		result: { title: input.title, html: "", notes: "FAILED: Provider error", tested: true },
		delivery: { kind: "result", status: "pending" },
	});
	return { chat, job: jobStore.getJob(job.id)! };
}
function fails(action: () => unknown, status: number) {
	assert.throws(action, (error: unknown) => error instanceof JobRetryError && error.status === status);
}
afterEach(() => {
	setJobRespawn(undefined);
	for (const chatId of chats.splice(0)) {
		jobStore.deleteJobsForChat(chatId);
		chatStore.deleteChat(chatId);
	}
});

describe("failed job retry", () => {
	const cases: [JobKind, Record<string, unknown>][] = [
		["research", { question: "Which estimator has lower variance?", context: "Compare their variance.", source: "saved context" }],
		["pdf", { path: "/tmp/gradient-notes.pdf", question: "", source: "saved PDF" }],
		["visual", { brief: "Compare the estimators.", source: "saved figure" }],
		["demo", { ...input, source: "saved demo" }],
	];
	for (const [kind, originalInput] of cases) {
		it(`preserves every saved ${kind} field and deduplicates its retry`, () => {
			const { chat, job } = fixture(originalInput, kind);
			const foreign = chatStore.createChat("Test: foreign retry"); chats.push(foreign.id);
			const started: string[] = [];
			setJobRespawn((id) => started.push(id));
			fails(() => retryJob(foreign.id, job.id), 404);
			const retry = retryJob(chat.id, job.id);
			assert.equal(retry.kind, kind);
			assert.equal(retry.status, "running");
			assert.equal(retry.retryOf, job.id);
			assert.equal(retry.toolCallId, job.toolCallId);
			assert.deepEqual(retry.input, originalInput);
			assert.equal(retry.error, undefined);
			assert.equal(retry.result, undefined);
			assert.equal(retry.delivery, undefined);
			assert.deepEqual(jobStore.getJob(job.id), job);
			assert.equal(retryJob(chat.id, job.id).id, retry.id);
			assert.deepEqual(started, [retry.id]);
		});

		it(`recovers legacy ${kind} arguments and returns one successor through POST`, async () => {
			const { POST } = await import("../app/api/jobs/route.ts");
			const { chat, job } = fixture(originalInput, kind);
			jobStore.updateJob(job.id, { input: undefined });
			chatStore.saveMessages(chat.id, [{
				id: `assistant-${kind}`, role: "assistant", content: [{ type: "toolCall", id: job.toolCallId, name: kind, arguments: originalInput }],
				timestamp: 1,
			} as unknown as LhMessage]);
			const started: string[] = [];
			setJobRespawn((id) => started.push(id));
			const request = () => new Request("http://localhost/api/jobs", { method: "POST", body: JSON.stringify({ chatId: chat.id, jobId: job.id }) });
			const response = await POST(request());
			assert.equal(response.status, 200);
			const first = (await response.json()).job;
			assert.equal(first.kind, kind);
			assert.deepEqual(first.input, originalInput);
			assert.equal((await (await POST(request())).json()).job.id, first.id);
			assert.deepEqual(started, [first.id]);
		});
	}

	it("accepts an omitted or empty research context", () => {
		setJobRespawn(() => {});
		for (const saved of [{ question: "Which estimator?" }, { question: "Which estimator?", context: "" }]) {
			const { chat, job } = fixture(saved, "research");
			assert.deepEqual(retryJob(chat.id, job.id).input, saved);
		}
	});

	it("rejects malformed research and PDF inputs without creating attempts", () => {
		let starts = 0;
		setJobRespawn(() => { starts++; });
		const invalid: [JobKind, unknown][] = [
			["research", null], ["research", {}], ["research", { question: " " }],
			["research", { question: 42 }], ["research", { question: "Question", context: null }],
			["research", { question: "Question", context: 42 }],
			["pdf", null], ["pdf", {}], ["pdf", { path: " ", question: "Question" }],
			["pdf", { path: 42, question: "Question" }], ["pdf", { path: "/tmp/paper.pdf" }],
			["pdf", { path: "/tmp/paper.pdf", question: 42 }],
		];
		for (const [kind, saved] of invalid) {
			const { chat, job } = fixture(saved, kind);
			fails(() => retryJob(chat.id, job.id), 409);
			assert.equal(jobStore.listJobs(chat.id).length, 1);
		}
		assert.equal(starts, 0);
	});

	it("keeps the original retryDemoJob export compatible", () => {
		assert.equal(retryDemoJob, retryJob);
	});

	it("preserves a failed pending delivery and starts a fresh saved attempt once", () => {
		const { chat, job } = fixture();
		const started: string[] = [];
		setJobRespawn((id) => started.push(id));
		const retry = retryDemoJob(chat.id, job.id);
		assert.notEqual(retry.id, job.id);
		assert.equal(retry.retryOf, job.id);
		assert.equal(retry.toolCallId, job.toolCallId);
		assert.deepEqual(retry.input, input);
		assert.equal(retry.status, "running");
		assert.equal(retry.delivery, undefined);
		assert.equal(retry.result, undefined);
		assert.equal(retry.usage, undefined);
		assert.deepEqual(jobStore.getJob(job.id), job);
		assert.deepEqual(retryDemoJob(chat.id, job.id), retry);
		jobStore.updateJob(retry.id, { status: "done" });
		assert.equal(retryDemoJob(chat.id, job.id).id, retry.id);
		assert.deepEqual(started, [retry.id]);
		assert.equal(jobStore.listJobs(chat.id).length, 2);
	});

	it("retries a brief-only figure once, preserves its failure, and rejects a foreign chat", () => {
		const brief = { brief: "Show the gradient estimators in a labeled figure." };
		const { chat, job } = fixture(brief, "visual");
		const foreign = chatStore.createChat("Test: foreign figure retry"); chats.push(foreign.id);
		const started: string[] = [];
		setJobRespawn((id) => started.push(id));
		fails(() => retryDemoJob(foreign.id, job.id), 404);
		const retry = retryDemoJob(chat.id, job.id);
		assert.equal(retry.kind, "visual");
		assert.equal(retry.status, "running");
		assert.equal(retry.retryOf, job.id);
		assert.equal(retry.toolCallId, job.toolCallId);
		assert.deepEqual(retry.input, brief);
		assert.deepEqual(jobStore.getJob(job.id), job);
		assert.equal(retryDemoJob(chat.id, job.id).id, retry.id);
		jobStore.updateJob(retry.id, { status: "error" });
		const second = retryDemoJob(chat.id, retry.id);
		assert.equal(second.kind, "visual");
		assert.equal(second.retryOf, retry.id);
		assert.equal(retryDemoJob(chat.id, retry.id).id, second.id);
		assert.deepEqual(started, [retry.id, second.id]);
	});

	it("rejects an invalid figure brief without creating an attempt", () => {
		let starts = 0;
		setJobRespawn(() => { starts++; });
		for (const saved of [null, {}, "brief", { brief: " " }, { brief: 42 }]) {
			const { chat, job } = fixture(saved, "visual");
			assert.throws(() => retryDemoJob(chat.id, job.id), (error: unknown) =>
				error instanceof JobRetryError && error.status === 409 && error.message === "The original figure request is unavailable");
			assert.equal(jobStore.listJobs(chat.id).length, 1);
		}
		assert.equal(starts, 0);
	});

	it("recovers a legacy figure brief from the visual tool call", () => {
		const { chat, job } = fixture(null, "visual");
		jobStore.updateJob(job.id, { input: undefined });
		const brief = { brief: "Draw a labeled comparison of the estimators." };
		chatStore.saveMessages(chat.id, [{
			id: "assistant-figure", role: "assistant", content: [{ type: "toolCall", id: job.toolCallId, name: "visual", arguments: brief }],
			timestamp: 1,
		} as unknown as LhMessage]);
		setJobRespawn(() => {});
		assert.deepEqual(retryDemoJob(chat.id, job.id).input, brief);
	});

	it("recovers legacy input from the original demo tool call", () => {
		const { chat, job } = fixture(undefined);
		// fixture defaults to saved input; remove it to represent a legacy record.
		jobStore.updateJob(job.id, { input: undefined });
		chatStore.saveMessages(chat.id, [{
			id: "assistant-demo", role: "assistant", content: [{ type: "toolCall", id: job.toolCallId, name: "demo", arguments: input }],
			timestamp: 1,
		} as unknown as LhMessage]);
		setJobRespawn(() => {});
		assert.deepEqual(retryDemoJob(chat.id, job.id).input, input);
	});

	it("rejects missing, foreign, invalid, running and malformed jobs before spawn", () => {
		const { chat, job } = fixture();
		const foreign = chatStore.createChat("Test: foreign retry"); chats.push(foreign.id);
		let starts = 0;
		setJobRespawn(() => { starts++; });
		fails(() => retryDemoJob(foreign.id, job.id), 404);
		fails(() => retryDemoJob(chat.id, "missing"), 404);
		fails(() => retryDemoJob("../invalid", job.id), 400);
		jobStore.updateJob(job.id, { status: "running" });
		fails(() => retryDemoJob(chat.id, job.id), 409);
		const research = fixture(input, "research");
		fails(() => retryDemoJob(research.chat.id, research.job.id), 409);
		assert.equal(starts, 0);
		assert.equal(jobStore.listJobs(chat.id).length, 1);
	});

	it("rejects unavailable or malformed original input without creating a job", () => {
		setJobRespawn(() => {});
		for (const saved of [null, {}, { title: "Demo", brief: " " }, { title: 42, brief: "brief" }]) {
			const { chat, job } = fixture(saved);
			fails(() => retryDemoJob(chat.id, job.id), 409);
			assert.equal(jobStore.listJobs(chat.id).length, 1);
		}
	});

	it("rejects an unavailable runner before creating the successor", () => {
		const { chat, job } = fixture();
		setJobRespawn(undefined);
		fails(() => retryDemoJob(chat.id, job.id), 503);
		assert.equal(jobStore.listJobs(chat.id).length, 1);
	});

	it("allows another retry of a failed successor and deduplicates each attempt", () => {
		const { chat, job } = fixture();
		setJobRespawn(() => {});
		const retry = retryDemoJob(chat.id, job.id);
		jobStore.updateJob(retry.id, { status: "error" });
		const second = retryDemoJob(chat.id, retry.id);
		assert.equal(second.retryOf, retry.id);
		assert.equal(retryDemoJob(chat.id, retry.id).id, second.id);
		assert.equal(retryDemoJob(chat.id, job.id).id, retry.id);
	});

	it("marks a successor failed when startup throws and permits its next retry", () => {
		const { chat, job } = fixture();
		setJobRespawn(() => { throw new Error("start failure"); });
		fails(() => retryDemoJob(chat.id, job.id), 503);
		const failed = jobStore.listJobs(chat.id).find((candidate) => candidate.retryOf === job.id)!;
		assert.equal(failed.status, "error");
		assert.deepEqual(jobStore.getJob(job.id), job);
		setJobRespawn(() => {});
		assert.equal(retryDemoJob(chat.id, failed.id).retryOf, failed.id);
	});

	it("POST retries a figure and returns its saved successor on duplicate requests", async () => {
		const { POST } = await import("../app/api/jobs/route.ts");
		const brief = { brief: "Draw the gradient comparison." };
		const { chat, job } = fixture(brief, "visual");
		const started: string[] = [];
		setJobRespawn((id) => started.push(id));
		const request = () => new Request("http://localhost/api/jobs", {
			method: "POST", body: JSON.stringify({ chatId: chat.id, jobId: job.id }),
		});
		const response = await POST(request());
		assert.equal(response.status, 200);
		const first = (await response.json()).job;
		assert.equal(first.kind, "visual");
		assert.equal(first.status, "running");
		assert.deepEqual(first.input, brief);
		assert.equal((await (await POST(request())).json()).job.id, first.id);
		assert.deepEqual(started, [first.id]);
	});

	it("POST validates requests and returns the same attempt on duplicate requests", async () => {
		const { POST } = await import("../app/api/jobs/route.ts");
		const request = (body: string) => new Request("http://localhost/api/jobs", { method: "POST", body });
		assert.equal((await POST(request("not json"))).status, 400);
		assert.equal((await POST(request("null"))).status, 400);
		assert.equal((await POST(request(JSON.stringify({ chatId: "chat" })))).status, 400);
		const { chat, job } = fixture();
		const started: string[] = [];
		setJobRespawn((id) => started.push(id));
		const body = JSON.stringify({ chatId: chat.id, jobId: job.id });
		const response = await POST(request(body));
		assert.equal(response.status, 200);
		const first = await response.json();
		const second = await (await POST(request(body))).json();
		assert.equal(first.job.retryOf, job.id);
		assert.equal(first.job.id, second.job.id);
		assert.deepEqual(started, [first.job.id]);
		assert.equal((await POST(request(JSON.stringify({ chatId: chat.id, jobId: "missing" })))).status, 404);
	});
});
