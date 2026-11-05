"use client";

import { useEffect, useState } from "react";
import { MAX_VOICE_INSTRUCTIONS_CHARS, VOICE_PRESETS, type VoicePresetId, type VoiceSettings } from "@/src/core";

/** Answer voice is a saved preference. Editing a draft never changes a live turn. */
export function VoiceSection({ voice, onSave }: {
	voice?: VoiceSettings;
	onSave: (next: VoiceSettings) => Promise<boolean>;
}) {
	const [preset, setPreset] = useState<VoicePresetId>(voice?.preset ?? "default");
	const [instructions, setInstructions] = useState(voice?.instructions ?? "");
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState<string | null>(null);
	useEffect(() => {
		setPreset(voice?.preset ?? "default");
		setInstructions(voice?.instructions ?? "");
	}, [voice?.preset, voice?.instructions]);
	const dirty = preset !== (voice?.preset ?? "default") || instructions !== (voice?.instructions ?? "");
	const valid = preset !== "custom" || instructions.trim().length > 0;
	async function save() {
		setSaving(true);
		setStatus(null);
		try {
			const ok = await onSave({ preset, ...(instructions ? { instructions } : {}) });
			setStatus(ok ? "Saved. Applies to the next answer." : "The voice could not be saved. Try again.");
		} catch {
			setStatus("The voice could not be saved. Try again.");
		} finally {
			setSaving(false);
		}
	}
	return <div className="flex flex-col gap-4" data-testid="voice-settings">
		<p className="text-sm text-muted-foreground">Choose how the tutor writes in teaching and practice sessions. Changes apply to the next answer.</p>
		<div role="radiogroup" aria-label="Answer voice" className="flex flex-col gap-2">
			{VOICE_PRESETS.map((option) => <button
				key={option.id}
				type="button"
				role="radio"
				aria-checked={preset === option.id}
				tabIndex={preset === option.id ? 0 : -1}
				disabled={saving}
				data-testid={`voice-option-${option.id}`}
				onClick={() => { setPreset(option.id); setStatus(null); }}
				onKeyDown={(event) => {
					if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
					event.preventDefault();
					const index = VOICE_PRESETS.findIndex((item) => item.id === option.id);
					const next = event.key === "Home" ? 0 : event.key === "End" ? VOICE_PRESETS.length - 1
						: (index + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) + VOICE_PRESETS.length) % VOICE_PRESETS.length;
					const nextPreset = VOICE_PRESETS[next]!;
					setPreset(nextPreset.id);
					setStatus(null);
					event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-testid="voice-option-${nextPreset.id}"]`)?.focus();
				}}
				className={`rounded-sm border p-3 text-left disabled:opacity-50 ${preset === option.id ? "border-foreground/50 bg-accent" : "border-border hover:bg-accent/50"}`}
			>
				<span className="block font-prose text-sm text-foreground">{option.label}</span>
				<span className="mt-1 block text-xs text-muted-foreground">{option.description}</span>
			</button>)}
		</div>
		{preset === "custom" && <label className="flex flex-col gap-2 text-sm">
			Your voice instructions
			<textarea
				aria-label="Custom voice instructions"
				data-testid="voice-instructions"
				value={instructions}
				disabled={saving}
				maxLength={MAX_VOICE_INSTRUCTIONS_CHARS}
				onInput={(event) => { setInstructions(event.currentTarget.value); setStatus(null); }}
				placeholder="For example: Use short paragraphs. Explain each term before you use it. Carry one example through the answer."
				className="min-h-36 w-full resize-y rounded-sm border border-border bg-background p-3 text-sm outline-none focus:border-foreground/50"
			/>
		</label>}
		<div className="flex items-center gap-3">
			<button type="button" data-testid="voice-save" disabled={!dirty || !valid || saving} onClick={() => void save()}
				className="rounded-sm border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40">
				{saving ? "Saving…" : "Save voice"}
			</button>
			{status && <p role="status" className="text-xs text-muted-foreground" data-testid="voice-status">{status}</p>}
		</div>
	</div>;
}
