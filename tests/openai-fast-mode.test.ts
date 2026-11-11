import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeContext, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { sanitizeUserSettings } from "../src/core/settings.ts";

// Real provider serialization, isolated credentials, and an offline HTTP boundary.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fast-mode-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
const originalSend = Object.getOwnPropertyDescriptor(process, "send");
const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
process.env = { PATH: originalEnv.PATH, HOME: directory, NODE_ENV: "test", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json"), OPENAI_API_KEY: "fixture-api-only", OPENROUTER_API_KEY: "fixture-api-only", LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: "d".repeat(64) };
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");
globalThis.fetch = async () => { throw new Error("CLOSED: unexpected network request"); };
const { parseAgentSettingsBody } = await import("../src/server/settings-body.ts");
const { configureProviderSource, piModels, piEngineForSpec } = await import("../src/agent/models.ts");
const { refreshChatGPTModels } = await import("../src/agent/chatgpt-bridge.ts");
const { refreshSubscriptionModels } = await import("../src/agent/subscription-bridge.ts");
const { chatGPTPayload } = await import("../src/agent/chatgpt-stream.ts");
const { NATIVE_SUBSCRIPTIONS } = await import("../src/core/contracts/subscriptions.ts");
const { AgentSection } = await import("../components/settings/agent-section.tsx");
(globalThis as Record<string, unknown>).React = React;
const apiModel = piModels().getModel("openai", "gpt-5") as Model<"openai-responses">;
const codexToken = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
const status = { available: true, pending: false, allowBackgroundUse: true, activeId: "fixture-account", accounts: [{ id: "fixture-account", email: "fixture@example.invalid", registration: "fixture", connected: true, planEnabled: true }], error: null };
const stamp = { epoch: 1, authorityRevision: 1, revision: 1 };
const emit = (value: unknown) => (process.emit as (name: string, value: unknown) => boolean)("message", value);
let fast = false;

before(async () => {
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (message: { channel: string; id: string; op: string; scope?: { providerId: string } }, callback?: () => void) => {
		queueMicrotask(() => {
			let value: unknown;
			if (message.channel === "lh:chatgpt") value = message.op === "lease" ? { accessToken: "fixture-oauth-only", accountId: "fixture-account", ...stamp } : { ...stamp, status, accountId: "fixture-account", models: [{ id: apiModel.id, name: "Fixture model" }] };
			else value = message.op === "snapshot" ? {
				statuses: NATIVE_SUBSCRIPTIONS.map((p) => ({ providerId: p.providerId, available: true, connected: true, pending: false, allowBackgroundUse: true, connectionId: `fixture-${p.providerId}`, ...stamp })),
				models: Object.fromEntries(NATIVE_SUBSCRIPTIONS.map((p) => [p.providerId, piModels().getModels(p.providerId)])),
			} : { scope: message.scope, auth: { apiKey: codexToken, baseUrl: "https://chatgpt.com/backend-api" } };
			emit({ channel: message.channel, id: message.id, op: message.op, ok: true, value });
		});
		callback?.(); return true;
	} });
	await refreshChatGPTModels([apiModel]);
	await refreshSubscriptionModels();
	configureProviderSource({ isCustom: (id) => id === "custom", sync: () => {}, openaiFastMode: () => fast });
});
after(() => {
	process.env = originalEnv; globalThis.fetch = originalFetch;
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
	fs.rmSync(directory, { recursive: true, force: true });
});
const context = normalizeContext({ systemPrompt: "Offline fixture", messages: [{ role: "user", content: "Offline fixture", timestamp: 0 }] });
async function requestBody(engine: ReturnType<typeof piEngineForSpec>, options: SimpleStreamOptions = {}) {
	let body: Record<string, unknown> | undefined, url: string | undefined, authorization: string | null = null;
	const result = await engine.streamFn(engine.model, context, {
		...options,
		fetch: async (input, init) => {
			const request = new Request(input, init);
			const bytes = Buffer.from(await request.arrayBuffer());
			body = JSON.parse((request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString("utf8"));
			url = request.url; authorization = request.headers.get("authorization");
			return new Response('{"error":{"message":"Offline fixture"}}', { status: 401, headers: { "content-type": "application/json" } });
		},
	}).result();
	assert.ok(body, result.errorMessage);
	return { body, url, authorization };
}

test("Fast mode accepts only boolean writes and preserves both choices on read", () => {
	for (const openaiFastMode of [true, false]) {
		assert.deepEqual(parseAgentSettingsBody({ openaiFastMode }), { ok: true, settings: { openaiFastMode } });
		assert.equal(sanitizeUserSettings({ version: 1, agent: { openaiFastMode } })?.agent?.openaiFastMode, openaiFastMode);
	}
	assert.equal(parseAgentSettingsBody({}).ok, true);
	for (const openaiFastMode of [null, 1, "true", {}, []]) {
		assert.equal(parseAgentSettingsBody({ openaiFastMode }).ok, false);
		assert.equal(sanitizeUserSettings({ version: 1, agent: { openaiFastMode } })?.agent?.openaiFastMode, undefined);
	}
});

for (const provider of ["openai", "chatgpt", "openai-codex-subscription"]) test(`${provider}: the same engine reads Fast mode for each request and preserves caller payload edits`, async () => {
	const id = provider === "openai-codex-subscription" ? piModels().getModels("openai-codex")[0]!.id : apiModel.id;
	const engine = piEngineForSpec({ provider, id, thinkingLevel: "off" }, false);
	for (const value of [false, true, false]) {
		fast = value;
		let calls = 0;
		const { body, url, authorization } = await requestBody(engine, { onPayload: async (raw) => {
			await Promise.resolve(); calls++;
			return { ...raw as object, instructions: "Caller replacement survives", service_tier: "default" };
		} });
		assert.equal(body.service_tier, value ? "priority" : "default");
		assert.equal(body.instructions, "Caller replacement survives");
		assert.equal(calls, 1);
		assert.equal(new URL(url!).origin, provider === "openai-codex-subscription" ? "https://chatgpt.com" : "https://api.openai.com");
		assert.equal(authorization, `Bearer ${provider === "openai" ? "fixture-api-only" : provider === "chatgpt" ? "fixture-oauth-only" : codexToken}`);
	}
});

test("Fast mode leaves other provider payloads unchanged", async () => {
	const spec = { provider: "openrouter", id: "openai/gpt-5", thinkingLevel: "off" as const };
	assert.ok(piModels().getModel(spec.provider, spec.id));
	const engine = piEngineForSpec(spec);
	for (const value of [false, true]) {
		fast = value;
		const { body } = await requestBody(engine);
		assert.equal(body.service_tier, undefined);
	}
});

test("Fast mode off leaves the native service tier unset unless the caller selects one", async () => {
	fast = false;
	const engine = piEngineForSpec({ provider: "openai", id: apiModel.id, thinkingLevel: "off" });
	assert.equal((await requestBody(engine)).body.service_tier, undefined);
});

test("the Agent settings show the saved Fast mode choice and its usage cost", () => {
	for (const openaiFastMode of [false, true]) {
		const html = renderToStaticMarkup(React.createElement(AgentSection, {
			agent: { openaiFastMode }, models: undefined, graph: undefined, compaction: undefined,
			onSectionChange: () => true, onModelsChange: () => {}, onCompactionChange: () => true,
		}));
		assert.ok(html.includes('data-testid="openai-fast-mode"'));
		assert.ok(html.includes('aria-label="OpenAI Fast mode"'));
		assert.ok(html.includes(`aria-checked="${openaiFastMode}"`));
		assert.ok(html.includes("2.5x"));
		assert.ok(html.includes("premium API pricing"));
	}
});

test("ChatGPT permits only the supported explicit service tiers at its final payload boundary", () => {
	for (const tier of ["priority", "fast", "default"]) assert.equal(chatGPTPayload({ input: [], service_tier: tier }, apiModel.id).service_tier, tier);
	for (const tier of ["flex", "ultrafast", "unknown", null, 1, {}]) assert.equal(chatGPTPayload({ input: [], service_tier: tier }, apiModel.id).service_tier, undefined);
});
