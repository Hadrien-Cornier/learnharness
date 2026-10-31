"use client";

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { transitionReadingDraft } from "@/src/core";

export function useReadingDraft(
	pendingId: string | null,
	questionDraft: (id: string) => { readingThinking?: string } | undefined,
	clearSnapshot: (id: string) => void,
	textRef: RefObject<string>,
	applyText: (value: string) => void,
) {
	const [seed, setSeed] = useState({ questionId: null as string | null, value: "", revision: 0 });
	const readingRef = useRef("");
	const submittedRef = useRef<string | null>(null);
	const previousRef = useRef<string | null>(null);
	const applyReading = useCallback((value: string) => { readingRef.current = value; }, []);
	useLayoutEffect(() => {
		const previous = previousRef.current;
		if (previous === pendingId) return;
		const submitted = previous !== null && submittedRef.current === previous;
		const next = transitionReadingDraft({
			previous, next: pendingId, submitted,
			composer: textRef.current, reading: readingRef.current,
			saved: pendingId ? questionDraft(pendingId)?.readingThinking : undefined,
		});
		if (pendingId && questionDraft(pendingId)?.readingThinking !== undefined) clearSnapshot(pendingId);
		readingRef.current = next.reading;
		if (pendingId) setSeed((old) => ({ questionId: pendingId, value: next.reading, revision: old.revision + 1 }));
		applyText(next.composer);
		previousRef.current = pendingId;
		if (submitted) submittedRef.current = null;
	}, [pendingId, questionDraft, clearSnapshot, textRef, applyText]);
	const settleSubmission = useCallback((id: string, stillPending: boolean) => {
		if (stillPending && submittedRef.current === id) {
			submittedRef.current = null;
			clearSnapshot(id);
		}
	}, [clearSnapshot]);
	return { seed, readingRef, submittedRef, applyReading, settleSubmission };
}
