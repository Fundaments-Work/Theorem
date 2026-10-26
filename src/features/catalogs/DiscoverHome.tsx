import { useState, type FormEvent } from "react";
import { ArrowRight, Check, Download, Library, Loader2, Plus, RefreshCw, Search, X } from "lucide-react";
import { cn } from "../../core/lib/utils";
import type { OpdsEntry, OpdsFeed, OpdsGroup, OpdsNavItem } from "../../core/types";
import { TheoremBookCover } from "../../ui";
import { DiscoverCarousel } from "./components/DiscoverCarousel";
import { entryAction, entryAuthor } from "./opds/opds-ui-utils";

// ── recent searches (this device only) ───────────────────────────────────────

const RECENT_KEY = "theorem-discover-recent-searches";
const RECENT_MAX = 8;

export function readRecentSearches(): string[] {
    try {
        const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
        return Array.isArray(list) ? list.filter((q): q is string => typeof q === "string" && q.trim() !== "").slice(0, RECENT_MAX) : [];
    } catch {
        return [];
    }
}

function writeRecentSearches(list: string[]): void {
    try {
        if (list.length === 0) localStorage.removeItem(RECENT_KEY);
        else localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch {
        // Recent searches are a convenience; without storage they just aren't kept.
    }
}

/** Newest first, no duplicates (ignoring case), at most RECENT_MAX. */
export function addRecentSearch(list: string[], query: string): string[] {
    const q = query.trim().slice(0, 80);
    if (!q) return list;
    return [q, ...list.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, RECENT_MAX);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Catalog summaries are HTML; the hero shows a short plain-text line. Rendered as text, never HTML. */
export function plainSummary(html?: string): string {
    if (!html) return "";
    return html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "’").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function compactCount(n?: number): string {
    if (n === undefined) return "";
    if (n < 1000) return n.toLocaleString();
    return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
}

// ── pieces ───────────────────────────────────────────────────────────────────

function HeroCard({
    entry,
    label,
    inLibrary,
    busy,
    onSelect,
    onGet,
}: {
    entry: OpdsEntry;
    label: string;
    inLibrary: boolean;
    busy: boolean;
    onSelect: (entry: OpdsEntry) => void;
    onGet: (entry: OpdsEntry) => void;
}) {
    const author = entryAuthor(entry);
    const action = entryAction(entry);
    const canGet = !inLibrary && (action.kind === "download" || action.kind === "partial");
    const summary = plainSummary(entry.summary);

    // Depth from a tonal step and a hairline, as everywhere in the design system: no image behind
    // the text, no gradient, no blur (guidelines: text over an image or a gradient does not exist).
    return (
        <article
            data-discover-hero=""
            className="group flex min-h-[12rem] border border-[var(--color-border)] bg-[var(--color-surface-elevated)] transition-[border-color] duration-200 hover:border-[var(--color-accent)] sm:min-h-[15rem]"
        >

            <div className="flex min-w-0 flex-1 flex-col justify-between gap-4 p-4 sm:p-6">
                <div className="min-w-0 space-y-2">
                    <p className="text-[11px] text-[color:var(--color-accent)]">{label}</p>
                    <h3 className="line-clamp-2 text-lg font-light leading-tight text-[color:var(--color-text-primary)] sm:text-2xl">{entry.title}</h3>
                    {author && <p className="truncate text-sm text-[color:var(--color-text-secondary)]">{author}</p>}
                    {summary && <p className="line-clamp-2 max-w-[34rem] text-xs leading-relaxed text-[color:var(--color-text-muted)] sm:line-clamp-3">{summary}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {canGet ? (
                        <button
                            type="button"
                            onClick={() => onGet(entry)}
                            disabled={busy}
                            className="inline-flex h-9 items-center gap-2 bg-[var(--color-text-primary)] px-4 text-xs text-[var(--color-background)] transition-opacity hover:opacity-90 disabled:opacity-60"
                        >
                            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                            Add to Library
                        </button>
                    ) : inLibrary ? (
                        <span className="inline-flex h-9 items-center gap-2 border border-[var(--color-border)] px-4 text-xs text-[color:var(--color-text-secondary)]">
                            <Check className="h-3.5 w-3.5 text-[color:var(--color-accent)]" /> In your Library
                        </span>
                    ) : null}
                    <button
                        type="button"
                        onClick={() => onSelect(entry)}
                        className="inline-flex h-9 items-center gap-1.5 px-1 text-xs text-[color:var(--color-text-secondary)] transition-colors hover:text-[color:var(--color-accent)] sm:px-3"
                    >
                        <span className="sm:hidden">About</span>
                        <span className="hidden sm:inline">About this book</span>
                        <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>

            <button
                type="button"
                onClick={() => onSelect(entry)}
                aria-label={`About ${entry.title}`}
                className="relative m-4 ml-0 w-20 shrink-0 self-start sm:m-5 sm:ml-0 sm:w-32 sm:self-center md:w-36"
            >
                <div className="aspect-[2/3] w-full overflow-hidden border border-[var(--color-border)] transition-transform duration-300 ease-out group-hover:-translate-y-1">
                    <TheoremBookCover title={entry.title} author={author || undefined} coverUrl={entry.thumbnail || entry.cover} />
                </div>
            </button>
        </article>
    );
}

function SubjectTiles({ group, onOpen }: { group: OpdsGroup; onOpen: (href: string, title: string) => void }) {
    const items = group.navigation.slice(0, 12);
    return (
        <section aria-labelledby="discover-subjects" className="space-y-3.5">
            <div className="flex items-end justify-between gap-3">
                <h2 id="discover-subjects" className="text-base text-[color:var(--color-text-primary)]">
                    Browse by subject
                </h2>
                {group.href && (
                    <button
                        type="button"
                        onClick={() => onOpen(group.href!, "All subjects")}
                        className="px-2 py-1 text-xs text-[color:var(--color-text-secondary)] transition-colors hover:text-[color:var(--color-accent)]"
                    >
                        All subjects
                    </button>
                )}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {items.map((item: OpdsNavItem) => (
                    <button
                        key={item.href}
                        type="button"
                        onClick={() => onOpen(item.href, item.title)}
                        data-discover-subject=""
                        className="group flex min-h-[4.5rem] items-end justify-between gap-3 border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5 text-left transition-[border-color,color] duration-200 hover:border-[var(--color-accent)]"
                    >
                        <span className="min-w-0 text-sm leading-snug text-[color:var(--color-text-primary)] transition-colors group-hover:text-[color:var(--color-accent)]">
                            {item.title}
                        </span>
                        {item.count !== undefined && (
                            <span className="shrink-0 text-right">
                                <span className="block text-lg font-light leading-none text-[color:var(--color-text-primary)]">{compactCount(item.count)}</span>
                                <span className="block text-[10px] text-[color:var(--color-text-muted)]">books</span>
                            </span>
                        )}
                    </button>
                ))}
            </div>
        </section>
    );
}

// ── page ─────────────────────────────────────────────────────────────────────

export interface DiscoverHomeProps {
    feed: OpdsFeed;
    groups: OpdsGroup[];
    loading: boolean;
    canSearch: boolean;
    inLibrary: (title: string) => boolean;
    isBusy: (id: string) => boolean;
    onSelectBook: (entry: OpdsEntry) => void;
    onGetBook: (entry: OpdsEntry) => void;
    onSearch: (query: string) => void;
    onOpen: (href: string, title: string) => void;
    onRefresh: () => void;
    onAddCatalog?: () => void;
    /** Show "Add a catalog" next to the title too (when there is no tab row to hold it). */
    addInHeader?: boolean;
}

/**
 * The Discover home: Fundaments' own catalog, laid out as a front page instead of a generic
 * catalog list. A large search with this device's recent searches, the newest editions as hero
 * cards, the curated shelves, subjects as tiles with their size, and a way to bring your own
 * library. Everything comes from the server's OPDS feed, so it changes without an app release;
 * shelves, subjects and search results open in the regular catalog browser.
 */
export function DiscoverHome({
    feed,
    groups,
    loading,
    canSearch,
    inLibrary,
    isBusy,
    onSelectBook,
    onGetBook,
    onSearch,
    onOpen,
    onRefresh,
    onAddCatalog,
    addInHeader = false,
}: DiscoverHomeProps) {
    const [query, setQuery] = useState("");
    const [recent, setRecent] = useState<string[]>(readRecentSearches);

    const shelves = groups.filter((g) => g.entries.length > 0);
    const subjects = groups.find((g) => g.entries.length === 0 && g.navigation.length > 0);
    const [lead, ...rest] = shelves;
    const heroes = lead ? lead.entries.slice(0, 2) : [];
    const leadRemainder = lead ? lead.entries.slice(heroes.length) : [];

    const runSearch = (q: string) => {
        const trimmed = q.trim();
        if (!trimmed || !canSearch) return;
        const next = addRecentSearch(recent, trimmed);
        setRecent(next);
        writeRecentSearches(next);
        onSearch(trimmed);
    };
    const submit = (e: FormEvent) => {
        e.preventDefault();
        runSearch(query);
    };
    const forget = (q: string) => {
        const next = recent.filter((x) => x !== q);
        setRecent(next);
        writeRecentSearches(next);
    };
    const clearRecent = () => {
        setRecent([]);
        writeRecentSearches([]);
    };

    return (
        <div className={cn("space-y-10 transition-opacity", loading && "opacity-60")} aria-busy={loading} data-discover-home="">
            <header className="space-y-5">
                <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                        <h1 className="text-3xl font-light text-[color:var(--color-text-primary)] sm:text-4xl">Discover</h1>
                        {feed.subtitle && <p className="mt-1.5 max-w-[36rem] text-sm text-[color:var(--color-text-muted)]">{feed.subtitle}</p>}
                    </div>
                    <button
                        type="button"
                        onClick={onRefresh}
                        disabled={loading}
                        aria-label="Refresh"
                        title="Refresh"
                        className="inline-flex h-9 w-9 shrink-0 items-center justify-center text-[color:var(--color-text-secondary)] transition-colors hover:text-[color:var(--color-accent)] disabled:opacity-50"
                    >
                        <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
                    </button>
                    {addInHeader && onAddCatalog && (
                        <button
                            type="button"
                            onClick={onAddCatalog}
                            aria-label="Add a catalog"
                            title="Add a catalog"
                            className="inline-flex h-9 shrink-0 items-center gap-1.5 px-2 text-xs text-[color:var(--color-text-secondary)] transition-colors hover:text-[color:var(--color-accent)]"
                        >
                            <Plus className="h-4 w-4" />
                            <span className="hidden sm:inline">Add a catalog</span>
                        </button>
                    )}
                </div>

                {canSearch && (
                    <form onSubmit={submit} role="search" className="relative max-w-[44rem]">
                        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--color-text-muted)]" />
                        <input
                            type="search"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search free books, authors, subjects…"
                            aria-label="Search free books"
                            enterKeyHint="search"
                            className="h-12 w-full border border-[var(--color-border)] bg-[var(--color-surface)] pl-11 pr-10 text-sm text-[color:var(--color-text-primary)] placeholder-[color:var(--color-text-muted)] transition-colors focus:border-[var(--color-accent)] focus:outline-none [&::-webkit-search-cancel-button]:hidden"
                        />
                        {query && (
                            <button
                                type="button"
                                onClick={() => setQuery("")}
                                aria-label="Clear search"
                                className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-[color:var(--color-text-muted)] transition-colors hover:text-[color:var(--color-accent)]"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </form>
                )}

                {canSearch && recent.length > 0 && (
                    <div className="max-w-[44rem] space-y-2" data-discover-recent="">
                        <div className="flex items-center justify-between">
                            <span className="text-xs text-[color:var(--color-text-secondary)]">Recent searches</span>
                            <button type="button" onClick={clearRecent} className="text-xs text-[color:var(--color-text-muted)] transition-colors hover:text-[color:var(--color-accent)]">
                                Clear all
                            </button>
                        </div>
                        <ul className="flex flex-wrap gap-2">
                            {recent.map((q) => (
                                <li key={q} className="flex items-center border border-[var(--color-border)] bg-[var(--color-surface)]">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setQuery(q);
                                            runSearch(q);
                                        }}
                                        className="py-1.5 pl-3 pr-1.5 text-xs text-[color:var(--color-text-primary)] transition-colors hover:text-[color:var(--color-accent)]"
                                    >
                                        {q}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => forget(q)}
                                        aria-label={`Remove “${q}” from recent searches`}
                                        className="py-1.5 pl-1 pr-2.5 text-[color:var(--color-text-muted)] transition-colors hover:text-[color:var(--color-accent)]"
                                    >
                                        <X className="h-3 w-3" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </header>

            {lead && heroes.length > 0 && (
                <section aria-labelledby="discover-lead" className="space-y-3.5">
                    <div className="flex items-end justify-between gap-3">
                        <h2 id="discover-lead" className="text-base text-[color:var(--color-text-primary)]">
                            {lead.title}
                        </h2>
                        {lead.href && (
                            <button
                                type="button"
                                onClick={() => onOpen(lead.href!, lead.title)}
                                className="px-2 py-1 text-xs text-[color:var(--color-text-secondary)] transition-colors hover:text-[color:var(--color-accent)]"
                            >
                                See all
                            </button>
                        )}
                    </div>
                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                        {heroes.map((entry, i) => (
                            <HeroCard
                                key={entry.id}
                                entry={entry}
                                label={i === 0 ? "Newest" : "Also new"}
                                inLibrary={inLibrary(entry.title)}
                                busy={isBusy(entry.id)}
                                onSelect={onSelectBook}
                                onGet={onGetBook}
                            />
                        ))}
                    </div>
                    {leadRemainder.length > 0 && (
                        <DiscoverCarousel
                            title="More new editions"
                            books={leadRemainder}
                            inLibrary={inLibrary}
                            isBusy={isBusy}
                            onSelectBook={onSelectBook}
                            onGetBook={onGetBook}
                        />
                    )}
                </section>
            )}

            {rest.map((group) => (
                <DiscoverCarousel
                    key={group.title + (group.href ?? "")}
                    title={group.title}
                    books={group.entries}
                    inLibrary={inLibrary}
                    isBusy={isBusy}
                    onSelectBook={onSelectBook}
                    onGetBook={onGetBook}
                    onSeeAll={group.href ? () => onOpen(group.href!, group.title) : undefined}
                />
            ))}

            {subjects && <SubjectTiles group={subjects} onOpen={onOpen} />}

            {onAddCatalog && (
                <section className="flex flex-col gap-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6" data-discover-bring="">
                    <div className="flex min-w-0 items-start gap-3">
                        <Library className="mt-0.5 h-5 w-5 shrink-0 stroke-1 text-[color:var(--color-accent)]" />
                        <div className="min-w-0">
                            <h2 className="text-base text-[color:var(--color-text-primary)]">Bring your library</h2>
                            <p className="mt-1 max-w-[36rem] text-xs leading-relaxed text-[color:var(--color-text-muted)]">
                                Your school, university or public library may have a catalog. Add it, or your own Calibre, Kavita or Komga server, and it appears here as a tab.
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onAddCatalog}
                        className="inline-flex h-9 shrink-0 items-center justify-center gap-2 border border-[var(--color-border)] px-4 text-xs text-[color:var(--color-text-primary)] transition-[border-color,color] hover:border-[var(--color-accent)] hover:text-[color:var(--color-accent)]"
                    >
                        <Plus className="h-3.5 w-3.5" /> Add a catalog
                    </button>
                </section>
            )}
        </div>
    );
}
