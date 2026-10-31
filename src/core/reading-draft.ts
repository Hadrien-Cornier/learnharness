/** Combine a recovered submission snapshot with newer unfinished text. */
export function mergeReadingDrafts(saved: string | undefined, unfinished: string): string {
	if (!saved) return unfinished;
	if (!unfinished || saved === unfinished) return saved;
	return `${saved}\n${unfinished}`;
}

/** Move the live draft across a question boundary, keeping snapshots for
 * failed optimistic answers without replaying an accepted submission. */
export function transitionReadingDraft(options: {
	previous: string | null;
	next: string | null;
	submitted: boolean;
	composer: string;
	reading: string;
	saved: string | undefined;
}): { composer: string; reading: string } {
	const unfinished = options.previous === null ? options.composer : options.submitted ? "" : options.reading;
	if (options.next !== null) return { composer: "", reading: mergeReadingDrafts(options.saved, unfinished) };
	return { composer: unfinished, reading: "" };
}
