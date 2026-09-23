
import { useState, useRef, useEffect, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Search, X, ChevronRight, ChevronUp, ChevronDown, CaseSensitive, WholeWord } from 'lucide-react';
import { cn } from "../../../core/lib/utils";
import { Backdrop, FloatingPanel, Spinner } from "../../../ui";

export interface ReaderSearchMatch {
    cfi: string;
    excerpt: string;
}

export interface ReaderSearchProgress {
    progress: number;
}

export type ReaderSearchEvent = ReaderSearchMatch | ReaderSearchProgress | 'done';

export interface ReaderSearchOptions {
    matchCase?: boolean;
    wholeWord?: boolean;
}

const LIVE_SEARCH_DEBOUNCE_MS = 220;
const MAX_SEARCH_RESULTS = 200;

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function highlightExcerpt(excerpt: string, query: string, matchCase = false, wholeWord = false): string {
    const safeExcerpt = escapeHtml(excerpt);
    const safeQuery = escapeHtml(query.trim());

    if (!safeQuery) {
        return safeExcerpt;
    }

    const flags = matchCase ? "g" : "gi";
    const pattern = wholeWord ? `\\b${escapeRegExp(safeQuery)}\\b` : escapeRegExp(safeQuery);
    try {
        const queryRegex = new RegExp(`(${pattern})`, flags);
        return safeExcerpt.replace(
            queryRegex,
            '<span class="bg-[var(--color-accent)]/20 text-[color:var(--color-accent)] font-bold">$1</span>',
        );
    } catch {
        return safeExcerpt;
    }
}

interface ReaderSearchProps {
    visible: boolean;
    onClose: () => void;
    onNavigate: (location: string) => void;
    onSearch: (query: string, options?: ReaderSearchOptions) => AsyncGenerator<ReaderSearchEvent>;
    onClearSearch: () => void;
    className?: string;
}

