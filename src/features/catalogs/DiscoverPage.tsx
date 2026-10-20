import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type RefObject } from "react";
import { Globe, RefreshCw, Search, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "../../core/lib/utils";
import { rankByFuzzyQuery } from "../../core/lib/search/fuzzy";
import { DiscoverService, type DiscoverSection } from "../../core/services/DiscoverService";
import type { OpdsEntry } from "../../core/types";
import { PageLoader, TheoremBookCover } from "../../ui";
import { DiscoverCarousel } from "./components/DiscoverCarousel";
import { OpdsEntrySheet } from "./opds/OpdsEntrySheet";
import { OpdsGrid } from "./opds/OpdsGrid";
import { entryAuthor } from "./opds/opds-ui-utils";
import { useCatalogDownload } from "./opds/useCatalogDownload";
import { useInLibrary } from "./opds/useInLibrary";

/** Local fallback when the online search is unreachable: match across the sections already loaded. */
function searchLoadedSections(sections: DiscoverSection[], query: string): OpdsEntry[] {
    const seen = new Set<string>();
    const all = sections.flatMap((s) => s.books).filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true)));
    return rankByFuzzyQuery(all, query, { keys: [{ name: "title", weight: 2 }, "authors", "summary"], limit: 200 }).map((r) => r.item);
}

/**
 * The curated storefront: spotlight, shelves of public-domain classics, and one search across
 * them. Catalogs the user adds are browsed from the source bar above (see `CatalogsPage`).
 */
