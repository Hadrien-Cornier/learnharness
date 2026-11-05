import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";
import { MAX_VOICE_INSTRUCTIONS_CHARS, VOICE_PRESETS, voiceInstructions, type VoiceSettings } from "../src/core/voices.ts";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "lh-answer-voice-"));
process.env.LH_DATA_DIR = data;
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const { parseAgentSettingsBody } = await import("../src/server/settings-body.ts");
const { resolveSettings } = await import("../src/core/settings-resolution.ts");
const { composeInstructions, createTeacherAgent, createProberAgent, createPracticeAgent } = await import("../src/agent/teacher-agent.ts");
const { promptOverrides } = await import("../src/store/prompt-overrides.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { PUT } = await import("../app/api/settings/[section]/route.ts");
const { readSettingsRecord, effectiveSettings } = await import("../src/server/index.ts");
after(() => fs.rmSync(data, { recursive: true, force: true }));

const kinds = ["teacher", "prober", "practice"] as const;

describe("answer voice settings", () => {
	it("strict writes reject malformed, unknown, empty-custom, and oversized settings", () => {
		for (const voice of [null, [], "karpathy", {}, { preset: "unknown" }, { preset: "custom" }, { preset: "custom", instructions: "  " }, { preset: "default", instructions: 3 }, { preset: "custom", instructions: "x".repeat(MAX_VOICE_INSTRUCTIONS_CHARS + 1) }]) {
			assert.equal(parseAgentSettingsBody({ voice }).ok, false, JSON.stringify(voice).slice(0, 100));
			assert.equal(sanitizeUserSettings({ version: 1, agent: { voice } })?.agent?.voice, undefined);
		}
	});
	it("all preset choices persist and preserve custom text when changing a preset", () => {
		for (const { id: preset } of VOICE_PRESETS) {
			const voice = { preset, instructions: "Use small examples and short paragraphs." };
			const parsed = parseAgentSettingsBody({ voice });
			assert.ok(parsed.ok);
			assert.deepEqual(parsed.settings.voice, voice);
			assert.deepEqual(sanitizeUserSettings({ version: 1, agent: { voice } })?.agent?.voice, voice);
		}
		assert.equal(voiceInstructions({ preset: "default", instructions: "Saved but inactive." }), null);
	});
	it("selection replaces only the voice segment in teacher, prober, and practice", () => {
		for (const kind of kinds) {
			const source = composeInstructions(kind);
			for (const voice of [{ preset: "ste-google" }, { preset: "karpathy" }, { preset: "custom", instructions: "Use my exact custom prose style." }] as VoiceSettings[]) {
				const selected = voiceInstructions(voice)!;
				const prompt = composeInstructions(kind, {}, voice);
				assert.ok(prompt.includes(selected));
				assert.ok(!prompt.includes("Dry register."));
				const oldVoice = fs.readFileSync(path.resolve(import.meta.dirname, "../src/agent/prompts/shared/10-voice.md"), "utf8").trim();
				assert.equal(prompt.replace(selected, oldVoice), source, "all non-voice teaching, accuracy, and formatting content stays exact");
			}
			assert.equal(composeInstructions(kind, {}, { preset: "default" }), source);
		}
	});
	it("a selected voice leaves existing override files and switches intact", () => {
		const segment = "shared/10-voice.md";
		promptOverrides.writeOverride(segment, "EXISTING USER VOICE");
		try {
			const switches = { [segment]: true };
			assert.ok(composeInstructions("teacher", switches).includes("EXISTING USER VOICE"));
			assert.ok(!composeInstructions("teacher", switches, { preset: "karpathy" }).includes("EXISTING USER VOICE"));
			assert.equal(promptOverrides.readOverride(segment), "EXISTING USER VOICE");
			assert.equal(switches[segment], true);
			assert.ok(composeInstructions("teacher", switches, { preset: "default" }).includes("EXISTING USER VOICE"));
		} finally { promptOverrides.deleteOverride(segment); }
	});
	it("real agent factories honor a selected voice even without a prompt-switch map", () => {
		const faux = createFauxCore({});
		const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const chatId = chatStore.createChat("Voice factory test").id;
		const opts = { engine, voice: { preset: "karpathy" } as VoiceSettings };
		const agents = [
			createTeacherAgent(undefined, opts),
			createProberAgent({ chatId, chatStore, jobStore, deliver: () => {}, spawn: () => {} }, opts),
			createPracticeAgent({ chatId, chatStore }, opts),
		];
		for (const agent of agents) assert.ok(agent.state.systemPrompt.includes("Use a Karpathy-inspired technical explanation style."));
	});
	it("the real settings route saves a voice and fresh turn composition sees later changes", async () => {
		for (const voice of [{ preset: "ste-google" }, { preset: "custom", instructions: "Speak in short, connected examples." }, { preset: "karpathy", instructions: "Speak in short, connected examples." }] as VoiceSettings[]) {
			const response = await PUT(new Request("http://localhost/api/settings/agent", { method: "PUT", body: JSON.stringify({ voice, tools: { research: true } }), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ section: "agent" }) });
			assert.equal(response.status, 200);
			assert.deepEqual(readSettingsRecord()?.agent?.voice, voice);
			assert.deepEqual(effectiveSettings().agent.voice, voice);
			for (const kind of kinds) assert.ok(composeInstructions(kind, effectiveSettings().agent.prompts, effectiveSettings().agent.voice).includes(voiceInstructions(voice)!));
		}
		const empty = await PUT(new Request("http://localhost/api/settings/agent", { method: "PUT", body: "{}", headers: { "content-type": "application/json" } }), { params: Promise.resolve({ section: "agent" }) });
		assert.equal(empty.status, 200);
		assert.equal(effectiveSettings().agent.voice, undefined);
		assert.equal(resolveSettings(null).agent.voice, undefined);
	});
});