export function ReaderSearch({
    visible,
    onClose,
    onNavigate,
    onSearch,
    onClearSearch,
    className,
}: ReaderSearchProps) {
    const [query, setQuery] = useState('');
    const [matchCase, setMatchCase] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [results, setResults] = useState<ReaderSearchMatch[]>([]);
    const [activeMatchIndex, setActiveMatchIndex] = useState<number>(-1);
    const [isSearching, setIsSearching] = useState(false);
    const [progress, setProgress] = useState(0);
    const searchRef = useRef(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const onSearchRef = useRef(onSearch);
    const onClearSearchRef = useRef(onClearSearch);
    const liveSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    const resultVirtualizer = useVirtualizer({
        count: results.length,
        getScrollElement: useCallback(() => scrollRef.current, []),
        estimateSize: useCallback(() => 72, []),
        overscan: 5,
    });

    useEffect(() => {
        onSearchRef.current = onSearch;
    }, [onSearch]);

    useEffect(() => {
        onClearSearchRef.current = onClearSearch;
    }, [onClearSearch]);

    const clearLiveSearchTimer = useCallback(() => {
        if (liveSearchTimerRef.current) {
            clearTimeout(liveSearchTimerRef.current);
            liveSearchTimerRef.current = null;
        }
    }, []);

    const runSearch = useCallback(async (searchQuery: string, options?: ReaderSearchOptions) => {
        const normalizedQuery = searchQuery.trim();
        if (!normalizedQuery) return;

        setIsSearching(true);
        setResults([]);
        setActiveMatchIndex(-1);
        setProgress(0);
        searchRef.current++;
        const currentSearchId = searchRef.current;

        try {
            const iter = onSearchRef.current(normalizedQuery, options);
            for await (const result of iter) {
                if (currentSearchId !== searchRef.current) break;

                if (result === 'done') {
                    setProgress(100);
                    break;
                } else if (typeof result === 'object' && result !== null && 'progress' in result) {
                    setProgress(Math.round(result.progress * 100));
                } else if (typeof result === 'object' && result !== null && 'cfi' in result) {
                    setResults(prev => prev.length >= MAX_SEARCH_RESULTS ? prev : [...prev, result]);
                }
            }
        } catch {
        } finally {
            if (currentSearchId === searchRef.current) {
                setIsSearching(false);
            }
        }
    }, []);

    const handleClear = useCallback(() => {
        clearLiveSearchTimer();
        setQuery('');
        setResults([]);
        setActiveMatchIndex(-1);
        setIsSearching(false);
        setProgress(0);
        searchRef.current++;
        onClearSearchRef.current();
    }, [clearLiveSearchTimer]);

    const handleNavigate = useCallback((cfi: string, index?: number) => {
        if (typeof index === 'number') {
            setActiveMatchIndex(index);
        }
        onNavigate(cfi);
    }, [onNavigate]);

    const goToNextMatch = useCallback(() => {
        if (results.length === 0) return;
        const nextIndex = activeMatchIndex >= 0 ? (activeMatchIndex + 1) % results.length : 0;
        setActiveMatchIndex(nextIndex);
        onNavigate(results[nextIndex].cfi);
        resultVirtualizer.scrollToIndex(nextIndex, { align: 'auto' });
    }, [activeMatchIndex, results, onNavigate, resultVirtualizer]);

    const goToPrevMatch = useCallback(() => {
        if (results.length === 0) return;
        const prevIndex = activeMatchIndex >= 0 ? (activeMatchIndex - 1 + results.length) % results.length : results.length - 1;
        setActiveMatchIndex(prevIndex);
        onNavigate(results[prevIndex].cfi);
        resultVirtualizer.scrollToIndex(prevIndex, { align: 'auto' });
    }, [activeMatchIndex, results, onNavigate, resultVirtualizer]);

    const handleSearch = useCallback(async (e?: React.FormEvent) => {
        e?.preventDefault();
        const normalizedQuery = query.trim();
        if (!normalizedQuery) return;
        clearLiveSearchTimer();
        await runSearch(normalizedQuery, { matchCase, wholeWord });
    }, [clearLiveSearchTimer, query, matchCase, wholeWord, runSearch]);

    const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (results.length > 0) {
                if (e.shiftKey) {
                    goToPrevMatch();
                } else {
                    goToNextMatch();
                }
            } else {
                void handleSearch();
            }
        }
    }, [results.length, goToPrevMatch, goToNextMatch, handleSearch]);

    useEffect(() => {
        if (!visible) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "F3") {
                e.preventDefault();
                if (e.shiftKey) {
                    goToPrevMatch();
                } else {
                    goToNextMatch();
                }
            } else if (e.altKey && (e.key === "c" || e.key === "C")) {
                e.preventDefault();
                setMatchCase(prev => !prev);
            } else if (e.altKey && (e.key === "w" || e.key === "W")) {
                e.preventDefault();
                setWholeWord(prev => !prev);
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [visible, goToNextMatch, goToPrevMatch]);

    useEffect(() => {
        if (visible) {
            const timer = setTimeout(() => inputRef.current?.focus(), 100);
            return () => clearTimeout(timer);
        } else {
            handleClear();
        }
    }, [visible, handleClear]);

    useEffect(() => {
        clearLiveSearchTimer();
        if (!visible) {
            return;
        }

        const normalizedQuery = query.trim();
        if (!normalizedQuery) {
            setResults([]);
            setActiveMatchIndex(-1);
            setIsSearching(false);
            setProgress(0);
            searchRef.current++;
            onClearSearchRef.current();
            return;
        }

        liveSearchTimerRef.current = setTimeout(() => {
            liveSearchTimerRef.current = null;
            void runSearch(normalizedQuery, { matchCase, wholeWord });
        }, LIVE_SEARCH_DEBOUNCE_MS);

        return clearLiveSearchTimer;
    }, [clearLiveSearchTimer, query, matchCase, wholeWord, runSearch, visible]);

    useEffect(() => {
        return clearLiveSearchTimer;
    }, [clearLiveSearchTimer]);

    return (
        <>
            <Backdrop visible={visible} onClick={onClose} />

            <FloatingPanel visible={visible} className={cn('flex flex-col overflow-hidden', className)}>
                
                <div className="reader-panel-header px-4 pt-4 pb-3">
                    <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                            <h2 className="text-sm font-semibold text-[color:var(--color-text-primary)]">Search</h2>
                            {results.length > 0 && (
                                <span className="text-xs text-[color:var(--color-text-secondary)] font-mono bg-[var(--color-surface-muted)] px-1.5 py-0.5 rounded">
                                    {activeMatchIndex >= 0 ? `${activeMatchIndex + 1} / ${results.length}` : `${results.length}`}
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-1">
                            {results.length > 0 && (
                                <>
                                    <button
                                        type="button"
                                        onClick={goToPrevMatch}
                                        className="reader-chip w-7 h-7 inline-flex items-center justify-center transition-colors hover:bg-[var(--color-surface-muted)]"
                                        aria-label="Previous match (Shift+Enter / Shift+F3)"
                                        title="Previous match (Shift+Enter / Shift+F3)"
                                    >
                                        <ChevronUp className="w-4 h-4" />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={goToNextMatch}
                                        className="reader-chip w-7 h-7 inline-flex items-center justify-center transition-colors hover:bg-[var(--color-surface-muted)]"
                                        aria-label="Next match (Enter / F3)"
                                        title="Next match (Enter / F3)"
                                    >
                                        <ChevronDown className="w-4 h-4" />
                                    </button>
                                </>
                            )}
                            <button
                                onClick={onClose}
                                className="reader-chip w-8 h-8 inline-flex items-center justify-center transition-colors hover:opacity-80"
                                aria-label="Close search"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                    <form onSubmit={handleSearch} className="relative">
                        <label htmlFor="reader-search" className="sr-only">Search in document</label>
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[color:var(--color-text-muted)] pointer-events-none" />
                        <input
                            id="reader-search"
                            ref={inputRef}
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={handleInputKeyDown}
                            placeholder="Search in document..."
                            className="w-full h-10 pl-10 pr-24 bg-[var(--color-background)] text-sm border-2 border-transparent focus:border-[var(--color-accent)] transition-colors outline-none text-[color:var(--color-text-primary)]"
                        />
                        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                            {query && (
                                <button
                                    type="button"
                                    onClick={handleClear}
                                    className="p-1 hover:bg-[var(--color-surface-muted)] transition-colors text-[color:var(--color-text-muted)]"
                                    title="Clear search"
                                >
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => setMatchCase(prev => !prev)}
                                className={cn(
                                    "p-1 rounded transition-colors text-xs font-semibold",
                                    matchCase
                                        ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)]"
                                        : "text-[color:var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[color:var(--color-text-primary)]"
                                )}
                                title="Match Case (Alt+C)"
                                aria-pressed={matchCase}
                            >
                                <CaseSensitive className="w-4 h-4" />
                            </button>
                            <button
                                type="button"
                                onClick={() => setWholeWord(prev => !prev)}
                                className={cn(
                                    "p-1 rounded transition-colors text-xs font-semibold",
                                    wholeWord
                                        ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)]"
                                        : "text-[color:var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[color:var(--color-text-primary)]"
                                )}
                                title="Match Whole Word (Alt+W)"
                                aria-pressed={wholeWord}
                            >
                                <WholeWord className="w-4 h-4" />
                            </button>
                        </div>
                    </form>
                </div>

                {isSearching && (
                    <div className="h-1 bg-[var(--color-background)] overflow-hidden">
                        <div
                            className="h-full bg-[var(--color-accent)] transition-[width] duration-300"
                            style={{ width: `${progress}%` }}
                        />
                    </div>
                )}

                <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-2 sm:p-3 custom-scrollbar [content-visibility:auto] overscroll-contain">
                    {!query && !isSearching && results.length === 0 && (
                        <div className="w-full flex flex-col items-center justify-center py-12 px-6 text-center opacity-50">
                            <Search className="w-8 h-8 mb-3" />
                            <p className="w-full max-w-[15rem] text-xs font-medium leading-relaxed">Find words, names or phrases</p>
                        </div>
                    )}

                    {query && isSearching && results.length === 0 && (
                        <div className="w-full flex flex-col items-center justify-center py-12 px-6 text-center">
                            <Spinner size="sm" tone="accent" label="Scanning content" className="mb-3" />
                            <p className="w-full max-w-[15rem] text-xs text-[color:var(--color-text-muted)] leading-relaxed">Scanning content... {progress}%</p>
                        </div>
                    )}

                    {query && !isSearching && results.length === 0 && (
                        <div className="w-full flex flex-col items-center justify-center py-12 px-6 text-center opacity-70">
                            <h3 className="text-sm font-semibold mb-1">No results found</h3>
                            <p className="w-full max-w-[15rem] text-xs text-[color:var(--color-text-muted)] leading-relaxed">Try a different search term</p>
                        </div>
                    )}

                    <div style={{ height: resultVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
                        {resultVirtualizer.getVirtualItems().map((virtualRow) => {
                            const result = results[virtualRow.index];
                            const isActive = activeMatchIndex === virtualRow.index;
                            return (
                                <button
                                    key={virtualRow.key}
                                    data-index={virtualRow.index}
                                    onClick={() => handleNavigate(result.cfi, virtualRow.index)}
                                    className={cn(
                                        "w-full flex flex-col gap-1 p-3 hover:bg-[var(--color-background)] transition-colors text-left group absolute top-0 left-0",
                                        isActive && "bg-[var(--color-surface-muted)] border-l-2 border-[var(--color-accent)]"
                                    )}
                                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                                >
                                    <p
                                        className="text-[var(--font-size-caption)] text-[color:var(--color-text-secondary)] line-clamp-3 leading-relaxed"
                                        dangerouslySetInnerHTML={{
                                            __html: highlightExcerpt(result.excerpt, query, matchCase, wholeWord),
                                        }}
                                    />
                                    <div className="flex items-center gap-1.5 text-[var(--font-size-3xs)] text-[color:var(--color-accent)] font-bold uppercase tracking-wider opacity-0 group-hover:opacity-100 transition-opacity">
                                        <span>Jump to match</span>
                                        <ChevronRight className="w-3 h-3" />
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </div>

                {results.length > 0 && (
                    <div className="reader-panel-footer p-3 bg-[var(--color-background)] flex items-center justify-between">
                        <p className="text-[var(--font-size-3xs)] font-bold text-[color:var(--color-text-muted)] uppercase tracking-widest">
                            {activeMatchIndex >= 0 ? `Match ${activeMatchIndex + 1} of ${results.length}` : `${results.length} ${results.length === 1 ? 'Result' : 'Results'} found`}
                        </p>
                        <div className="flex items-center gap-1 sm:hidden">
                            <button
                                type="button"
                                onClick={goToPrevMatch}
                                className="reader-chip w-7 h-7 inline-flex items-center justify-center transition-colors"
                            >
                                <ChevronUp className="w-4 h-4" />
                            </button>
                            <button
                                type="button"
                                onClick={goToNextMatch}
                                className="reader-chip w-7 h-7 inline-flex items-center justify-center transition-colors"
                            >
                                <ChevronDown className="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                )}
            </FloatingPanel>
        </>
    );
}

export default ReaderSearch;
