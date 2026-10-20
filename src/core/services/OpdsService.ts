import { isTauri } from "../lib/env";
import { browserCatalogUrl } from "../lib/catalog-fetch-url";
import { initTheoremCoreWasm, wasmOpdsExpandSearch, wasmOpdsParse } from "../lib/theorem-core";
import { importBooksFromFilesIncremental, importBooksIncremental } from "../lib/import";
import { useLibraryStore } from "../store";
import type {
    Book,
    OpdsAcquisition,
    OpdsCatalog,
    OpdsCredentials,
    OpdsEntry,
    OpdsErrorKind,
    OpdsFeed,
    OpdsLoaded,
    OpdsOutcome,
    OpdsSearchRef,
    OpdsDownloadedFile,
} from "../types";
import { applyCatalogQuirks, mergeEditions } from "./opds-quirks";

export const DEFAULT_OPDS_PRESETS: OpdsCatalog[] = [
    {
        id: "project-gutenberg",
        title: "Project Gutenberg",
        url: "https://www.gutenberg.org/ebooks.opds/",
        isPreset: true,
        description: "Over 70,000 free classics and public domain literature.",
    },
    {
        id: "standard-ebooks",
        title: "Standard Ebooks",
        url: "https://standardebooks.org/feeds/atom/new-releases",
        isPreset: true,
        description: "Carefully produced, beautifully formatted public domain ebooks.",
    },
];

// ── errors ───────────────────────────────────────────────────────────────────

export class OpdsError extends Error {
    readonly kind: OpdsErrorKind;
    readonly status?: number;
    readonly realm?: string;
    readonly retryAfter?: number;
    /** The server's OPDS Authentication Document, when it sent one with a 401. */
    readonly hint?: OpdsOutcome;

    constructor(
        kind: OpdsErrorKind,
        message: string,
        extra: { status?: number; realm?: string; retryAfter?: number; hint?: OpdsOutcome } = {},
    ) {
        super(message);
        this.name = "OpdsError";
        this.kind = kind;
        Object.assign(this, extra);
    }
}

const ERROR_MESSAGES: Record<OpdsErrorKind, string> = {
    invalidUrl: "That does not look like a catalog address.",
    network: "Could not reach the catalog. Check the address and your connection.",
    timeout: "The catalog took too long to respond.",
    notFound: "The catalog address was not found (404).",
    forbidden: "The catalog refused access (403).",
    rateLimited: "The catalog is limiting requests. Try again in a moment.",
    http: "The catalog returned an error.",
    authRequired: "This catalog requires a sign-in.",
    tooLarge: "The catalog's response is larger than Theorem will accept.",
    unsupported: "This address is not an OPDS catalog.",
    io: "Could not save the download.",
    cors: "This catalog does not allow web browsers to read it. Use the Theorem desktop or mobile app.",
};

/** Native errors arrive as the serialised Rust enum: `{ kind: "authRequired", realm, ... }`. */
function fromNative(raw: unknown): OpdsError {
    if (raw instanceof OpdsError) return raw;
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const kind = (typeof o.kind === "string" ? o.kind : "network") as OpdsErrorKind;
    const message =
        typeof o.message === "string" && o.message
            ? o.message
            : kind === "http" && typeof o.status === "number"
              ? `The catalog answered with HTTP ${o.status}.`
              : ERROR_MESSAGES[kind] ?? (typeof raw === "string" ? raw : ERROR_MESSAGES.network);
    return new OpdsError(kind, message, {
        status: typeof o.status === "number" ? o.status : undefined,
        realm: typeof o.realm === "string" ? o.realm : undefined,
        retryAfter: typeof o.retryAfter === "number" ? o.retryAfter : undefined,
        hint: (o.hint as OpdsOutcome | null | undefined) ?? undefined,
    });
}

export function describeOpdsError(error: unknown): string {
    if (error instanceof OpdsError) return error.message;
    if (error instanceof Error) return error.message;
    return ERROR_MESSAGES.network;
}

// ── fetching ─────────────────────────────────────────────────────────────────

const ACCEPT =
    "application/opds+json, application/atom+xml;profile=opds-catalog;q=0.95, application/atom+xml;q=0.9, application/xml;q=0.8, text/html;q=0.5, */*;q=0.1";
const MAX_HOPS = 3;

