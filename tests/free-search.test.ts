import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { freeSearchProvider, parseFreeSearchHTML } from "../src/server/free-search.ts";

// Structure from a real DuckDuckGo Lite response, 2026-11-05.
const row = (href: string, title = "ENPIRE &amp; ASPIRE") => `<tr><td>1.</td><td><a rel="nofollow" href="${href}" class="result-link">${title}</a></td></tr>
<tr><td></td><td class="result-snippet">A <b>robot</b>\n policy.</td></tr>`;
const page = (body: string) => `<html><body><table>${body}</table></body></html>`;

describe("free public web search", () => {
	it("unwraps search redirects, decodes entities, and pairs each snippet with its result", () => {
		const html = page(row("//duckduckgo.com/l/?uddg=https%3A%2F%2Fresearch.nvidia.com%2Flabs%2Fgear%2Fenpire%2F&amp;rut=123") + row("https://github.com/NVlabs/ASPIRE", "ASPIRE"));
		assert.deepEqual(parseFreeSearchHTML(html, 5), [
			{ title: "ENPIRE & ASPIRE", url: "https://research.nvidia.com/labs/gear/enpire/", snippet: "A robot policy." },
			{ title: "ASPIRE", url: "https://github.com/NVlabs/ASPIRE", snippet: "A robot policy." },
		]);
	});
	it("filters unsafe URLs, internal links, duplicates, and caps result count", () => {
		const html = page(row("javascript:alert(1)") + row("https://duckduckgo.com/about") + row("https://example.com/a") + row("https://example.com/a") + row("https://example.com/b"));
		assert.equal(parseFreeSearchHTML(html, 10).length, 2);
		assert.equal(parseFreeSearchHTML(html, 1).length, 1);
	});
	it("does not mistake a challenge or changed layout for zero results", () => {
		assert.throws(() => parseFreeSearchHTML(page('<form id="challenge-form" action="/anomaly.js"></form>'), 5), /human verification/);
		assert.throws(() => parseFreeSearchHTML(page("Temporary service error"), 5), /no readable search results/);
		assert.deepEqual(parseFreeSearchHTML(page("No results found for this query"), 5), []);
	});
	it("uses an encoded ordinary HTTP search without credentials", async () => {
		const provider = freeSearchProvider(async (url, init) => {
			assert.equal(new URL(url).origin, "https://lite.duckduckgo.com");
			assert.equal(new URL(url).searchParams.get("q"), '"ENPIRE" & robotics');
			assert.ok(init.signal);
			assert.equal((init.headers as Record<string, string>).authorization, undefined);
			return new Response(page(row("https://example.com/research")));
		});
		assert.equal((await provider.search('"ENPIRE" & robotics', 5))[0]?.url, "https://example.com/research");
	});
	it("surfaces HTTP errors and bounds response bytes even without Content-Length", async () => {
		await assert.rejects(freeSearchProvider(async () => new Response("blocked", { status: 429 })).search("q", 5), /HTTP 429/);
		await assert.rejects(freeSearchProvider(async () => new Response("x".repeat(2 * 1024 * 1024 + 1))).search("q", 5), /too large/);
	});
});
