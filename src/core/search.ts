/** Search providers include free public search and explicit keyed adapters. */

/** One search result row — the shape every adapter must produce (the
 *  researcher's tool contract; same fields the old Google adapter emitted). */
export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

/** Search engines in automatic preference order. Keep existing preferences
 * stable when adding an engine: an explicit pin always wins. */
export const SEARCH_ENGINES = [
	{ id: "duckduckgo", label: "DuckDuckGo (free)", envVar: "" },
	{ id: "tavily", label: "Tavily", envVar: "TAVILY_API_KEY" },
	{ id: "brave", label: "Brave", envVar: "BRAVE_API_KEY" },
	{ id: "exa", label: "Exa", envVar: "EXA_API_KEY" },
	{ id: "firecrawl", label: "Firecrawl", envVar: "FIRECRAWL_API_KEY" },
	{ id: "ollama", label: "Ollama", envVar: "OLLAMA_API_KEY" },
] as const;

export type SearchEngineId = (typeof SEARCH_ENGINES)[number]["id"];

/** The read/write guards' membership check (settings record + PUT body). */
export function isSearchEngineId(value: unknown): value is SearchEngineId {
	return SEARCH_ENGINES.some((engine) => engine.id === value);
}

/** A live search engine: an id (for status/labels) + one operation. The
 *  adapters own their wire protocol (fetch, timeouts, error mapping) —
 *  callers see only this. `search` throws on failure (adapters map HTTP
 *  errors to clear Error messages); the tool layer catches and reports. */
export interface SearchProvider {
	id: SearchEngineId;
	search(query: string, count: number): Promise<SearchHit[]>;
}

/** Why search is (un)available — the honest status the UI and the tool
 *  layer explain from. `engine` is the ACTIVE engine when live. */
export interface SearchStatus {
	available: boolean;
	/** The active engine (null when unavailable). */
	engine: SearchEngineId | null;
	/** The one-line reason for the state (status text for the UI). */
	reason: string;
}
