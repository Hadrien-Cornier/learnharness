import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import type { UserSettings } from "../src/core/settings.ts";

it("Voice settings save presets and custom text, preserve other settings, and report failed writes", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	// Linkedom omits defaultValue; React uses this DOM property to initialize textarea content.
	const textareaPrototype = dom.window.HTMLTextAreaElement.prototype;
	const previousDefaultValue = Object.getOwnPropertyDescriptor(textareaPrototype, "defaultValue");
	Object.defineProperty(textareaPrototype, "defaultValue", {
		configurable: true,
		get() { return this.textContent; },
		set(value: string) { this.textContent = value; },
	});
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	let stored: UserSettings = { version: 1, agent: { tools: { research: false }, search: { engine: "duckduckgo" } } };
	let fail = false;
	let writes = 0;
	for (const [key, value] of Object.entries({
		window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
		Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/settings" && !init?.method) return Response.json({ settings: stored });
			assert.equal(url, "/api/settings/agent");
			assert.equal(init?.method, "PUT");
			writes++;
			if (fail) return Response.json({ error: "Test save failure" }, { status: 500 });
			stored = { ...stored, agent: JSON.parse(String(init.body)) };
			return Response.json({ settings: stored });
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	const button = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
	const click = async (id: string) => { await act(async () => { button(id).click(); }); };
	try {
		await act(async () => { root.render(<SettingsDialogBody initialSection="voice" onClose={() => {}} />); });
		assert.ok(button("voice-save").disabled);
		await click("voice-option-ste-google");
		assert.equal(writes, 0, "selection remains a draft until Save");
		await click("voice-save");
		assert.equal(stored.agent?.voice?.preset, "ste-google");
		assert.equal(stored.agent?.tools?.research, false);
		assert.equal(stored.agent?.search?.engine, "duckduckgo");
		assert.match(document.querySelector('[data-testid="voice-status"]')?.textContent ?? "", /Saved/);
		await click("voice-option-custom");
		assert.ok(button("voice-save").disabled, "empty custom voice cannot be activated");
		const input = document.querySelector<HTMLTextAreaElement>('[data-testid="voice-instructions"]')!;
		await act(async () => { input.value = "Use one small robotics example."; input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
		await click("voice-save");
		assert.equal(stored.agent?.voice?.instructions, "Use one small robotics example.");
		await click("voice-option-karpathy");
		fail = true;
		await click("voice-save");
		assert.equal(stored.agent?.voice?.preset, "custom", "failed save preserves the previous saved voice");
		assert.match(document.querySelector('[data-testid="voice-status"]')?.textContent ?? "", /could not be saved/);
		fail = false;
		await click("voice-save");
		assert.equal(stored.agent?.voice?.preset, "karpathy");
		await click("voice-option-custom");
		assert.equal(document.querySelector<HTMLTextAreaElement>('[data-testid="voice-instructions"]')!.value, "Use one small robotics example.");
		await click("voice-option-default");
		await click("voice-save");
		assert.equal(stored.agent?.voice?.preset, "default");
		assert.equal(stored.agent?.voice?.instructions, "Use one small robotics example.");
	} finally {
		act(() => root.unmount());
		if (previousDefaultValue) Object.defineProperty(textareaPrototype, "defaultValue", previousDefaultValue);
		else delete (textareaPrototype as unknown as Record<string, unknown>).defaultValue;
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	}
});
