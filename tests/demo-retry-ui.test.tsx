import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { DispatchCard } from "../components/artifacts/dispatch-card.tsx";
import { JobsContext } from "../components/jobs-context.ts";
import { ChatActionsContext } from "../components/chat.tsx";
import { latestJobAttempt } from "../components/job-attempt.ts";
import type { JobRecord } from "../src/core/contracts.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLElement | undefined;
const failed: JobRecord = { id: "original", kind: "demo", chatId: "c1", toolCallId: "t1", status: "error", error: "FAILED: terminated", activity: "", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z" };
const running: JobRecord = { ...failed, id: "retry", retryOf: failed.id, status: "running", error: undefined, activity: "Building demo", createdAt: "2026-10-02T00:00:00Z" };
async function render(jobs: JobRecord[] = [failed], kind: JobRecord["kind"] = "demo") {
	if (!root) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); }
	await act(async () => root!.render(<JobsContext.Provider value={jobs}><ChatActionsContext.Provider value={{ chatId: "c1", syncFromServer: async () => {}, sendText: () => {}, openSetup: () => {} }}><DispatchCard toolCallId="t1" kind={kind} /></ChatActionsContext.Provider></JobsContext.Provider>));
}
function button() { const value = host!.querySelector<HTMLButtonElement>('[data-testid="dispatch-retry"]'); assert.ok(value); return value; }
function click() { button().dispatchEvent(new dom.window.Event("click", { bubbles: true })); }
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; globalThis.fetch = originalFetch; });

test("Retry sends the original job once and displays the new build before the feed updates", async () => {
	let resolve!: (response: Response) => void;
	let requests = 0;
	globalThis.fetch = async (url, init) => {
		requests++;
		assert.equal(url, "/api/jobs"); assert.equal(init?.method, "POST");
		assert.deepEqual(JSON.parse(String(init?.body)), { chatId: "c1", jobId: "original" });
		return new Promise<Response>((done) => { resolve = done; });
	};
	await render();
	await act(async () => { click(); click(); });
	assert.equal(requests, 1); assert.equal(button().disabled, true); assert.equal(button().textContent, "Retrying…");
	await act(async () => resolve(Response.json({ job: running })));
	assert.match(host!.textContent!, /Building demo/); assert.equal(host!.querySelector('[data-testid="dispatch-retry"]'), null);
	await render([{ ...failed, updatedAt: "2026-11-01T00:00:00Z" }, running]);
	assert.match(host!.textContent!, /Building demo/);
	await render([failed, { ...running, status: "done" }]);
	assert.match(host!.textContent!, /finished/);
});

test("A failed retry request shows an error and permits another click", async () => {
	let requests = 0;
	globalThis.fetch = async () => { requests++; return Response.json({ error: "Retry is unavailable. Try again." }, { status: 503 }); };
	await render(); await act(async () => click());
	assert.match(host!.querySelector('[role="alert"]')!.textContent!, /Retry is unavailable/);
	assert.equal(button().disabled, false);
	globalThis.fetch = async () => { requests++; return Response.json({ job: running }); };
	await act(async () => click()); assert.equal(requests, 2);
	assert.match(host!.textContent!, /Building demo/);
});

test("The retry remains visible with the model setup action", async () => {
	await render([{ ...failed, error: "No model configured — set up your models first (missing: cheap)" }]);
	assert.ok(host!.querySelector('[data-testid="dispatch-setup-link"]')); assert.ok(button());
});

test("Attempt lineage wins over activity order and equal creation timestamps", () => {
	const retry = { ...running, createdAt: failed.createdAt };
	const newest = { ...retry, id: "retry2", retryOf: retry.id, status: "error" as const };
	assert.equal(latestJobAttempt([failed, newest, retry], "t1")!.id, newest.id);
	assert.equal(latestJobAttempt([failed], "unknown"), null);
});


test("A failed figure shows plain-text error details and Retry displays the running figure", async () => {
	const figure: JobRecord = { ...failed, kind: "visual", error: 'Figure failed: <script>alert("error")</script>\nProvider stopped' };
	const figureRetry: JobRecord = { ...running, kind: "visual", activity: "Drawing figure" };
	let requests = 0;
	globalThis.fetch = async (url, init) => {
		requests++;
		assert.equal(url, "/api/jobs");
		assert.equal(init?.method, "POST");
		assert.deepEqual(JSON.parse(String(init?.body)), { chatId: figure.chatId, jobId: figure.id });
		return Response.json({ job: figureRetry });
	};
	await render([figure], "visual");
	const details = host!.querySelector('[data-testid="dispatch-error-details"]');
	assert.ok(details);
	assert.equal(details.querySelector("summary")!.textContent, "Error details");
	assert.equal(details.querySelector("pre")!.textContent, figure.error);
	assert.equal(details.querySelector("script"), null);
	assert.match(host!.textContent!, /Figure agent/);
	await act(async () => click());
	assert.equal(requests, 1);
	assert.match(host!.textContent!, /Figure agent/);
	assert.match(host!.textContent!, /Drawing figure/);
	assert.equal(host!.querySelector('[data-testid="dispatch-retry"]'), null);
	assert.equal(host!.querySelector('[data-testid="dispatch-error-details"]'), null);
	await render([figure, { ...figureRetry, status: "done" }], "visual");
	assert.match(host!.textContent!, /finished/);
});


for (const [kind, label] of [["research", "Research agent"], ["pdf", "PDF reader"], ["demo", "Demo agent"]] as const) {
	test(`A failed ${kind} shows saved error details and Retry displays its running attempt`, async () => {
		const original: JobRecord = { ...failed, kind, error: 'Provider error: <b>overloaded</b>' };
		const retry: JobRecord = { ...running, kind, activity: "Retry started" };
		let requests = 0;
		globalThis.fetch = async (_url, init) => {
			requests++;
			assert.deepEqual(JSON.parse(String(init?.body)), { chatId: original.chatId, jobId: original.id });
			return Response.json({ job: retry });
		};
		await render([original], kind);
		const details = host!.querySelector('[data-testid="dispatch-error-details"]');
		assert.ok(details);
		assert.equal(details.querySelector("pre")!.textContent, original.error);
		assert.equal(details.querySelector("b"), null);
		await act(async () => click());
		assert.equal(requests, 1);
		assert.match(host!.textContent!, new RegExp(label));
		assert.match(host!.textContent!, /Retry started/);
		assert.equal(host!.querySelector('[data-testid="dispatch-retry"]'), null);
		assert.equal(host!.querySelector('[data-testid="dispatch-error-details"]'), null);
	});
}
