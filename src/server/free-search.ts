import { parseHTML } from "linkedom";
import type { SearchHit, SearchProvider } from "../core/search.ts";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
const ENDPOINT = "https://lite.duckduckgo.com/lite/";
const MAX_BYTES = 2 * 1024 * 1024;

function resultURL(href: string): string | null {
	try {
		let url = new URL(href, ENDPOINT);
		if (url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) {
			if (url.pathname !== "/l/" || !url.searchParams.has("uddg")) return null;
			url = new URL(url.searchParams.get("uddg")!);
		}
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		if (url.username || url.password) return null;
		if (url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) return null;
		return url.href;
	} catch {
		return null;
	}
}

const plain = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

/** Parse ordinary search HTML. A challenge or changed layout is a failure,
 * never evidence that a query has no results. */
export function parseFreeSearchHTML(html: string, count: number): SearchHit[] {
	const { document } = parseHTML(html);
	if (document.querySelector("#challenge-form, #anomaly-modal, .anomaly-modal") || /anomaly\.js|confirm this search was made by a human/i.test(html)) {
		throw new Error("DuckDuckGo requires a human verification. Try the search again later.");
	}
	const hits: SearchHit[] = [];
	const seen = new Set<string>();
	let pending: SearchHit | null = null;
	for (const row of document.querySelectorAll("tr")) {
		const link = row.querySelector("a.result-link");
		if (link) {
			pending = null;
			const url = resultURL(link.getAttribute("href") ?? "");
			const title = plain(link.textContent);
			if (url && title && !seen.has(url) && !row.querySelector(".badge--ad, .result-sponsored")) {
				pending = { title, url, snippet: "" };
				hits.push(pending);
				seen.add(url);
			}
		}
		const snippet = row.querySelector(".result-snippet");
		if (pending && snippet) pending.snippet = plain(snippet.textContent).slice(0, 500);
	}
	if (!hits.length && !/No results found|No more results|No results for/i.test(document.body?.textContent ?? "")) {
		throw new Error("DuckDuckGo returned no readable search results. The page may be blocked or its layout changed.");
	}
	return hits.slice(0, Math.max(1, Math.min(10, Math.trunc(count) || 5)));
}

async function boundedText(response: Response): Promise<string> {
	if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("Search response is too large");
	if (!response.body) throw new Error("Search response has no body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			bytes += part.value.byteLength;
			if (bytes > MAX_BYTES) throw new Error("Search response is too large");
			text += decoder.decode(part.value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
}

/** Public search page over HTTP. No account, key, or paid API. */
export function freeSearchProvider(fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "duckduckgo",
		async search(query, count) {
			const url = new URL(ENDPOINT);
			url.searchParams.set("q", query);
			const response = await fetchFn(url.href, {
				headers: {
					"User-Agent": "Mozilla/5.0",
					Accept: "text/html",
				},
				signal: AbortSignal.timeout(20_000),
			});
			if (!response.ok) throw new Error(`DuckDuckGo search HTTP ${response.status}`);
			return parseFreeSearchHTML(await boundedText(response), count);
		},
	};
}
