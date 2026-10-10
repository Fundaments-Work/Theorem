import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
    ArrowLeft,
    BookOpen,
    ChevronRight,
    Download,
    Folder,
    Globe,
    Plus,
    RefreshCw,
    Search,
    X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "../../core/lib/utils";
import { useOpdsStore, useUIStore } from "../../core/store";
import { OpdsService } from "../../core/services/OpdsService";
import type { OpdsEntry, OpdsFeed } from "../../core/types";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "../../ui";
import { OpdsBookCard } from "./components/OpdsBookCard";

/** Column gap between cover columns, in px. Must match the grid's `gap`. */
const BOOK_GRID_GAP = 16;
/** Height reserved under each cover for the title + author lines. */
const BOOK_CARD_TEXT_HEIGHT = 44;
/** Delay before an as-you-type search hits the network. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Loading placeholder. A bare spinner replaced the entire viewport, so the page
 * jumped from "empty" to "full grid" on every catalog change. Skeleton cards
 * reserve the same shape the real grid will occupy, so nothing reflows when the
 * feed lands.
 */
function CatalogSkeleton() {
    return (
        <div className="space-y-8" aria-hidden="true">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {Array.from({ length: 3 }, (_, i) => (
                    <div
                        key={i}
                        className="h-14 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] animate-pulse"
                    />
                ))}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                {Array.from({ length: 18 }, (_, i) => (
                    <div key={i} className="flex flex-col">
                        <div className="aspect-[2/3] w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] animate-pulse" />
                        <div className="mt-2 h-3 w-4/5 rounded bg-[var(--color-surface-muted)] animate-pulse" />
                        <div className="mt-1.5 h-2.5 w-3/5 rounded bg-[var(--color-surface-muted)] animate-pulse" />
                    </div>
                ))}
            </div>
        </div>
    );
}

