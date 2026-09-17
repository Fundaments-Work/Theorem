import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
    Globe,
    Plus,
    RefreshCw,
    Search,
    Sparkles,
    X,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { cn } from "../../core/lib/utils";
import { useOpdsStore } from "../../core/store";
import { DiscoverService, type DiscoverSection } from "../../core/services/DiscoverService";
import type { OpdsEntry } from "../../core/types";
import { Modal, ModalBody, ModalFooter, ModalHeader, PageLoader, TheoremBookCover } from "../../ui";
import { DiscoverBookCard } from "./components/DiscoverBookCard";
import { DiscoverCarousel } from "./components/DiscoverCarousel";
import { DiscoverDetailModal } from "./components/DiscoverDetailModal";

export function DiscoverPage() {
    const cachedInitialSections = useMemo(() => DiscoverService.getCachedSections(), []);
    const [sections, setSections] = useState<DiscoverSection[]>(cachedInitialSections);
    const [isLoading, setIsLoading] = useState(cachedInitialSections.length === 0);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [searchQuery, setSearchQuery] = useState("");
    const [searchResults, setSearchResults] = useState<OpdsEntry[]>([]);
    const [isSearching, setIsSearching] = useState(false);

    const [selectedBook, setSelectedBook] = useState<OpdsEntry | null>(null);
    const [isAddSourceOpen, setIsAddSourceOpen] = useState(false);
    const [newSourceTitle, setNewSourceTitle] = useState("");
    const [newSourceUrl, setNewSourceUrl] = useState("");

    const [isPending, startTransition] = useTransition();

    const addCatalog = useOpdsStore((state) => state.addCatalog);

    const scrollRef = useRef<HTMLDivElement>(null);
    const requestIdRef = useRef(0);
    const [containerWidth, setContainerWidth] = useState(1024);

    // Responsive columns matching Library grid exactly
    const effectiveCols = useMemo(() => {
        if (containerWidth >= 1536) return 8;
        if (containerWidth >= 1280) return 7;
        if (containerWidth >= 1024) return 5;
        if (containerWidth >= 768) return 4;
        if (containerWidth >= 640) return 3;
        return 2;
    }, [containerWidth]);

    // Track scroll container width for responsive virtualizer
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;

        const updateWidth = () => {
            setContainerWidth(el.clientWidth || 1024);
        };

        updateWidth();
        const ro = new ResizeObserver(updateWidth);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const loadDiscoverFeed = useCallback(async (forceRefresh = false) => {
        const currentReq = ++requestIdRef.current;
        if (forceRefresh) {
            setIsRefreshing(true);
        } else if (sections.length === 0) {
            setIsLoading(true);
        }
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
        } catch (err: any) {
            if (requestIdRef.current === currentReq) {
                console.warn("Discover load error:", err);
                if (sections.length === 0) {
                    startTransition(() => {
                        setError("Could not connect to online libraries.");
                    });
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
    }, [sections.length]);

    useEffect(() => {
        void loadDiscoverFeed(false);
    }, [loadDiscoverFeed]);

    const performSearch = useCallback(async (query: string) => {
        const trimmed = query.trim();
        if (!trimmed) {
            startTransition(() => {
                setSearchResults([]);
            });
            return;
        }

        setIsSearching(true);
        try {
            const results = await DiscoverService.search(trimmed);
            startTransition(() => {
                if (results && results.length > 0) {
                    setSearchResults(results);
                } else {
                    // Fallback search across currently loaded sections
                    const localMatches: OpdsEntry[] = [];
                    const qLower = trimmed.toLowerCase();
                    for (const section of sections) {
                        for (const b of section.books) {
                            if (
                                b.title.toLowerCase().includes(qLower) ||
                                (b.author && b.author.toLowerCase().includes(qLower)) ||
                                (b.summary && b.summary.toLowerCase().includes(qLower))
                            ) {
                                if (!localMatches.some((m) => m.id === b.id)) {
                                    localMatches.push(b);
                                }
                            }
                        }
                    }
                    setSearchResults(localMatches);
                }
            });
        } catch (err: any) {
            console.warn("Online search failed, searching local sections:", err);
            const localMatches: OpdsEntry[] = [];
            const qLower = trimmed.toLowerCase();
            for (const section of sections) {
                for (const b of section.books) {
                    if (
                        b.title.toLowerCase().includes(qLower) ||
                        (b.author && b.author.toLowerCase().includes(qLower))
                    ) {
                        if (!localMatches.some((m) => m.id === b.id)) {
                            localMatches.push(b);
                        }
                    }
                }
            }
            startTransition(() => {
                setSearchResults(localMatches);
            });
        } finally {
            setIsSearching(false);
        }
    }, [sections]);

    useEffect(() => {
        const timer = setTimeout(() => {
            if (searchQuery.trim().length >= 2) {
                void performSearch(searchQuery);
            } else if (!searchQuery.trim()) {
                startTransition(() => {
                    setSearchResults([]);
                });
            }
        }, 350);

        return () => clearTimeout(timer);
    }, [searchQuery, performSearch]);

    const handleSearchSubmit = (e?: React.FormEvent) => {
        e?.preventDefault();
        void performSearch(searchQuery);
    };

    const handleAddSourceSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!newSourceTitle.trim() || !newSourceUrl.trim()) return;

        let cleanUrl = newSourceUrl.trim();
        if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
            cleanUrl = `https://${cleanUrl}`;
        }

        addCatalog({
            title: newSourceTitle.trim(),
            url: cleanUrl,
        });

        setIsAddSourceOpen(false);
        setNewSourceTitle("");
        setNewSourceUrl("");
        toast.success(`Added "${newSourceTitle}" library source`);
    };

    // Virtualization setup for search results grid
    const searchRowCount = Math.ceil(searchResults.length / effectiveCols);
    const searchVirtualizer = useVirtualizer({
        count: searchRowCount,
        getScrollElement: useCallback(() => scrollRef.current, []),
        estimateSize: useCallback(() => 270, []),
        overscan: 2,
    });

    // Spotlight hero book (first book from the essentials list)
    const heroBook = sections[0]?.books?.[0] || null;

    const handleSelectBook = useCallback((entry: OpdsEntry) => {
        setSelectedBook(entry);
    }, []);

    return (
        <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto min-h-0 custom-scrollbar [content-visibility:auto] overscroll-contain h-full"
        >
            <div className="mx-auto w-full max-w-[var(--layout-content-max-width)] px-4 py-6 pb-12 sm:px-6 lg:px-8 lg:py-8 lg:pb-16 space-y-8 animate-fade-in">
                {/* Top Discovery Header */}
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[var(--color-border)] pb-5">
                    <div>
                        <div className="flex items-center gap-2.5">
                            <h1 className="text-2xl font-bold tracking-tight text-[color:var(--color-text-primary)]">
                                Discover
                            </h1>
                            <span className="px-2 py-0.5 border border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[10px] font-mono uppercase tracking-wider text-[color:var(--color-text-muted)]">
                                75,000+ Titles
                            </span>
                        </div>
                        <p className="text-xs text-[color:var(--color-text-muted)] mt-1">
                            Search over 75,000+ public domain classics, restored editions, and custom catalogs.
                        </p>
                    </div>

                    {/* Search Bar & Actions */}
                    <div className="flex flex-wrap items-center gap-2.5">
                        <form onSubmit={handleSearchSubmit} className="relative w-full sm:w-72 md:w-80">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[color:var(--color-text-muted)]" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => {
                                    setSearchQuery(e.target.value);
                                    if (!e.target.value.trim()) {
                                        startTransition(() => setSearchResults([]));
                                    }
                                }}
                                placeholder="Search 75,000+ classics, authors, subjects…"
                                className="w-full h-8 pl-8 pr-7 text-xs bg-[var(--color-surface)] border border-[var(--color-border)] text-[color:var(--color-text-primary)] placeholder-[color:var(--color-text-muted)] focus:outline-none focus:border-[var(--color-text-primary)] transition-colors"
                            />
                            {searchQuery && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setSearchQuery("");
                                        startTransition(() => setSearchResults([]));
                                    }}
                                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)]"
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            )}
                        </form>

                        <button
                            onClick={() => loadDiscoverFeed(true)}
                            disabled={isRefreshing || isLoading || isPending}
                            className="h-8 w-8 inline-flex items-center justify-center border border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] transition-colors shrink-0 disabled:opacity-50"
                            title="Refresh Discover catalog"
                            aria-label="Refresh catalog"
                        >
                            <RefreshCw className={cn("h-3.5 w-3.5", (isRefreshing || isPending) && "animate-spin")} />
                        </button>

                        <button
                            onClick={() => setIsAddSourceOpen(true)}
                            className="h-8 px-3 border border-[var(--color-border)] bg-[var(--color-surface)] text-xs font-semibold text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] transition-colors shrink-0 flex items-center gap-1.5"
                        >
                            <Plus className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">Add Source</span>
                        </button>
                    </div>
                </div>

                {/* Body Content */}
                {isLoading || isSearching ? (
                    <div className="flex flex-col items-center justify-center py-24">
                        <PageLoader message={isSearching ? "Searching 75,000+ catalog titles…" : "Loading curated library…"} />
                    </div>
                ) : error && sections.length === 0 && searchResults.length === 0 ? (
                    <div className="mx-auto w-full max-w-[26rem] min-w-0 px-4 sm:px-6 flex flex-col items-center justify-center py-20 text-center animate-fade-in">
                        <div className="mb-4 flex h-14 w-14 items-center justify-center border border-[var(--color-border)] bg-[var(--color-surface)]">
                            <Globe className="h-6 w-6 text-[color:var(--color-text-muted)] stroke-1" />
                        </div>
                        <h2 className="mb-2 text-base font-bold text-[color:var(--color-text-primary)]">
                            Could not connect to online libraries
                        </h2>
                        <p className="mx-auto w-full max-w-[22rem] break-words text-sm text-[color:var(--color-text-muted)] mb-6 leading-relaxed">
                            {error}
                        </p>
                        <button
                            onClick={() => loadDiscoverFeed(true)}
                            className="px-5 py-2.5 bg-[var(--color-surface)] border border-[var(--color-border)] text-xs font-bold text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] transition-colors"
                        >
                            Try Again
                        </button>
                    </div>
                ) : searchResults.length > 0 ? (
                    /* Virtualized Search Results Grid */
                    <div className="space-y-4 animate-fade-in">
                        <div className="flex items-center justify-between">
                            <h2 className="text-sm font-bold text-[color:var(--color-text-primary)]">
                                Search Results for "{searchQuery}"
                            </h2>
                            <span className="text-xs text-[color:var(--color-text-muted)]">
                                {searchResults.length} {searchResults.length === 1 ? "book" : "books"} found
                            </span>
                        </div>

                        <div
                            style={{
                                height: `${searchVirtualizer.getTotalSize()}px`,
                                width: "100%",
                                position: "relative",
                            }}
                        >
                            {searchVirtualizer.getVirtualItems().map((virtualRow) => {
                                const startIndex = virtualRow.index * effectiveCols;
                                const rowBooks = searchResults.slice(startIndex, startIndex + effectiveCols);

                                return (
                                    <div
                                        key={virtualRow.index}
                                        data-index={virtualRow.index}
                                        ref={searchVirtualizer.measureElement}
                                        style={{
                                             position: "absolute",
                                             top: 0,
                                             left: 0,
                                             width: "100%",
                                             transform: `translateY(${virtualRow.start}px)`,
                                        }}
                                        className="pb-4"
                                    >
                                        <div
                                            style={{
                                                display: "grid",
                                                gridTemplateColumns: `repeat(${effectiveCols}, minmax(0, 1fr))`,
                                                gap: "20px",
                                            }}
                                            className="w-full"
                                        >
                                            {rowBooks.map((entry) => (
                                                <DiscoverBookCard
                                                    key={entry.id}
                                                    entry={entry}
                                                    onSelect={handleSelectBook}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ) : searchQuery.trim().length >= 2 && searchResults.length === 0 ? (
                    /* Search with No Results */
                    <div className="mx-auto w-full max-w-[26rem] min-w-0 px-4 sm:px-6 flex flex-col items-center justify-center py-20 text-center animate-fade-in">
                        <div className="mb-4 flex h-14 w-14 items-center justify-center border border-[var(--color-border)] bg-[var(--color-surface)]">
                            <Search className="h-6 w-6 text-[color:var(--color-text-muted)] stroke-1" />
                        </div>
                        <h2 className="mb-2 text-base font-bold text-[color:var(--color-text-primary)]">
                            No books found for &ldquo;{searchQuery}&rdquo;
                        </h2>
                        <p className="mx-auto w-full max-w-[22rem] break-words text-sm text-[color:var(--color-text-muted)] mb-6 leading-relaxed">
                            We couldn't find any public domain titles matching your search. Try searching by author, title, or topic.
                        </p>
                        <button
                            onClick={() => {
                                setSearchQuery("");
                                startTransition(() => setSearchResults([]));
                            }}
                            className="px-5 py-2.5 bg-[var(--color-surface)] border border-[var(--color-border)] text-xs font-bold text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)] transition-colors"
                        >
                            Clear Search
                        </button>
                    </div>
                ) : (
                    /* Editorial Storefront Mode */
                    <div className="space-y-12 animate-fade-in">
                        {/* Hero Spotlight Banner */}
                        {heroBook && (
                            <div
                                onClick={() => setSelectedBook(heroBook)}
                                className="relative overflow-hidden border border-[var(--color-border)] bg-gradient-to-br from-[var(--color-surface)] via-[var(--color-surface-muted)] to-[var(--color-surface)] p-6 sm:p-8 cursor-pointer group shadow-sm hover:shadow-md transition-[box-shadow,border-color] duration-200 ease-out"
                            >
                                <div className="flex flex-col sm:flex-row items-center sm:items-start gap-6 sm:gap-8">
                                    <div className="aspect-[2/3] w-32 sm:w-40 shrink-0 overflow-hidden border border-[var(--color-border)] shadow-lg group-hover:scale-105 transition-transform duration-300">
                                        <TheoremBookCover
                                            title={heroBook.title}
                                            author={heroBook.author}
                                            coverUrl={heroBook.coverUrl || heroBook.thumbnailUrl}
                                            badge="FEATURED CLASSIC"
                                        />
                                    </div>

                                    <div className="flex flex-col justify-between space-y-4 text-center sm:text-left min-w-0 flex-1">
                                        <div className="space-y-2">
                                            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-[var(--color-surface)] border border-[var(--color-border)] text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-accent)]">
                                                <Sparkles className="h-3 w-3" />
                                                <span>Featured Classic</span>
                                            </div>
                                            <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-[color:var(--color-text-primary)]">
                                                {heroBook.title}
                                            </h2>
                                            <p className="text-xs font-semibold text-[color:var(--color-text-secondary)]">
                                                {heroBook.author || "Public Domain"}
                                            </p>
                                            {heroBook.summary && (
                                                <p className="text-xs text-[color:var(--color-text-muted)] line-clamp-3 leading-relaxed max-w-2xl pt-1">
                                                    {heroBook.summary}
                                                </p>
                                            )}
                                        </div>

                                        <div className="flex items-center justify-center sm:justify-start gap-3 pt-2">
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setSelectedBook(heroBook);
                                                }}
                                                className="px-5 py-2.5 bg-[var(--color-text-primary)] text-[var(--color-background)] text-xs font-bold hover:opacity-90 transition-opacity"
                                            >
                                                View Book
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Curated Horizontal Carousels */}
                        {sections.map((section) => (
                            <DiscoverCarousel
                                key={section.id}
                                section={section}
                                onSelectBook={handleSelectBook}
                            />
                        ))}
                    </div>
                )}

                {/* Book Detail Modal */}
                <DiscoverDetailModal
                    entry={selectedBook}
                    onClose={() => setSelectedBook(null)}
                />

                {/* Add Custom Source Modal */}
                <Modal isOpen={isAddSourceOpen} onClose={() => setIsAddSourceOpen(false)}>
                    <form onSubmit={handleAddSourceSubmit}>
                        <ModalHeader title="Add Library Source" onClose={() => setIsAddSourceOpen(false)} />
                        <ModalBody className="space-y-4">
                            <div>
                                <label className="block text-xs font-semibold text-[color:var(--color-text-secondary)] mb-1.5">
                                    Source Name
                                </label>
                                <input
                                    type="text"
                                    value={newSourceTitle}
                                    onChange={(e) => setNewSourceTitle(e.target.value)}
                                    placeholder="e.g. My Calibre Server"
                                    className="w-full h-9 bg-[var(--color-surface)] border border-[var(--color-border)] px-3 text-xs text-[color:var(--color-text-primary)] focus:outline-none focus:border-[var(--color-text-primary)]"
                                    required
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-semibold text-[color:var(--color-text-secondary)] mb-1.5">
                                    OPDS / Feed URL
                                </label>
                                <input
                                    type="text"
                                    value={newSourceUrl}
                                    onChange={(e) => setNewSourceUrl(e.target.value)}
                                    placeholder="http://192.168.1.100:8080/opds"
                                    className="w-full h-9 bg-[var(--color-surface)] border border-[var(--color-border)] px-3 text-xs text-[color:var(--color-text-primary)] focus:outline-none focus:border-[var(--color-text-primary)]"
                                    required
                                />
                            </div>
                        </ModalBody>
                        <ModalFooter>
                            <button
                                type="button"
                                onClick={() => setIsAddSourceOpen(false)}
                                className="px-4 py-2 border border-[var(--color-border)] text-xs font-semibold text-[color:var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)]"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                className="px-4 py-2 bg-[var(--color-text-primary)] text-[var(--color-background)] text-xs font-bold hover:opacity-90"
                            >
                                Add Source
                            </button>
                        </ModalFooter>
                    </form>
                </Modal>
            </div>
        </div>
    );
}

export default DiscoverPage;
