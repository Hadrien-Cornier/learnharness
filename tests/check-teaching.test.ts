import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BeforeToolCallContext, AgentMessage } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { teachingCheckGuard } from "../src/agent/check-teaching.ts";
import { projectView } from "../src/core/view.ts";
import { danglingQuestionOf } from "../src/core/native-messages.ts";
import { findPendingToolCall } from "../src/core/pending.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-check-teaching-"));
const dataBefore = process.env.LH_DATA_DIR, authBefore = process.env.LH_AUTH_FILE;
const fetchBefore = globalThis.fetch;
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "absent-auth.json");
globalThis.fetch = async () => { throw new Error("Closed fixture: unexpected network request"); };
after(() => {
	if (dataBefore === undefined) delete process.env.LH_DATA_DIR; else process.env.LH_DATA_DIR = dataBefore;
	if (authBefore === undefined) delete process.env.LH_AUTH_FILE; else process.env.LH_AUTH_FILE = authBefore;
	globalThis.fetch = fetchBefore;
	fs.rmSync(scratch, { recursive: true, force: true });
});
const { createTeacherAgent, createProberAgent, createPracticeAgent } = await import("../src/agent/teacher-agent.ts");
const { teachQuizToolFor } = await import("../src/agent/tools.ts");
const { sendToUserTool } = await import("../src/agent/tools/send-to-user.ts");
const { runPiTurn } = await import("../src/server/pi/ui-stream.ts");
const { persistTurn } = await import("../src/server/turn-service.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { SessionModel } = await import("../components/session-core.ts");

const input = { type: "check", nodeId: "ray", question: "Which direction is down?", options: [
	{ label: "Negative vertical", value: "a" }, { label: "Positive vertical", value: "b" },
], explanation: "Down has a negative vertical component.", correctAnswer: "a" };
const quiz = (id = "q", type = "check") => fauxToolCall("quiz", { ...input, type }, { id });
const output = (id = "out") => fauxToolCall("send_to_user", { message: "Visible teaching." }, { id });
const assistant = (content: ReturnType<typeof fauxAssistantMessage>["content"], stopReason = "toolUse") =>
	fauxAssistantMessage(content, { stopReason: stopReason as "toolUse" });
const user = { role: "user", content: "Teach me.", timestamp: 1 } as AgentMessage;
const result = (id: string, name: string, isError = false) => ({ role: "toolResult", toolCallId: id,
	toolName: name, content: [{ type: "text", text: "Result" }], details: {}, isError, timestamp: 1 }) as AgentMessage;
function call(messages: AgentMessage[], current = messages.at(-1)!, target = "q"): BeforeToolCallContext {
	assert.equal(current.role, "assistant");
	const toolCall = current.content.find(b => b.type === "toolCall" && b.id === target)!;
	assert.equal(toolCall.type, "toolCall");
	return { assistantMessage: current, toolCall, args: toolCall.arguments,
		context: { messages, systemPrompt: "Fixture", tools: [] } } as BeforeToolCallContext;
}
const blocked = async (messages: AgentMessage[], current?: AgentMessage, guard = teachingCheckGuard()) =>
	Boolean((await guard.beforeToolCall!(call(messages, current)))?.block);

describe("teaching check delivery guard", () => {
	for (const [label, parts] of [
		["missing", []], ["whitespace", [fauxText(" \n\t")]], ["thinking only", [fauxThinking("Private teaching.")]],
	] as const) it(`blocks ${label} teaching`, async () => {
		assert.equal(await blocked([user, assistant([...parts, quiz()])]), true);
	});
	it("requires prose before the check, not after it", async () => {
		assert.equal(await blocked([user, assistant([fauxText("Read this."), quiz()])]), false);
		assert.equal(await blocked([user, assistant([quiz(), fauxText("Too late.")])]), true);
	});
	it("keeps earlier step prose across tools and automatic markers", async () => {
		const earlier = assistant([fauxText("Read this."), fauxToolCall("visual", {}, { id: "v" })]);
		const marker = { role: "custom", customType: "subagent-steer", content: "Figure ready.", details: {}, display: true, timestamp: 1, id: "marker" } as AgentMessage;
		assert.equal(await blocked([user, earlier, result("v", "visual"), marker, assistant([quiz()])]), false);
	});
	it("does not reuse teaching from before the latest learner boundary", async () => {
		for (const boundary of [user, result("old-q", "quiz"), result("old-q", "explain")]) {
			assert.equal(await blocked([assistant([fauxText("Old teaching.")]), boundary, assistant([quiz()])]), true);
		}
		assert.equal(await blocked([user, assistant([fauxText("This step.")]), result("old-q", "quiz", true), assistant([quiz()])]), false);
	});
	for (const stopReason of ["error", "aborted", "length"]) it(`ignores ${stopReason} generations`, async () => {
		assert.equal(await blocked([user, assistant([fauxText("Incomplete."), output()], stopReason), result("out", "send_to_user"), assistant([quiz()])]), true);
	});
	it("requires a successful matching historical output result", async () => {
		const history = [user, assistant([output()])];
		for (const tail of [[], [result("out", "send_to_user", true)], [result("wrong", "send_to_user")], [result("out", "other")]]) {
			assert.equal(await blocked([...history, ...tail, assistant([quiz()])]), true);
		}
		assert.equal(await blocked([...history, result("out", "send_to_user"), assistant([quiz()])]), false);
	});
	it("tracks successful output in the same batch and preserves call order", async () => {
		const guard = teachingCheckGuard();
		const current = assistant([output(), quiz()]);
		assert.equal(await blocked([user, current], current, guard), true);
		await guard.afterToolCall!({ ...call([user, current], current, "out"), result: { content: [], details: {} }, isError: true });
		assert.equal(await blocked([user, current], current, guard), true);
		await guard.afterToolCall!({ ...call([user, current], current, "out"), result: { content: [], details: {} }, isError: false });
		assert.equal(await blocked([user, current], current, guard), false);
		const reversed = assistant([quiz(), output()]);
		await guard.afterToolCall!({ ...call([user, reversed], reversed, "out"), result: { content: [], details: {} }, isError: false });
		assert.equal(await blocked([user, reversed], reversed, guard), true);
	});
	it("also gates free-recall checks", async () => {
		const empty = assistant([fauxToolCall("explain", { type: "check" }, { id: "q" })]);
		assert.equal(await blocked([user, empty]), true);
		const taught = assistant([fauxText("Read this."), fauxToolCall("explain", { type: "check" }, { id: "q" })]);
		assert.equal(await blocked([user, taught]), false);
	});
	it("does not share same-batch output authority across assistant identities", async () => {
		const guard = teachingCheckGuard();
		const earlier = assistant([output()]);
		await guard.afterToolCall!({ ...call([user, earlier], earlier, "out"), result: { content: [], details: {} }, isError: false });
		const current = assistant([output(), quiz()]);
		assert.equal(await blocked([earlier, user, current], current, guard), true);
	});
	it("does not count blank output even after a successful result", async () => {
		const blank = fauxToolCall("send_to_user", { message: " \n\t" }, { id: "out" });
		assert.equal(await blocked([user, assistant([blank]), result("out", "send_to_user"), assistant([quiz()])]), true);
	});
	it("does not gate predictions or unrelated tools", async () => {
		assert.equal(await blocked([user, assistant([quiz("q", "predict")])]), false);
		const current = assistant([fauxToolCall("ask_user_question", { question: "Continue?" }, { id: "q" })]);
		assert.equal(await blocked([user, current]), false);
	});
});

function engine(steps: ReturnType<typeof fauxAssistantMessage>[]) {
	const faux = createFauxCore({ provider: "openrouter", models: [{ id: "google/gemini-4-argon" }] });
	faux.setResponses(steps);
	return { faux, engine: { model: faux.getModel(), streamFn: faux.streamSimple } };
}
const store = { getChat: () => ({ tree: { nodes: [{ id: "ray" }] } }) };
const registry = () => ({ quiz: teachQuizToolFor({ chatId: "fixture", chatStore: store as never }) });
const stamped = (messages: AgentMessage[]) => messages.map((m, i) => ({ ...m, id: `fixture-${i}` }));

describe("offline teacher check recovery", () => {
	it("streams repair, persists errors, and never opens the rejected check", async () => {
		const { engine: fixture, faux } = engine([
			assistant([fauxThinking("Undelivered lesson."), quiz("bad")]),
			assistant([fauxText("The visible lesson."), quiz("fixed")]),
		]);
		const chat = chatStore.createChat("Synthetic empty-check recovery");
		const initial = { ...user, id: "synthetic-user" };
		chatStore.saveMessages(chat.id, [initial] as never);
		const agent = createTeacherAgent(undefined, { engine: fixture, tools: registry(), messages: [initial] });
		const handle = runPiTurn({ agent, updateFlushMs: 0,
			onFinish: (messages, aborted) => { persistTurn(chatStore, chat.id, 1, messages, aborted); },
		});
		const wire = await new Response(handle.subscribe()).text();
		assert.ok(wire.endsWith("data: [DONE]\n\n"));
		assert.equal(faux.state.callCount, 2);
		const saved = chatStore.getChat(chat.id)!.messages;
		assert.ok(saved.some(m => m.role === "toolResult" && m.toolCallId === "bad" && m.isError));
		assert.ok(!saved.some(m => m.role === "toolResult" && m.toolCallId === "fixed"));
		const pending: Array<string | undefined> = [];
		const client = new SessionModel({ chatId: chat.id, initialMessages: [initial] as never, fetch: globalThis.fetch,
			onChange: () => { pending.push(findPendingToolCall(client.getState().messages)?.toolCallId); },
		});
		await client.consumeStream(new Response(wire));
		assert.ok(pending.length > 0);
		assert.ok(!pending.includes("bad"), "the rejected question never reaches the live dock");
		assert.equal(findPendingToolCall(client.getState().messages)?.toolCallId, "fixed");
		const reloaded = JSON.parse(JSON.stringify(saved));
		assert.equal(danglingQuestionOf(reloaded)?.toolCallId, "fixed");
		const reloadedView = projectView(reloaded);
		assert.equal(findPendingToolCall(reloadedView)?.toolCallId, "fixed");
		assert.equal(reloadedView.flatMap(m => m.parts).find(p => p.toolCallId === "bad")?.state, "output-error");
		assert.deepEqual(reloadedView.filter(m => m.role === "assistant").flatMap(m => m.parts).filter(p => p.type === "text").map(p => p.text), ["The visible lesson."]);
	});
	it("retries an empty check, then accepts teaching and its replacement check", async () => {
		const { engine: fixture, faux } = engine([
			assistant([fauxThinking("Hidden explanation."), quiz("bad")]),
			assistant([fauxText("Down means negative vertical."), quiz("fixed")]),
		]);
		const agent = createTeacherAgent(undefined, { engine: fixture, tools: registry() });
		const errors: unknown[] = [];
		agent.subscribe(event => { if (event.type === "tool_execution_end" && event.isError) errors.push(event); });
		await agent.prompt("Explain, then check.");
		assert.equal(faux.state.callCount, 2);
		assert.equal(errors.length, 1);
		const messages = stamped(agent.state.messages);
		const view = projectView(messages as never);
		assert.equal(findPendingToolCall(view)?.toolCallId, "fixed");
		assert.equal(view.flatMap(m => m.parts).find(p => p.toolCallId === "bad")?.state, "output-error");
	});
	it("shows no pending dock after a rejected check and plain repair", async () => {
		const { engine: fixture, faux } = engine([assistant([quiz("bad")]), fauxAssistantMessage("Here is the missing lesson.")]);
		const agent = createTeacherAgent(undefined, { engine: fixture, tools: registry() });
		await agent.prompt("Explain.");
		assert.equal(faux.state.callCount, 2);
		const messages = stamped(agent.state.messages);
		assert.equal(danglingQuestionOf(messages as never), null);
		assert.equal(findPendingToolCall(projectView(messages as never)), null);
	});
	for (const order of ["output-first", "check-first", "failed-output"] as const) it(`handles ${order} in one batch`, async () => {
		const parts = order === "check-first" ? [quiz("first"), output()] : [output(), quiz("first")];
		const { engine: fixture, faux } = engine([assistant(parts), assistant([fauxText("Repair."), quiz("fixed")])]);
		const tools = { ...registry(), send_to_user: order === "failed-output" ? { ...sendToUserTool,
			execute: async () => ({ content: [{ type: "text" as const, text: "Failed" }], details: {}, isError: true }) } : sendToUserTool };
		const agent = createTeacherAgent(undefined, { engine: fixture, tools });
		await agent.prompt("Explain.");
		assert.equal(faux.state.callCount, order === "output-first" ? 1 : 2);
	});
	it("leaves prediction pauses and practice checks unchanged", async () => {
		for (const kind of ["prediction", "practice"]) {
			const { engine: fixture, faux } = engine([assistant([quiz("q", kind === "prediction" ? "predict" : "check")])]);
			const opts = { engine: fixture, tools: registry() };
			const agent = kind === "practice" ? createPracticeAgent({ chatId: "fixture", chatStore: store as never }, opts) : createTeacherAgent(undefined, opts);
			await agent.prompt("Ask.");
			assert.equal(faux.state.callCount, 1);
			assert.equal(agent.state.messages.some(m => m.role === "toolResult" && m.isError), false);
		}
	});
	it("leaves prober questions unchanged", async () => {
		const { engine: fixture, faux } = engine([assistant([fauxToolCall("probe", input, { id: "p" })])]);
		const agent = createProberAgent({ chatId: "fixture", chatStore: store as never, jobStore: {} as never, deliver: () => {}, spawn: () => {} }, { engine: fixture });
		await agent.prompt("Probe.");
		assert.equal(faux.state.callCount, 1);
		assert.equal(agent.state.messages.some(m => m.role === "toolResult" && m.isError), false);
	});
});