function basicAuth(auth?: OpdsCredentials): Record<string, string> {
    if (!auth) return {};
    // btoa only takes Latin-1; encode the credentials as UTF-8 first.
    const bytes = new TextEncoder().encode(`${auth.username}:${auth.password}`);
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return { Authorization: `Basic ${btoa(bin)}` };
}

function statusError(status: number, headers: Headers): OpdsError {
    if (status === 401) {
        const www = headers.get("www-authenticate") ?? "";
        const realm = /realm="?([^",]+)"?/i.exec(www)?.[1];
        return new OpdsError("authRequired", ERROR_MESSAGES.authRequired, { status, realm });
    }
    if (status === 403) return new OpdsError("forbidden", ERROR_MESSAGES.forbidden, { status });
    if (status === 404 || status === 410) return new OpdsError("notFound", ERROR_MESSAGES.notFound, { status });
    if (status === 429) {
        const retry = Number(headers.get("retry-after"));
        return new OpdsError("rateLimited", ERROR_MESSAGES.rateLimited, { status, retryAfter: Number.isFinite(retry) ? retry : undefined });
    }
    return new OpdsError("http", `The catalog answered with HTTP ${status}.`, { status });
}

/** Browser (web build) path: fetch, then hand the bytes to the same Rust parser via WebAssembly. */
async function loadInBrowser(startUrl: string, auth?: OpdsCredentials): Promise<OpdsLoaded> {
    if (!(await initTheoremCoreWasm())) {
        throw new OpdsError("unsupported", "The catalog parser could not start in this browser.");
    }
    let url = startUrl.trim();
    const seen = new Set<string>();
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
        if (seen.has(url)) break;
        seen.add(url);
        let response: Response;
        try {
            if (!/^https?:\/\//i.test(url)) throw new OpdsError("invalidUrl", ERROR_MESSAGES.invalidUrl);
            response = await fetch(browserCatalogUrl(url), { headers: { Accept: ACCEPT, ...basicAuth(auth) } });
        } catch (e) {
            if (e instanceof OpdsError) throw e;
            // A cross-origin block and an unreachable host look identical to fetch(); say the useful thing.
            throw new OpdsError("cors", ERROR_MESSAGES.cors);
        }
        if (!response.ok) throw statusError(response.status, response.headers);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const finalUrl = response.url && !response.url.includes("/api/gutenberg") ? response.url : url;
        const outcome = wasmOpdsParse(bytes, response.headers.get("content-type") ?? "", finalUrl) as OpdsOutcome | null;
        if (!outcome) throw new OpdsError("unsupported", "The catalog could not be read.");
        if (outcome.type === "discovery") {
            url = outcome.href;
            continue;
        }
        return { finalUrl, outcome };
    }
    throw new OpdsError("unsupported", "This address does not lead to an OPDS catalog.");
}

async function loadNative(url: string, auth?: OpdsCredentials): Promise<OpdsLoaded> {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
        return await invoke<OpdsLoaded>("opds_load", { url, auth: auth ?? null });
    } catch (e) {
        throw fromNative(e);
    }
}

// ── cache ────────────────────────────────────────────────────────────────────

const FEED_TTL_MS = 5 * 60 * 1000;
const FEED_CACHE_MAX = 80;
const feedCache = new Map<string, { at: number; loaded: OpdsLoaded }>();

function cacheKey(url: string, auth?: OpdsCredentials): string {
    return `${auth?.username ?? ""}@${url}`;
}

function remember(key: string, loaded: OpdsLoaded) {
    feedCache.delete(key);
    feedCache.set(key, { at: Date.now(), loaded });
    while (feedCache.size > FEED_CACHE_MAX) {
        const oldest = feedCache.keys().next().value;
        if (oldest === undefined) break;
        feedCache.delete(oldest);
    }
}

export function clearOpdsCache(): void {
    feedCache.clear();
}

// ── public API ───────────────────────────────────────────────────────────────

export interface LoadOptions {
    auth?: OpdsCredentials;
    /** Skip the short-lived cache (pull-to-refresh, retry). */
    force?: boolean;
}

export interface LoadedFeed {
    feed: OpdsFeed;
    finalUrl: string;
}