export function OPDSBrowserPage() {
    const catalogs = useOpdsStore((state) => state.catalogs);
    const activeCatalogId = useOpdsStore((state) => state.activeCatalogId);
    const currentFeedUrl = useOpdsStore((state) => state.currentFeedUrl);
    const feedHistory = useOpdsStore((state) => state.feedHistory);

    const setActiveCatalog = useOpdsStore((state) => state.setActiveCatalog);
    const navigateToFeed = useOpdsStore((state) => state.navigateToFeed);
    const navigateBack = useOpdsStore((state) => state.navigateBack);
    const addCatalog = useOpdsStore((state) => state.addCatalog);
    const removeCatalog = useOpdsStore((state) => state.removeCatalog);

    const setRoute = useUIStore((state) => state.setRoute);

    const [feed, setFeed] = useState<OpdsFeed | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [isSearching, setIsSearching] = useState(false);
    /**
     * Server search results are held separately from `feed`.
     *
     * They used to be written back into `feed`, which replaced the feed the user
     * had drilled into — so searching a category destroyed the category and left
     * no way back to it. Keeping them apart means the browsing context survives,
     * and clearing the query is a pure client-side operation with no refetch.
     */
    const [serverResults, setServerResults] = useState<OpdsFeed | null>(null);
    const [searchSource, setSearchSource] = useState<"server" | "local" | null>(null);
    /**
     * Guards against out-of-order responses. Without it, a slow request for
     * "dick" can land after a fast one for "dickens" and overwrite it.
     */
    const searchRequestId = useRef(0);

    const [selectedEntry, setSelectedEntry] = useState<OpdsEntry | null>(null);
    const [downloadingEntryId, setDownloadingEntryId] = useState<string | null>(null);

    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [newCatalogTitle, setNewCatalogTitle] = useState("");
    const [newCatalogUrl, setNewCatalogUrl] = useState("");

    const activeCatalog = useMemo(() => {
        return catalogs.find((c) => c.id === activeCatalogId) || catalogs[0] || null;
    }, [catalogs, activeCatalogId]);

    const targetUrl = currentFeedUrl || activeCatalog?.url || null;

    const scrollRef = useRef<HTMLDivElement>(null);
    const gridRef = useRef<HTMLDivElement>(null);
    const [containerWidth, setContainerWidth] = useState(1024);

    // Track the scroll container so the virtualizer can size rows from the real
    // column width instead of guessing. Mirrors DiscoverPage.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;

        const updateWidth = () => setContainerWidth(el.clientWidth || 1024);

        updateWidth();
        const ro = new ResizeObserver(updateWidth);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const loadFeed = useCallback(async (url: string) => {
        setIsLoading(true);
        setError(null);
        try {
            const data = await OpdsService.fetchFeed(url);
            setFeed(data);
        } catch (err: any) {
            console.error("Feed load error:", err);
            setError("Could not load catalog. Please check your internet connection or URL.");
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        if (targetUrl) {
            // A search belongs to the feed it ran against; leaving it applied to
            // the next category would show matches the user never asked for.
            setSearchQuery("");
            void loadFeed(targetUrl);
        }
    }, [targetUrl, loadFeed]);

    /**
     * Server search, used only when the feed advertises an OpenSearch template.
     *
     * A failure falls back to filtering what is already loaded rather than
     * dead-ending: many catalogs advertise a template they do not honour, and a
     * toast with no results is the worst possible answer.
     */
    const runServerSearch = useCallback(
        async (query: string) => {
            const template = feed?.searchUrlTemplate;
            if (!template) return;

            const requestId = ++searchRequestId.current;
            setIsSearching(true);
            try {
                const results = await OpdsService.search(
                    template,
                    query,
                    feed?.selfUrl || targetUrl || "",
                );
                if (requestId !== searchRequestId.current) return;
                setServerResults(results);
                setSearchSource("server");
            } catch {
                if (requestId !== searchRequestId.current) return;
                setServerResults(null);
                setSearchSource("local");
                toast.error("Catalog search failed — showing matches on this page instead.");
            } finally {
                if (requestId === searchRequestId.current) setIsSearching(false);
            }
        },
        [feed, targetUrl],
    );

    /**
     * Search-as-you-type.
     *
     * Previously this only ran on form submit and only when the feed had a
     * search template — so on a feed without one the input was not even
     * rendered, and typing simply did nothing.
     */
    useEffect(() => {
        const query = searchQuery.trim();
        // Any keystroke invalidates whatever is in flight.
        searchRequestId.current += 1;

        if (!query) {
            setServerResults(null);
            setSearchSource(null);
            setIsSearching(false);
            return;
        }

        if (!feed?.searchUrlTemplate) {
            // No search endpoint: filter the loaded entries. Instant, no debounce.
            setSearchSource("local");
            setServerResults(null);
            return;
        }

        const timer = setTimeout(() => {
            void runServerSearch(query);
        }, SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [searchQuery, feed?.searchUrlTemplate, runServerSearch]);

    const handleSearchSubmit = (e?: React.FormEvent) => {
        e?.preventDefault();
        const query = searchQuery.trim();
        if (query) void runServerSearch(query);
    };

    const clearSearch = () => setSearchQuery("");

    const handleDownload = async (entry: OpdsEntry) => {
        setDownloadingEntryId(entry.id);
        const toastId = toast.loading(`Adding "${entry.title}" to library…`);
        try {
            await OpdsService.downloadAndImportBook(entry, (msg) => {
                toast.loading(msg, { id: toastId });
            });
            toast.success(`"${entry.title}" added to Library`, {
                id: toastId,
                action: {
                    label: "View Library",
                    onClick: () => setRoute("library"),
                },
            });
        } catch (err: any) {
            toast.error(err.message || "Failed to download book", { id: toastId });
        } finally {
            setDownloadingEntryId(null);
        }
    };

    const handleAddCatalogSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!newCatalogTitle.trim() || !newCatalogUrl.trim()) return;

        let cleanUrl = newCatalogUrl.trim();
        if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
            cleanUrl = `https://${cleanUrl}`;
        }

        addCatalog({
            title: newCatalogTitle.trim(),
            url: cleanUrl,
        });

        setIsAddModalOpen(false);
        setNewCatalogTitle("");
        setNewCatalogUrl("");
        toast.success(`Added "${newCatalogTitle}" catalog`);
    };

    const trimmedQuery = searchQuery.trim();
    const usingServerResults = trimmedQuery.length > 0 && searchSource === "server" && !!serverResults;

    /**
     * Local fallback. Matches title and author, case-insensitively, so search
     * works on every catalog rather than only on those implementing OpenSearch.
     */
    const localMatches = useMemo(() => {
        if (!trimmedQuery) return null;
        const query = trimmedQuery.toLowerCase();
        return (feed?.entries ?? []).filter(
            (e) =>
                !e.isNavigation &&
                (e.title.toLowerCase().includes(query) ||
                    (e.author ?? "").toLowerCase().includes(query)),
        );
    }, [feed, trimmedQuery]);

    // Categories are hidden while searching — a sub-feed is not a search result.
    const navigationEntries = useMemo(() => {
        if (trimmedQuery) return [];
        return feed?.entries.filter((e) => e.isNavigation) || [];
    }, [feed, trimmedQuery]);

    const bookEntries = useMemo(() => {
        if (usingServerResults) {
            return (serverResults?.entries ?? []).filter((e) => !e.isNavigation);
        }
        if (trimmedQuery) return localMatches ?? [];
        return feed?.entries.filter((e) => !e.isNavigation) || [];
    }, [usingServerResults, serverResults, trimmedQuery, localMatches, feed]);

    /**
     * Column count has to be known in JS (not just CSS) because the virtualizer
     * packs N entries into each row. Breakpoints mirror DiscoverPage so the two
     * catalog views line up column-for-column.
     */
    const effectiveCols = useMemo(() => {
        if (containerWidth >= 1536) return 8;
        if (containerWidth >= 1280) return 7;
        if (containerWidth >= 1024) return 5;
        if (containerWidth >= 768) return 4;
        if (containerWidth >= 640) return 3;
        return 2;
    }, [containerWidth]);

    /**
     * Row height is fully determined: the cover is `aspect-[2/3]`, and both the
     * title and author are single-line truncations. So this is an exact size,
     * not an estimate — the grid does not need `measureElement` at all, which
     * removes a measure pass per row on every scroll.
     *
     * Measured against the grid itself rather than the scroll container: the
     * content column is capped at `max-w-7xl`, so a very wide window would
     * otherwise be over-estimated by the difference and grow a scrollbar of
     * empty space.
     */
    const getBookRowSize = useCallback(() => {
        const el = gridRef.current ?? scrollRef.current;
        if (!el) return 300;
        const cardW = Math.max(
            1,
            (el.clientWidth - (effectiveCols - 1) * BOOK_GRID_GAP) / Math.max(effectiveCols, 1),
        );
        return Math.round(cardW * 1.5 + BOOK_CARD_TEXT_HEIGHT + BOOK_GRID_GAP);
    }, [effectiveCols]);

    /**
     * OPDS catalogs are routinely far larger than a screenful — a single feed can
     * hold tens of thousands of entries. Rendering one DOM node per entry mounted
     * all of them at once, which is why this view felt slow while every other
     * list in the app (Library, Shelves, Bookmarks, Feeds, Discover search)
     * already virtualizes. Rows, not cells: one virtual row per line of covers.
     */
    const bookRowCount = Math.ceil(bookEntries.length / effectiveCols);
    const bookVirtualizer = useVirtualizer({
        count: bookRowCount,
        getScrollElement: useCallback(() => scrollRef.current, []),
        estimateSize: getBookRowSize,
        overscan: 3,
    });

    useLayoutEffect(() => {
        bookVirtualizer.measure();
    }, [bookVirtualizer, effectiveCols]);

    return (
        <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto min-h-0 scrollbar-solid [content-visibility:auto] overscroll-contain h-full"
        >
            <div className="flex flex-col px-4 sm:px-6 md:px-8 py-6 space-y-6 max-w-7xl mx-auto w-full">
            {/* Header & Catalog Tabs */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[var(--color-border)] pb-5">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-[color:var(--color-text-primary)]">
                        Catalogs
                    </h1>
                    <p className="text-xs text-[color:var(--color-text-muted)] mt-1">
                        Browse and download free books directly into your library.
                    </p>
                </div>

                {/* Catalog Pills Selector */}
                <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:pb-0 scrollbar-none">
                    {catalogs.map((catalog) => {
                        const isActive = activeCatalog?.id === catalog.id;
                        return (
                            <div key={catalog.id} className="relative group shrink-0">
                                <button
                                    onClick={() => setActiveCatalog(catalog.id)}
                                    className={cn(
                                        "px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors flex items-center gap-1.5",
                                        isActive
                                            ? "bg-[var(--color-text-primary)] text-[var(--color-background)]"
                                            : "bg-[var(--color-surface-muted)] text-[color:var(--color-text-secondary)] hover:bg-[var(--color-border)] hover:text-[color:var(--color-text-primary)]"
                                    )}
                                >
                                    <Globe className="h-3 w-3" />
                                    <span>{catalog.title}</span>
                                </button>
                                {!catalog.isPreset && (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            removeCatalog(catalog.id);
                                            toast.success("Catalog removed");
                                        }}
                                        className="hidden group-hover:flex absolute -top-1 -right-1 h-4 w-4 bg-zinc-800 text-white rounded-full items-center justify-center text-[9px] hover:bg-red-600"
                                        title="Remove catalog"
                                    >
                                        <X className="h-2.5 w-2.5" />
                                    </button>
                                )}
                            </div>
                        );
                    })}

                    <button
                        onClick={() => setIsAddModalOpen(true)}
                        className="px-3 py-1.5 rounded-full border border-dashed border-[var(--color-border)] text-xs font-medium text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] hover:border-[var(--color-text-secondary)] flex items-center gap-1 shrink-0"
                    >
                        <Plus className="h-3 w-3" />
                        <span>Add Library</span>
                    </button>
                </div>
            </div>

            {/* Navigation & Search Bar */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                    {feedHistory.length > 0 && (
                        <button
                            onClick={navigateBack}
                            className="p-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] transition-colors shrink-0"
                            aria-label="Back"
                        >
                            <ArrowLeft className="h-4 w-4" />
                        </button>
                    )}
                    <h2 className="text-sm font-semibold text-[color:var(--color-text-primary)] truncate">
                        {feed?.title || activeCatalog?.title || "Catalog"}
                    </h2>
                </div>

                {/* Always rendered: gating this on `feed.searchUrlTemplate` meant
                    catalogs without an OpenSearch endpoint had no search at all. */}
                <form onSubmit={handleSearchSubmit} className="relative sm:w-72 md:w-80 shrink-0">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[color:var(--color-text-muted)]" />
                    <input
                        type="search"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search books or authors…"
                        aria-label="Search this catalog"
                        className="w-full h-8 pl-8 pr-14 text-xs bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md text-[color:var(--color-text-primary)] placeholder-[color:var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)] transition-colors"
                    />
                    {isSearching ? (
                        <RefreshCw className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[color:var(--color-text-muted)] animate-spin" />
                    ) : (
                        searchQuery && (
                            <button
                                type="button"
                                onClick={clearSearch}
                                aria-label="Clear search"
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)]"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        )
                    )}
                </form>
            </div>

            {/* Main Content Area */}
            {isLoading ? (
                <CatalogSkeleton />
            ) : error ? (
                <div className="flex flex-col items-center justify-center py-16 text-center space-y-3 bg-[var(--color-surface-muted)] rounded-xl border border-[var(--color-border)] p-6">
                    <Globe className="h-8 w-8 text-[color:var(--color-text-muted)]" />
                    <p className="text-xs text-[color:var(--color-text-muted)] max-w-sm">{error}</p>
                    <button
                        onClick={() => targetUrl && void loadFeed(targetUrl)}
                        className="mt-2 px-3 py-1.5 bg-[var(--color-surface)] border border-[var(--color-border)] text-xs font-semibold rounded-md hover:bg-[var(--color-surface-muted)] flex items-center gap-1.5"
                    >
                        <RefreshCw className="h-3 w-3" />
                        <span>Try Again</span>
                    </button>
                </div>
            ) : (
                <div className="space-y-8">
                    {/* Category / Sub-feed Tiles */}
                    {navigationEntries.length > 0 && (
                        <div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                {navigationEntries.map((entry) => (
                                    <button
                                        key={entry.id}
                                        onClick={() => {
                                            if (entry.navUrl) navigateToFeed(entry.navUrl);
                                        }}
                                        className="flex items-center justify-between p-3.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-muted)] text-left transition-colors group"
                                    >
                                        <div className="flex items-center gap-3 min-w-0">
                                            <div className="h-8 w-8 rounded bg-[var(--color-surface-muted)] flex items-center justify-center shrink-0 group-hover:bg-[var(--color-border)]">
                                                <Folder className="h-4 w-4 text-[color:var(--color-text-secondary)]" />
                                            </div>
                                            <div className="min-w-0">
                                                <div className="text-xs font-semibold text-[color:var(--color-text-primary)] truncate">
                                                    {entry.title}
                                                </div>
                                                {entry.summary && (
                                                    <div className="text-[11px] text-[color:var(--color-text-muted)] truncate mt-0.5">
                                                        {entry.summary}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                        <ChevronRight className="h-4 w-4 text-[color:var(--color-text-muted)] group-hover:text-[color:var(--color-text-primary)] shrink-0 ml-2" />
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Book Cards Grid (virtualized) */}
                    {bookEntries.length > 0 ? (
                        <div>
                            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                                <h3 className="text-xs font-semibold text-[color:var(--color-text-secondary)]">
                                    {trimmedQuery
                                        ? `Results for “${trimmedQuery}”`
                                        : "Books"}
                                </h3>
                                <div className="flex items-baseline gap-3">
                                    {searchSource === "local" && trimmedQuery && (
                                        <span
                                            className="text-[10px] font-medium text-[color:var(--color-text-muted)] uppercase tracking-wider"
                                            title={
                                                feed?.searchUrlTemplate
                                                    ? "This catalog's search endpoint is unavailable — matching the titles on this page."
                                                    : "This catalog does not offer a search endpoint — matching the titles on this page."
                                            }
                                        >
                                            On this page
                                        </span>
                                    )}
                                    <span className="text-xs text-[color:var(--color-text-muted)] tabular-nums">
                                        {bookEntries.length.toLocaleString()}{" "}
                                        {bookEntries.length === 1 ? "title" : "titles"}
                                    </span>
                                </div>
                            </div>
                            <div
                                ref={gridRef}
                                style={{
                                    height: `${bookVirtualizer.getTotalSize()}px`,
                                    width: "100%",
                                    position: "relative",
                                }}
                            >
                                {bookVirtualizer.getVirtualItems().map((virtualRow) => {
                                    const startIndex = virtualRow.index * effectiveCols;
                                    const rowBooks = bookEntries.slice(
                                        startIndex,
                                        startIndex + effectiveCols,
                                    );

                                    return (
                                        <div
                                            key={virtualRow.index}
                                            style={{
                                                position: "absolute",
                                                top: 0,
                                                left: 0,
                                                width: "100%",
                                                transform: `translateY(${virtualRow.start}px)`,
                                            }}
                                        >
                                            <div
                                                style={{
                                                    display: "grid",
                                                    gridTemplateColumns: `repeat(${effectiveCols}, minmax(0, 1fr))`,
                                                    gap: `${BOOK_GRID_GAP}px`,
                                                }}
                                                className="w-full"
                                            >
                                                {rowBooks.map((entry) => (
                                                    <OpdsBookCard
                                                        key={entry.id}
                                                        entry={entry}
                                                        isDownloading={
                                                            downloadingEntryId === entry.id
                                                        }
                                                        onSelect={() => {
                                                            if (entry.navUrl && !entry.downloadUrl) {
                                                                navigateToFeed(entry.navUrl);
                                                            } else {
                                                                setSelectedEntry(entry);
                                                            }
                                                        }}
                                                        onDownload={() => void handleDownload(entry)}
                                                    />
                                                ))}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ) : trimmedQuery ? (
                        <div className="flex flex-col items-center justify-center py-16 text-center space-y-3">
                            <Search className="h-8 w-8 text-[color:var(--color-text-muted)]" />
                            <p className="text-xs font-medium text-[color:var(--color-text-secondary)]">
                                No results for &ldquo;{trimmedQuery}&rdquo;
                            </p>
                            {searchSource === "local" && (
                                <p className="text-[11px] text-[color:var(--color-text-muted)] max-w-sm">
                                    This catalog has no search endpoint, so only titles already
                                    loaded on this page were matched.
                                </p>
                            )}
                            <button
                                onClick={clearSearch}
                                className="mt-1 px-3 py-1.5 border border-[var(--color-border)] bg-[var(--color-surface)] text-xs font-semibold rounded-md text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] transition-colors"
                            >
                                Clear search
                            </button>
                        </div>
                    ) : navigationEntries.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-16 text-center space-y-2">
                            <BookOpen className="h-8 w-8 text-[color:var(--color-text-muted)]" />
                            <p className="text-xs font-medium text-[color:var(--color-text-secondary)]">No books found in this catalog.</p>
                        </div>
                    )}
                </div>
            )}

            {/* Book Details Modal */}
            <Modal isOpen={!!selectedEntry} onClose={() => setSelectedEntry(null)}>
                {selectedEntry && (
                    <>
                        <ModalHeader title={selectedEntry.title} onClose={() => setSelectedEntry(null)} />
                        <ModalBody className="space-y-4">
                            <div className="flex flex-col sm:flex-row gap-4">
                                {selectedEntry.coverUrl && (
                                    <div className="aspect-[2/3] w-24 shrink-0 bg-[var(--color-surface-muted)] overflow-hidden rounded border border-[var(--color-border)]">
                                        <img src={selectedEntry.coverUrl} alt={selectedEntry.title} className="h-full w-full object-cover" />
                                    </div>
                                )}
                                <div className="flex flex-col gap-1 min-w-0">
                                    <h4 className="text-sm font-bold text-[color:var(--color-text-primary)]">{selectedEntry.title}</h4>
                                    <p className="text-xs text-[color:var(--color-text-secondary)] font-medium">{selectedEntry.author || "Public Domain"}</p>
                                    {selectedEntry.publisher && (
                                        <p className="text-[11px] text-[color:var(--color-text-muted)]">Source: {selectedEntry.publisher}</p>
                                    )}
                                </div>
                            </div>
                            {selectedEntry.summary && (
                                <div className="border-t border-[var(--color-border)] pt-3">
                                    <p className="text-xs text-[color:var(--color-text-secondary)] leading-relaxed whitespace-pre-line max-h-48 overflow-y-auto">
                                        {selectedEntry.summary}
                                    </p>
                                </div>
                            )}
                        </ModalBody>
                        <ModalFooter>
                            <button
                                onClick={() => setSelectedEntry(null)}
                                className="px-4 py-2 border border-[var(--color-border)] text-xs font-semibold text-[color:var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)] rounded"
                            >
                                Close
                            </button>
                            {(selectedEntry.downloadUrl || selectedEntry.navUrl) && (
                                <button
                                    onClick={() => {
                                        void handleDownload(selectedEntry);
                                        setSelectedEntry(null);
                                    }}
                                    className="px-4 py-2 bg-[var(--color-text-primary)] text-[var(--color-background)] text-xs font-bold rounded hover:opacity-90 flex items-center gap-1.5"
                                >
                                    <Download className="h-3 w-3" />
                                    <span>Add to Library</span>
                                </button>
                            )}
                        </ModalFooter>
                    </>
                )}
            </Modal>

            {/* Add Custom Library Modal */}
            <Modal isOpen={isAddModalOpen} onClose={() => setIsAddModalOpen(false)}>
                <form onSubmit={handleAddCatalogSubmit}>
                    <ModalHeader title="Add Custom Library" onClose={() => setIsAddModalOpen(false)} />
                    <ModalBody className="space-y-4">
                        <div>
                            <label className="block text-xs font-medium text-[color:var(--color-text-secondary)] mb-1.5">
                                Library Name
                            </label>
                            <input
                                type="text"
                                value={newCatalogTitle}
                                onChange={(e) => setNewCatalogTitle(e.target.value)}
                                placeholder="e.g. My Calibre Server"
                                className="w-full h-9 bg-[var(--color-surface)] border border-[var(--color-border)] px-3 text-xs text-[color:var(--color-text-primary)] rounded focus:outline-none focus:border-[var(--color-accent)]"
                                required
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-[color:var(--color-text-secondary)] mb-1.5">
                                Catalog URL
                            </label>
                            <input
                                type="text"
                                value={newCatalogUrl}
                                onChange={(e) => setNewCatalogUrl(e.target.value)}
                                placeholder="http://192.168.1.100:8080/opds"
                                className="w-full h-9 bg-[var(--color-surface)] border border-[var(--color-border)] px-3 text-xs text-[color:var(--color-text-primary)] rounded focus:outline-none focus:border-[var(--color-accent)]"
                                required
                            />
                        </div>
                    </ModalBody>
                    <ModalFooter>
                        <button
                            type="button"
                            onClick={() => setIsAddModalOpen(false)}
                            className="px-4 py-2 border border-[var(--color-border)] text-xs font-medium text-[color:var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)] rounded"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            className="px-4 py-2 bg-[var(--color-text-primary)] text-[var(--color-background)] text-xs font-bold rounded hover:opacity-90"
                        >
                            Add Library
                        </button>
                    </ModalFooter>
                </form>
            </Modal>
            </div>
        </div>
    );
}
