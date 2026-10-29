import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ToolCallCard } from "../components/artifacts/tool-call-card.tsx";
import { SessionModel } from "../components/session-core.ts";
import { projectView } from "../src/core/view.ts";
import { toolResultDisplayOutput, toolResultImages } from "../src/core/tool-result-output.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const image = { type: "image", data: "AAAA", mimeType: "image/png" };
const content = [{ type: "text", text: "Read image file [image/png]" }, image];
const call = {
	id: "assistant", role: "assistant", timestamp: 1, provider: "test", model: "test", stopReason: "toolUse",
	content: [{ type: "toolCall", id: "read1", name: "read", arguments: { path: "frames/table.png" } }],
} as unknown as LhMessage;
const result = {
	id: "result", role: "toolResult", toolCallId: "read1", toolName: "read", timestamp: 2,
	content, details: null, isError: false,
} as LhMessage;
function readPart(messages: ReturnType<typeof projectView>) {
	return messages.flatMap((message) => message.parts).find((part) => part.type === "tool-read")!;
}

describe("read image attachments", () => {
	it("projects native images from existing null-details records, including after JSON reload", () => {
		const messages = [call, result];
		const part = readPart(projectView(messages));
		assert.deepEqual(part.output, { text: "Read image file [image/png]", images: [image], details: null });
		assert.deepEqual(projectView(JSON.parse(JSON.stringify(messages))), projectView(messages));
	});

	it("keeps native image bytes during the actual live execution stream, before turn_end", async () => {
		const snapshots: unknown[] = [];
		const model = new SessionModel({ chatId: "image-test", initialMessages: [], onChange() {
			const part = readPart(model.getState().messages);
			if (part?.state === "output-available") snapshots.push(part.output);
		} });
		const events = [
			{ type: "message_end", message: call },
			{ type: "tool_execution_end", toolCallId: "read1", toolName: "read", result: { content, details: null }, isError: false },
			{ type: "turn_end", toolResults: [result] },
		];
		await model.consumeStream(new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n"));
		assert.ok(snapshots.length >= 1, "the image displays before the result batch arrives");
		const expected = readPart(projectView([call, result])).output;
		for (const output of snapshots) assert.deepEqual(output, expected);
		assert.deepEqual(readPart(model.getState().messages).output, expected);
	});

	it("displays the preview outside the collapsed trace, with its filename and full-size control", () => {
		const part = readPart(projectView([call, result]));
		const html = renderToStaticMarkup(<ToolCallCard part={part as never} />);
		const { document } = parseHTML(html);
		const trace = document.querySelector('[data-testid="tool-call-card"]')!;
		const figure = document.querySelector('[data-testid="read-image"]')!;
		assert.ok(figure, "the original file has its own visible image figure");
		assert.equal(trace.hasAttribute("open"), false);
		assert.equal(trace.querySelector("img"), null, "the preview is not hidden in the trace");
		assert.equal(figure.querySelector("summary img")!.getAttribute("src"), "data:image/png;base64,AAAA");
		assert.equal(figure.querySelector("figcaption")!.textContent, "table.png");
		assert.equal(figure.querySelector("summary")!.getAttribute("aria-label"), "Expand image table.png");
		assert.ok(figure.querySelector('[aria-label="Full-size image table.png"] img'));
		assert.doesNotMatch(trace.textContent!, /AAAA/);
	});

	it("preserves text and structured metadata for non-image results", () => {
		for (const details of ["plain file text", { matches: 3 }, null]) {
			assert.equal(toolResultDisplayOutput({ content: [{ type: "text", text: "text" }], details }, "read"), details);
		}
		const part = readPart(projectView([call, { ...result, content: [{ type: "text", text: "file" }], details: "file" } as LhMessage]));
		const html = renderToStaticMarkup(<ToolCallCard part={part as never} />);
		assert.doesNotMatch(html, /<img/);
	});

	it("preserves structured details for non-read tools that also return images", () => {
		const details = { page: 1, pdfId: "doc", width: 1200 };
		assert.equal(toolResultDisplayOutput({ content, details }, "pdf_render"), details);
		const otherCall = { ...call, content: [{ type: "toolCall", id: "read1", name: "pdf_render", arguments: {} }] } as LhMessage;
		const otherResult = { ...result, toolName: "pdf_render", details } as LhMessage;
		const part = projectView([otherCall, otherResult]).flatMap((message) => message.parts).find((part) => part.type === "tool-pdf_render")!;
		assert.equal(part.output, details);
	});

	it("does not display images from a failed read", () => {
		const part = readPart(projectView([call, { ...result, isError: true } as LhMessage]));
		assert.equal(part.state, "output-error");
		assert.equal(part.output, undefined);
		assert.doesNotMatch(renderToStaticMarkup(<ToolCallCard part={part as never} />), /<img/);
	});

	it("accepts supported raster images and rejects active documents or malformed payloads", () => {
		for (const mimeType of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]) {
			assert.equal(toolResultImages([{ ...image, mimeType }]).length, 1);
		}
		for (const invalid of [null, {}, { ...image, mimeType: "image/svg+xml" }, { ...image, mimeType: "text/html" }, { ...image, data: "" }, { ...image, data: "file:///etc/passwd" }]) {
			assert.deepEqual(toolResultImages([invalid]), []);
		}
	});
});
