import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeReadingDrafts } from "../src/core/reading-draft.ts";

describe("reading draft recovery", () => {
	it("preserves an unfinished composer draft with an empty snapshot", () => {
		assert.equal(mergeReadingDrafts("", "new thoughts"), "new thoughts");
	});
	it("restores a rejected answer and retains newer thoughts", () => {
		assert.equal(mergeReadingDrafts("submitted", "newer"), "submitted\nnewer");
	});
	it("does not repeat a restored draft when switching questions", () => {
		assert.equal(mergeReadingDrafts("submitted", "submitted more"), "submitted\nsubmitted more");
		assert.equal(mergeReadingDrafts("submitted", "submitted"), "submitted");
	});
});

import { transitionReadingDraft } from "../src/core/reading-draft.ts";
describe("reading draft transitions", () => {
	it("moves composer text into a new question and back if unresolved", () => {
		const pending = transitionReadingDraft({ previous: null, next: "q1", submitted: false, composer: "thought", reading: "", saved: undefined });
		assert.deepEqual(pending, { composer: "", reading: "thought" });
		assert.deepEqual(transitionReadingDraft({ previous: "q1", next: null, submitted: false, ...pending, saved: undefined }), { composer: "thought", reading: "" });
	});
	it("does not replay a submitted answer, but restores it if the answer fails", () => {
		const sent = transitionReadingDraft({ previous: "q1", next: null, submitted: true, composer: "", reading: "thought", saved: undefined });
		assert.deepEqual(sent, { composer: "", reading: "" });
		assert.deepEqual(transitionReadingDraft({ previous: null, next: "q1", submitted: false, ...sent, saved: "thought" }), { composer: "", reading: "thought" });
	});
	it("keeps unfinished text across question changes without repeating snapshots", () => {
		const changed = transitionReadingDraft({ previous: "q1", next: "q2", submitted: false, composer: "", reading: "thought", saved: undefined });
		assert.equal(changed.reading, "thought");
		assert.equal(transitionReadingDraft({ previous: "q2", next: "q1", submitted: false, ...changed, saved: "thought" }).reading, "thought");
	});
});