export function DiscoverPage({ scrollRef }: { scrollRef: RefObject<HTMLElement | null> }) {
    const cachedInitialSections = useMemo(() => DiscoverService.getCachedSections(), []);
    const [sections, setSections] = useState<DiscoverSection[]>(cachedInitialSections);
    const [isLoading, setIsLoading] = useState(cachedInitialSections.length === 0);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [searchQuery, setSearchQuery] = useState("");
    const [searchResults, setSearchResults] = useState<OpdsEntry[]>([]);
    const [isSearching, setIsSearching] = useState(false);

    const [selectedBook, setSelectedBook] = useState<OpdsEntry | null>(null);
    const [isPending, startTransition] = useTransition();

    const inLibrary = useInLibrary();
    const { download, isBusy } = useCatalogDownload();
    const requestIdRef = useRef(0);
    const searchIdRef = useRef(0);

    const loadDiscoverFeed = useCallback(
        async (forceRefresh = false) => {
            const currentReq = ++requestIdRef.current;
            if (forceRefresh) setIsRefreshing(true);
            else if (sections.length === 0) setIsLoading(true);
            setError(null);

            try {
                const data = await DiscoverService.loadCuratedSections(forceRefresh);
                if (requestIdRef.current === currentReq) {
                    startTransition(() => {
                        if (data && data.length > 0) {
                            setSections(data);
                            setError(null);
                        } else if (sections.length === 0) {
                            setSections([]);
                            setError("No public domain books found at this time.");
                        }
                    });
                }
            } catch (err) {
                if (requestIdRef.current === currentReq) {
                    console.warn("Discover load error:", err);
                    if (sections.length === 0) {
                        startTransition(() => setError("Could not connect to online libraries."));
                    } else if (forceRefresh) {
                        toast.error("Could not refresh catalogs. Showing cached library.");
                    }
                }
            } finally {
                if (requestIdRef.current === currentReq) {
                    setIsLoading(false);
                    setIsRefreshing(false);
                }
            }
        },
        [sections.length],
    );

    useEffect(() => {
        void loadDiscoverFeed(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const performSearch = useCallback(
        async (query: string) => {
            const trimmed = query.trim();
            const id = ++searchIdRef.current;
            if (!trimmed) {
                startTransition(() => setSearchResults([]));
                return;
            }
            setIsSearching(true);
            try {
                const online = await DiscoverService.search(trimmed);
                if (id !== searchIdRef.current) return;
                startTransition(() => setSearchResults(online.length > 0 ? online : searchLoadedSections(sections, trimmed)));
            } catch (err) {
                if (id !== searchIdRef.current) return;
                console.warn("Online search failed, searching local sections:", err);
                startTransition(() => setSearchResults(searchLoadedSections(sections, trimmed)));
            } finally {
                if (id === searchIdRef.current) setIsSearching(false);
            }
        },
        [sections],
    );

    useEffect(() => {
        const timer = setTimeout(() => {
            if (searchQuery.trim().length >= 2) void performSearch(searchQuery);
            else if (!searchQuery.trim()) startTransition(() => setSearchResults([]));
        }, 350);
        return () => clearTimeout(timer);
    }, [searchQuery, performSearch]);

    const getEntry = useCallback((entry: OpdsEntry) => void download(entry), [download]);
    const heroBook = sections[0]?.books?.[0] || null;
    const clearSearch = () => {
        setSearchQuery("");
        startTransition(() => setSearchResults([]));
    };

    return (
        <div className="space-y-8 animate-fade-in">
            <div className="flex flex-col justify-between gap-4 border-b border-[var(--color-border)] pb-5 md:flex-row md:items-center">
                <div>
                    <div className="flex items-center gap-2.5">
                        <h1 className="text-2xl text-[color:var(--color-text-primary)]">Discover</h1>
                        <span className="border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-0.5 font-mono text-[10px] text-[color:var(--color-text-muted)]">
                            75,000+ Titles
                        </span>
                    </div>
                    <p className="mt-1 text-xs text-[color:var(--color-text-muted)]">
                        Public domain classics and restored editions. Add your own catalogs from the sources above.
                    </p>
                </div>

                <div className="flex items-center gap-2.5">
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            void performSearch(searchQuery);
                        }}
                        role="search"
                        className="relative w-full sm:w-72 md:w-80"
                    >
                        <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[color:var(--color-text-muted)]" />
                        <input
                            type="search"
                            value={searchQuery}
                            onChange={(e) => {
                                setSearchQuery(e.target.value);
                                if (!e.target.value.trim()) startTransition(() => setSearchResults([]));
                            }}
                            placeholder="Search classics, authors, subjects…"
                            aria-label="Search Discover"
                            className="h-8 w-full border border-[var(--color-border)] bg-[var(--color-surface)] pl-8 pr-7 text-xs text-[color:var(--color-text-primary)] placeholder-[color:var(--color-text-muted)] transition-colors focus:border-[var(--color-text-primary)] focus:outline-none [&::-webkit-search-cancel-button]:hidden"
                        />
                        {searchQuery && (
                            <button
                                type="button"
                                onClick={clearSearch}
                                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)]"
                                aria-label="Clear search"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        )}
                    </form>

                    <button
                        type="button"
                        onClick={() => loadDiscoverFeed(true)}
                        disabled={isRefreshing || isLoading || isPending}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-[color:var(--color-text-secondary)] transition-colors hover:text-[color:var(--color-accent)] disabled:opacity-50"
                        title="Refresh Discover"
                        aria-label="Refresh Discover"
                    >
                        <RefreshCw className={cn("h-3.5 w-3.5", (isRefreshing || isPending) && "animate-spin")} />
                    </button>
                </div>
            </div>

            {isLoading || isSearching ? (
                <div className="flex flex-col items-center justify-center py-24">
                    <PageLoader message={isSearching ? "Searching the catalog…" : "Loading curated library…"} />
                </div>
            ) : error && sections.length === 0 && searchResults.length === 0 ? (
                <div className="mx-auto flex w-full max-w-[26rem] flex-col items-center justify-center px-4 py-20 text-center sm:px-6">
                    <div className="mb-4 flex h-14 w-14 items-center justify-center border border-[var(--color-border)] bg-[var(--color-surface)]">
                        <Globe className="h-6 w-6 stroke-1 text-[color:var(--color-text-muted)]" />
                    </div>
                    <h2 className="mb-2 text-base text-[color:var(--color-text-primary)]">Could not connect to online libraries</h2>
                    <p className="mb-6 break-words text-sm leading-relaxed text-[color:var(--color-text-muted)]">{error}</p>
                    <button
                        type="button"
                        onClick={() => loadDiscoverFeed(true)}
                        className="border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-2.5 text-xs text-[color:var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-muted)]"
                    >
                        Try Again
                    </button>
                </div>
            ) : searchResults.length > 0 ? (
                <div className="space-y-4 animate-fade-in">
                    <div className="flex items-center justify-between">
                        <h2 className="text-sm text-[color:var(--color-text-primary)]">Search Results for "{searchQuery}"</h2>
                        <span className="text-xs text-[color:var(--color-text-muted)]">
                            {searchResults.length} {searchResults.length === 1 ? "book" : "books"} found
                        </span>
                    </div>
                    <OpdsGrid
                        entries={searchResults}
                        scrollRef={scrollRef}
                        inLibrary={inLibrary}
                        isBusy={isBusy}
                        onSelect={setSelectedBook}
                        onGet={getEntry}
                    />
                </div>
            ) : searchQuery.trim().length >= 2 ? (
                <div className="mx-auto flex w-full max-w-[26rem] flex-col items-center justify-center px-4 py-20 text-center sm:px-6">
                    <div className="mb-4 flex h-14 w-14 items-center justify-center border border-[var(--color-border)] bg-[var(--color-surface)]">
                        <Search className="h-6 w-6 stroke-1 text-[color:var(--color-text-muted)]" />
                    </div>
                    <h2 className="mb-2 text-base text-[color:var(--color-text-primary)]">No books found for &ldquo;{searchQuery}&rdquo;</h2>
                    <p className="mb-6 break-words text-sm leading-relaxed text-[color:var(--color-text-muted)]">
                        We couldn't find any public domain titles matching your search. Try searching by author, title, or topic.
                    </p>
                    <button
                        type="button"
                        onClick={clearSearch}
                        className="border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-2.5 text-xs text-[color:var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-muted)]"
                    >
                        Clear Search
                    </button>
                </div>
            ) : (
                <div className="space-y-12 animate-fade-in">
                    {heroBook && (
                        <div
                            onClick={() => setSelectedBook(heroBook)}
                            className="group relative cursor-pointer overflow-hidden border border-[var(--color-border)] bg-gradient-to-br from-[var(--color-surface)] via-[var(--color-surface-muted)] to-[var(--color-surface)] p-6 transition-[box-shadow,border-color] duration-200 ease-out sm:p-8"
                        >
                            <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start sm:gap-8">
                                <div className="aspect-[2/3] w-32 shrink-0 overflow-hidden border border-[var(--color-border)] transition-transform duration-300 group-hover:scale-105 sm:w-40">
                                    <TheoremBookCover
                                        title={heroBook.title}
                                        author={entryAuthor(heroBook) || undefined}
                                        coverUrl={heroBook.cover || heroBook.thumbnail}
                                        badge="FEATURED CLASSIC"
                                    />
                                </div>
                                <div className="flex min-w-0 flex-1 flex-col justify-between space-y-4 text-center sm:text-left">
                                    <div className="space-y-2">
                                        <div className="inline-flex items-center gap-1.5 border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[10px] text-[color:var(--color-accent)]">
                                            <Sparkles className="h-3 w-3" />
                                            <span>Featured Classic</span>
                                        </div>
                                        <h2 className="text-xl text-[color:var(--color-text-primary)] sm:text-2xl">{heroBook.title}</h2>
                                        <p className="text-xs text-[color:var(--color-text-secondary)]">{entryAuthor(heroBook) || "Public Domain"}</p>
                                    </div>
                                    <div className="flex items-center justify-center gap-3 pt-2 sm:justify-start">
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setSelectedBook(heroBook);
                                            }}
                                            className="bg-[var(--color-text-primary)] px-5 py-2.5 text-xs text-[var(--color-background)] transition-opacity hover:opacity-90"
                                        >
                                            View Book
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {sections.map((section) => (
                        <DiscoverCarousel
                            key={section.id}
                            title={section.title}
                            subtitle={section.subtitle}
                            books={section.books}
                            inLibrary={inLibrary}
                            isBusy={isBusy}
                            onSelectBook={setSelectedBook}
                            onGetBook={getEntry}
                        />
                    ))}
                </div>
            )}

            <OpdsEntrySheet entry={selectedBook} onClose={() => setSelectedBook(null)} />
        </div>
    );
}

export default DiscoverPage;