/** Turn a loaded outcome into a feed, or throw the error a user should see. */
function expectFeed(loaded: OpdsLoaded): LoadedFeed {
    const { outcome, finalUrl } = loaded;
    switch (outcome.type) {
        case "feed":
            return { feed: applyCatalogQuirks(outcome.feed, finalUrl), finalUrl };
        case "authentication":
            throw new OpdsError("authRequired", outcome.title || ERROR_MESSAGES.authRequired, { hint: outcome });
        case "unsupported":
            throw new OpdsError("unsupported", outcome.reason);
        default:
            throw new OpdsError("unsupported", ERROR_MESSAGES.unsupported);
    }
}

async function loadRaw(url: string, opts: LoadOptions = {}): Promise<OpdsLoaded> {
    const key = cacheKey(url, opts.auth);
    const hit = feedCache.get(key);
    if (!opts.force && hit && Date.now() - hit.at < FEED_TTL_MS) return hit.loaded;
    const loaded = isTauri() ? await loadNative(url, opts.auth) : await loadInBrowser(url, opts.auth);
    // Only documents that are feeds are worth keeping; an auth challenge must be re-asked.
    if (loaded.outcome.type === "feed") remember(key, loaded);
    return loaded;
}

export const OpdsService = {
    /** Load a catalog feed. Throws `OpdsError`. */
    async load(url: string, opts: LoadOptions = {}): Promise<LoadedFeed> {
        return expectFeed(await loadRaw(normalizeCatalogUrl(url), opts));
    },

    /** Check an address a user typed: what is it, and does it need a sign-in? */
    async probe(url: string, auth?: OpdsCredentials): Promise<LoadedFeed> {
        return OpdsService.load(url, { auth, force: true });
    },

    /** Run the catalog's own search. Resolves OpenSearch description documents on the way. */
    async search(ref: OpdsSearchRef, query: string, auth?: OpdsCredentials): Promise<LoadedFeed> {
        const q = query.trim();
        if (!q) throw new OpdsError("invalidUrl", "Enter something to search for.");
        if (isTauri()) {
            const { invoke } = await import("@tauri-apps/api/core");
            try {
                return expectFeed(await invoke<OpdsLoaded>("opds_search", { searchRef: ref, query: q, auth: auth ?? null }));
            } catch (e) {
                throw fromNative(e);
            }
        }
        let template = ref.href;
        if (ref.kind === "description") {
            const described = await loadRaw(ref.href, { auth });
            if (described.outcome.type !== "openSearch" || described.outcome.templates.length === 0) {
                throw new OpdsError("unsupported", "This catalog's search description could not be read.");
            }
            template = described.outcome.templates[0].template;
        }
        await initTheoremCoreWasm();
        const url = wasmOpdsExpandSearch(template, q);
        if (!url) throw new OpdsError("unsupported", "This catalog's search could not be started.");
        return expectFeed(await loadRaw(url, { auth }));
    },

    /**
     * The full entry for a partial one (catalogs that list books and put the downloads one click
     * deeper). Several editions in one feed are merged into a single book.
     */
    async loadDetail(entry: OpdsEntry, auth?: OpdsCredentials): Promise<OpdsEntry> {
        if (!entry.detailHref) return entry;
        const { feed } = await OpdsService.load(entry.detailHref, { auth });
        const detail = mergeEditions(feed.entries);
        if (!detail) return entry;
        return {
            ...entry,
            ...detail,
            // Keep what the listing already knew when the detail leaves a field out.
            authors: detail.authors.length > 0 ? detail.authors : entry.authors,
            cover: detail.cover ?? entry.cover,
            thumbnail: detail.thumbnail ?? entry.thumbnail,
            webUrl: detail.webUrl ?? entry.webUrl,
            detailHref: undefined,
        };
    },

    /**
     * Download an acquisition and import it through the same pipeline as "Add Books", so metadata,
     * covers and duplicate handling are identical. Returns the imported book.
     */
    async download(
        acquisition: OpdsAcquisition,
        opts: { auth?: OpdsCredentials; onProgress?: (received: number, total?: number) => void } = {},
    ): Promise<Book> {
        const failures: unknown[] = [];
        const addBook = (book: Book) => useLibraryStore.getState().addBook(book);

        if (isTauri()) {
            const { invoke } = await import("@tauri-apps/api/core");
            const { listen } = await import("@tauri-apps/api/event");
            const id = `opds-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const unlisten = await listen<{ id: string; received: number; total?: number }>("opds-download-progress", (e) => {
                if (e.payload.id === id) opts.onProgress?.(e.payload.received, e.payload.total ?? undefined);
            });
            let file: OpdsDownloadedFile | undefined;
            try {
                file = await invoke<OpdsDownloadedFile>("opds_download", { id, url: acquisition.href, auth: opts.auth ?? null });
                const imported = await importBooksIncremental([file.path], addBook, (_source, err) => failures.push(err));
                if (imported[0]) return imported[0];
                throw failures[0] instanceof Error ? failures[0] : new OpdsError("unsupported", "Theorem could not import this file.");
            } catch (e) {
                throw fromNative(e);
            } finally {
                unlisten();
                if (file) void invoke("opds_cleanup_download", { path: file.path }).catch(() => undefined);
            }
        }

        let response: Response;
        try {
            response = await fetch(browserCatalogUrl(acquisition.href), { headers: basicAuth(opts.auth) });
        } catch {
            throw new OpdsError("cors", ERROR_MESSAGES.cors);
        }
        if (!response.ok) throw statusError(response.status, response.headers);
        const blob = await response.blob();
        // A login, loan or purchase page answers 200 OK where a book should be; never import that.
        if (await looksLikeHtml(blob)) {
            throw new OpdsError(
                "unsupported",
                "The server returned a web page instead of a book. Signing in or completing a loan or purchase may be required.",
            );
        }
        opts.onProgress?.(blob.size, blob.size);
        const name = filenameFor(acquisition, response);
        const imported = await importBooksFromFilesIncremental([new File([blob], name, { type: blob.type })], addBook, (_s, err) => failures.push(err));
        if (imported[0]) return imported[0];
        throw failures[0] instanceof Error ? failures[0] : new OpdsError("unsupported", "Theorem could not import this file.");
    },
};

/** Does this download start like a web page? Mirrors the desktop downloader's check. */
export async function looksLikeHtml(blob: Blob): Promise<boolean> {
    if (/^text\/html|^application\/xhtml/i.test(blob.type)) return true;
    const head = new TextDecoder().decode(new Uint8Array(await blob.slice(0, 512).arrayBuffer())).trimStart().toLowerCase();
    return head.startsWith("<!doctype html") || head.startsWith("<html") || (head.startsWith("<?xml") && head.includes("<html"));
}

function filenameFor(a: OpdsAcquisition, response: Response): string {
    const disposition = response.headers.get("content-disposition") ?? "";
    const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
    let name = fromHeader ? decodeURIComponent(fromHeader) : "";
    if (!name) {
        try {
            name = decodeURIComponent(new URL(a.href).pathname.split("/").filter(Boolean).pop() ?? "");
        } catch {
            name = "";
        }
    }
    name = name.replace(/[\\/:*?"<>|]/g, "_") || "book";
    if (a.format && !new RegExp(`\\.${a.format}(\\.[a-z0-9]+)?$`, "i").test(name)) name += `.${a.format}`;
    return name;
}

/** Hosts that are practically always plain-http servers on the user's own network. */
function isLocalHost(hostPort: string): boolean {
    const host = hostPort.split(/[/:?#]/)[0].toLowerCase();
    return (
        host === "localhost" ||
        host.endsWith(".local") ||
        host.endsWith(".lan") ||
        host.endsWith(".home") ||
        /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
        /^[^.]+$/.test(host) // a bare machine name such as "nas" or "raspberrypi"
    );
}

/**
 * Accept what people paste: bare hostnames, `host:port`, `opds://` links (the scheme many reading
 * apps hand out) and stray whitespace. Addresses on the local network default to http because
 * that is how personal servers (Calibre, Kavita, Komga) are usually run; everything else to https.
 */
export function normalizeCatalogUrl(input: string): string {
    let url = input.trim().replace(/\s+/g, "");
    if (!url) return url;
    url = url.replace(/^opds:\/\/\/?/i, "https://").replace(/^opds\+(https?):\/\//i, "$1://");
    // A real scheme is letters followed by "://" (or mailto-like "scheme:" without digits-only rest).
    // `localhost:8080` and `192.168.1.5:80` are host:port, not schemes.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
    return `${isLocalHost(url) ? "http" : "https"}://${url}`;
}
