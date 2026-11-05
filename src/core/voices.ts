/** Answer voices are plain, browser-safe settings. They change prose style only. */
export const MAX_VOICE_INSTRUCTIONS_CHARS = 12_000;

export const VOICE_PRESETS = [
	{ id: "default", label: "Default", description: "Use the original LearnHarness voice or your enabled prompt override." },
	{ id: "ste-google", label: "ASD-STE100 + Google technical style", description: "Simple English with short, connected explanations and clear technical structure." },
	{ id: "karpathy", label: "Karpathy-inspired", description: "Conversational explanations that build intuition through one concrete example." },
	{ id: "custom", label: "Custom", description: "Write your own instructions for the style of answers." },
] as const;

export type VoicePresetId = (typeof VOICE_PRESETS)[number]["id"];
export interface VoiceSettings {
	preset: VoicePresetId;
	instructions?: string;
}

export function isVoicePresetId(value: unknown): value is VoicePresetId {
	return VOICE_PRESETS.some((preset) => preset.id === value);
}

/** The write parser and disk sanitizer share the same shape rules. */
export function parseVoiceSettings(value: unknown): { ok: true; voice: VoiceSettings } | { ok: false; error: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "voice must be an object" };
	const raw = value as Record<string, unknown>;
	if (!isVoicePresetId(raw.preset)) return { ok: false, error: 'voice.preset must be "default", "ste-google", "karpathy", or "custom"' };
	if (raw.instructions !== undefined && typeof raw.instructions !== "string") return { ok: false, error: "voice.instructions must be a string" };
	if (typeof raw.instructions === "string" && raw.instructions.length > MAX_VOICE_INSTRUCTIONS_CHARS) {
		return { ok: false, error: `voice.instructions must be at most ${MAX_VOICE_INSTRUCTIONS_CHARS} characters` };
	}
	if (raw.preset === "custom" && (typeof raw.instructions !== "string" || !raw.instructions.trim())) {
		return { ok: false, error: "Custom voice requires nonempty instructions" };
	}
	return { ok: true, voice: { preset: raw.preset, ...(raw.instructions !== undefined ? { instructions: raw.instructions as string } : {}) } };
}

const SCOPE = "This selected answer voice controls prose tone, length, and organization. For prose style, it takes priority over general formatting guidance. Preserve accuracy, uncertainty, teaching rules, tool contracts, required answer formats, and mathematical delimiters. Do not claim to be another person or invent personal experience.";

const STE_GOOGLE = `Use ASD-STE100 Simplified Technical English principles with Google developer documentation style.
Lead with the answer or purpose. Then give the context and evidence the reader needs.
Use familiar words, active voice, simple verb forms, and consistent technical terms. Explain unfamiliar terms before use.
Use short sentences with one main idea. Aim for 20 words in instructions and 25 words in descriptions when clear meaning permits.
Write connected paragraphs that explain how each idea leads to the next. Keep necessary technical details, equations, and code exact.
Use sentence-case headings only when they help. Use numbered lists for ordered steps, bullets for parallel items, and tables for comparisons.
Address the reader as you. Put a condition before its instruction. State meaningful limits where they affect the answer.
Remove filler, praise, reflex hedging, and em dashes. Prefer plain statements over dramatic fragments or invented contrasts.
Apply these writing principles without claiming formal compliance or certification.`;

const KARPATHY = `Use a Karpathy-inspired technical explanation style.
Talk to the reader in plain, conversational English. Use you for the reader and we for a shared calculation.
Begin with the concrete question, prediction, or problem the explanation resolves. Show the obstacle before naming a technique.
Build intuition from first principles, then show how the mechanism works. Introduce each abstraction only when the next step needs it.
Carry one small running example through the explanation. When useful, show an inspectable calculation, short code example, or equation and explain its result.
Use crisp claims and varied sentence rhythm. Let the reasoning determine the length; keep routine answers short.
Preserve exact evidence and uncertainty. Do not invent experiences, experiments, or facts.
Remove filler, staged introductions, dramatic closers, defensive contrasts, and em dashes. End at the useful prediction or action, without a recap that repeats the answer.`;

/** Null means retain the original source/override voice unchanged. */
export function voiceInstructions(voice?: VoiceSettings): string | null {
	if (!voice || voice.preset === "default") return null;
	const body = voice.preset === "ste-google" ? STE_GOOGLE : voice.preset === "karpathy" ? KARPATHY : voice.instructions?.trim();
	return body ? `## Selected answer voice\n\n${SCOPE}\n\n${body}` : null;
}
