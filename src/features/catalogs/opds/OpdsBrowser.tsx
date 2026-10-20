import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { ArrowLeft, ChevronRight, Globe, Loader2, MoreHorizontal, RefreshCw, Search, Trash2, X } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { toast } from "sonner";
import { cn } from "../../../core/lib/utils";
import { rankByFuzzyQuery } from "../../../core/lib/search/fuzzy";
import { useOpdsStore } from "../../../core/store";
import { sanitizeHtml } from "../../../core/lib/sanitize";
import type { OpdsCatalog, OpdsEntry, OpdsNavItem } from "../../../core/types";
import { ConfirmDialog } from "../../../ui";
import { DiscoverCarousel } from "../components/DiscoverCarousel";
import {
    applyCatalogFacets,
    collectCatalogFacets,
    type CatalogFacetSelection,
} from "../catalog-facets";
import { OpdsAuthPanel } from "./OpdsAuthPanel";
import { OpdsEntrySheet } from "./OpdsEntrySheet";
import { OpdsFacetBar } from "./OpdsFacetBar";
import { OpdsGrid } from "./OpdsGrid";
import { OpdsNavList } from "./OpdsNavList";
import { useCatalogDownload } from "./useCatalogDownload";
import { useInLibrary } from "./useInLibrary";
import { useOpdsBrowser } from "./useOpdsBrowser";

const DEFAULT_SELECTION: CatalogFacetSelection = { sortOrder: "catalog", language: null, format: null };

function Skeleton() {
    return (
        <div className="space-y-8" aria-hidden="true" data-opds-skeleton="">
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                {Array.from({ length: 3 }, (_, i) => (
                    <div key={i} className="h-[62px] animate-pulse border border-[var(--color-border)] bg-[var(--color-surface-muted)]" />
                ))}
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7">
                {Array.from({ length: 14 }, (_, i) => (
                    <div key={i} className="flex flex-col">
                        <div className="aspect-[2/3] w-full animate-pulse border border-[var(--color-border)] bg-[var(--color-surface-muted)]" />
                        <div className="mt-2 h-3 w-4/5 animate-pulse bg-[var(--color-surface-muted)]" />
                        <div className="mt-1.5 h-2.5 w-3/5 animate-pulse bg-[var(--color-surface-muted)]" />
                    </div>
                ))}
            </div>
        </div>
    );
}

/** Where you are: Catalog › Popular › Search: dune. Earlier steps are links. */
function Trail({ crumbs, onGo }: { crumbs: { title: string }[]; onGo: (index: number) => void }) {
    if (crumbs.length < 2) return null;
    return (
        <nav aria-label="Catalog trail" className="flex min-w-0 items-center gap-1 overflow-x-auto pb-1 text-xs scrollbar-none">
            {crumbs.map((crumb, i) => {
                const last = i === crumbs.length - 1;
                return (
                    <span key={`${i}-${crumb.title}`} className="flex shrink-0 items-center gap-1">
                        {i > 0 && <ChevronRight className="h-3 w-3 text-[color:var(--color-text-muted)]" />}
                        {last ? (
                            <span aria-current="page" className="max-w-[16rem] truncate text-[color:var(--color-text-primary)]">
                                {crumb.title}
                            </span>
                        ) : (
                            <button
                                type="button"
                                onClick={() => onGo(i)}
                                className="max-w-[10rem] truncate text-[color:var(--color-text-secondary)] transition-colors hover:text-[color:var(--color-accent)]"
                            >
                                {crumb.title}
                            </button>
                        )}
                    </span>
                );
            })}
        </nav>
    );
}

/**
 * Browse one OPDS catalog: its sections, shelves, search, filters and books, with downloads going
 * straight into the Library. Looks and behaves like the rest of the app (same cards, chips and
 * spacing as Discover and Library); everything catalog-specific lives in `useOpdsBrowser`.
 */
export function OpdsBrowser({ catalog, scrollRef }: { catalog: OpdsCatalog; scrollRef: RefObject<HTMLElement | null> }) {
    const browser = useOpdsBrowser(catalog);
    const { state } = browser;
    const removeCatalog = useOpdsStore((s) => s.removeCatalog);
    const inLibrary = useInLibrary();
    const { download, isBusy } = useCatalogDownload(browser.auth);

    const [selected, setSelected] = useState<OpdsEntry | null>(null);
    const [query, setQuery] = useState("");
    const [localOnly, setLocalOnly] = useState(false);
    const [selection, setSelection] = useState<CatalogFacetSelection>(DEFAULT_SELECTION);
    const [confirmRemove, setConfirmRemove] = useState(false);
    const [triedUser, setTriedUser] = useState("");

    const feed = state.feed;
    const title = feed?.title && state.crumbs.length > 1 ? feed.title : catalog.title;
    const serverSearch = browser.canSearch && !localOnly;

    // A new list starts with the catalog's own order and no narrowing; the search box clears with it.
    const listKey = state.crumbs[state.crumbs.length - 1]?.url;
    useEffect(() => {
        setSelection(DEFAULT_SELECTION);
        setLocalOnly(false);
        if (!state.searchQuery) setQuery("");
    }, [listKey, state.searchQuery]);

    // A list that is a single book (the page a "book" row leads to) opens that book directly.
    const autoOpened = useRef<string | null>(null);
    useEffect(() => {
        if (state.status !== "ready" || state.crumbs.length < 2 || state.searchQuery) return;
        if (state.entries.length === 1 && state.navigation.length === 0 && autoOpened.current !== listKey) {
            autoOpened.current = listKey ?? null;
            setSelected(state.entries[0]);
        }
    }, [state.status, state.entries, state.navigation.length, state.crumbs.length, state.searchQuery, listKey]);

    // Local filtering: when the catalog has no search of its own, or its search just failed.
    const localQuery = serverSearch ? "" : query.trim();
    const matchedEntries = useMemo(() => {
        if (!localQuery) return state.entries;
        return rankByFuzzyQuery(state.entries, localQuery, { keys: [{ name: "title", weight: 2 }, "authors"], limit: 1000 }).map((r) => r.item);
    }, [state.entries, localQuery]);
    const matchedNav = useMemo(() => {
        if (!localQuery) return state.navigation;
        return rankByFuzzyQuery(state.navigation, localQuery, { keys: [{ name: "title", weight: 2 }, "summary"], limit: 200 }).map((r) => r.item);
    }, [state.navigation, localQuery]);

    const facetsAvailable = useMemo(() => collectCatalogFacets(state.entries), [state.entries]);
    const visibleEntries = useMemo(() => applyCatalogFacets(matchedEntries, selection), [matchedEntries, selection]);
    const showClientControls = state.entries.length > 1;

    const submitSearch = async (e: FormEvent) => {
        e.preventDefault();
        const q = query.trim();
        if (!q || !serverSearch) return;
        const ok = await browser.search(q);
        if (!ok) {
            setLocalOnly(true);
            toast.message("This catalog's search isn't available right now. Filtering what's loaded instead.");
        }
    };

    const clearSearchBox = () => {
        setQuery("");
        setLocalOnly(false);
        if (state.searchQuery) browser.clearSearch();
    };

    const openNav = (item: OpdsNavItem) => browser.open(item.href, item.title);
    const getEntry = (entry: OpdsEntry) => void download(entry);

    const loading = state.status === "loading";
    const firstLoad = loading && !feed;
    const noResults = state.status === "ready" && visibleEntries.length === 0 && matchedNav.length === 0 && state.groups.length === 0;
    const isCustom = !catalog.isPreset;

    return (
        <div className="space-y-5">
            {/* Header: back, title, search, actions */}
            <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2.5">
                    {state.crumbs.length > 1 && (
                        <button
                            type="button"
                            onClick={browser.back}
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-[color:var(--color-text-secondary)] transition-colors hover:text-[color:var(--color-accent)]"
                            aria-label="Back"
                        >
                            <ArrowLeft className="h-4 w-4" />
                        </button>
                    )}
                    <div className="min-w-0 flex-1">
                        <h2 className="truncate text-lg text-[color:var(--color-text-primary)]">{title}</h2>
                        {feed?.subtitle && state.crumbs.length === 1 && (
                            <p className="truncate text-xs text-[color:var(--color-text-muted)]">{feed.subtitle}</p>
                        )}
                    </div>

                    <button
                        type="button"
                        onClick={browser.refresh}
                        disabled={loading}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-[color:var(--color-text-secondary)] transition-colors hover:text-[color:var(--color-accent)] disabled:opacity-50"
                        aria-label="Refresh"
                        title="Refresh"
                    >
                        <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
                    </button>

                    <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                            <button
                                type="button"
                                className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-[color:var(--color-text-secondary)] transition-colors hover:text-[color:var(--color-accent)]"
                                aria-label="Catalog options"
                            >
                                <MoreHorizontal className="h-4 w-4" />
                            </button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                            <DropdownMenu.Content
                                align="end"
                                sideOffset={4}
                                className="z-[var(--z-popover,60)] min-w-44 border border-[var(--color-border)] bg-[var(--color-surface-elevated)] py-1 text-xs shadow-lg"
                            >
                                <DropdownMenu.Item
                                    onSelect={browser.refresh}
                                    className="cursor-pointer px-3 py-2 text-[color:var(--color-text-secondary)] outline-none data-[highlighted]:text-[color:var(--color-accent)]"
                                >
                                    Refresh
                                </DropdownMenu.Item>
                                {catalog.auth && (
                                    <DropdownMenu.Item
                                        onSelect={browser.signOut}
                                        className="cursor-pointer px-3 py-2 text-[color:var(--color-text-secondary)] outline-none data-[highlighted]:text-[color:var(--color-accent)]"
                                    >
                                        Forget sign-in
                                    </DropdownMenu.Item>
                                )}
                                {isCustom && (
                                    <DropdownMenu.Item
                                        onSelect={() => setConfirmRemove(true)}
                                        className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[color:var(--color-error)] outline-none data-[highlighted]:opacity-80"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" /> Remove catalog
                                    </DropdownMenu.Item>
                                )}
                            </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                </div>

                <Trail crumbs={state.crumbs} onGo={browser.openAt} />

                {state.status !== "auth" && (feed || state.entries.length > 0 || browser.canSearch) && (
                    <form onSubmit={submitSearch} role="search" className="relative w-full sm:max-w-[28rem]">
                        <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[color:var(--color-text-muted)]" />
                        <input
                            type="search"
                            value={query}
                            onChange={(e) => {
                                setQuery(e.target.value);
                                if (!e.target.value.trim() && state.searchQuery) browser.clearSearch();
                            }}
                            placeholder={serverSearch ? `Search ${catalog.title}` : "Filter this list"}
                            aria-label={serverSearch ? `Search ${catalog.title}` : "Filter this list"}
                            className="h-8 w-full border border-[var(--color-border)] bg-[var(--color-surface)] pl-8 pr-7 text-xs text-[color:var(--color-text-primary)] placeholder-[color:var(--color-text-muted)] transition-colors focus:border-[var(--color-text-primary)] focus:outline-none [&::-webkit-search-cancel-button]:hidden"
                        />
                        {query && (
                            <button
                                type="button"
                                onClick={clearSearchBox}
                                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)]"
                                aria-label="Clear search"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        )}
                    </form>
                )}
            </div>

            {/* Body */}
            {state.status === "auth" ? (
                <OpdsAuthPanel
                    catalogTitle={catalog.title}
                    realm={state.error?.realm}
                    hint={state.error?.hint}
                    failed={state.signInFailed}
                    initialUsername={triedUser}
                    onSubmit={(creds, remember) => {
                        setTriedUser(creds.username);
                        browser.signIn(creds, remember);
                    }}
                />
            ) : state.status === "error" && !feed ? (
                <div className="mx-auto flex w-full max-w-[26rem] flex-col items-center py-16 text-center" role="alert">
                    <div className="mb-4 flex h-14 w-14 items-center justify-center border border-[var(--color-border)] bg-[var(--color-surface)]">
                        <Globe className="h-6 w-6 stroke-1 text-[color:var(--color-text-muted)]" />
                    </div>
                    <h3 className="mb-2 text-base text-[color:var(--color-text-primary)]">Couldn't open {catalog.title}</h3>
                    <p className="mb-6 break-words text-sm leading-relaxed text-[color:var(--color-text-muted)]">{state.error?.message}</p>
                    <button
                        type="button"
                        onClick={browser.refresh}
                        className="border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-2.5 text-xs text-[color:var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-muted)]"
                    >
                        Try again
                    </button>
                </div>
            ) : firstLoad ? (
                <Skeleton />
            ) : (
                <div className={cn("space-y-8 transition-opacity", loading && "pointer-events-none opacity-50")} aria-busy={loading}>
                    {state.status === "error" && (
                        <p role="alert" className="text-xs text-[color:var(--color-error)]">
                            {state.error?.message}
                        </p>
                    )}

                    {feed?.subtitle && state.crumbs.length > 1 && (
                        <p
                            className="max-w-[48rem] text-xs leading-relaxed text-[color:var(--color-text-muted)]"
                            dangerouslySetInnerHTML={{ __html: sanitizeHtml(feed.subtitle) }}
                        />
                    )}

                    <OpdsFacetBar
                        serverFacets={feed?.facets ?? []}
                        onServerFacet={browser.facet}
                        available={facetsAvailable}
                        selection={selection}
                        onSelection={setSelection}
                        showClientControls={showClientControls}
                    />

                    <OpdsNavList items={matchedNav} onOpen={openNav} />

                    {state.groups.map((group) => (
                        <div key={group.title + (group.href ?? "")} className="space-y-3">
                            {group.entries.length > 0 ? (
                                <DiscoverCarousel
                                    title={group.title}
                                    books={group.entries}
                                    inLibrary={inLibrary}
                                    isBusy={isBusy}
                                    onSelectBook={setSelected}
                                    onGetBook={getEntry}
                                    onSeeAll={group.href ? () => browser.open(group.href!, group.title) : undefined}
                                />
                            ) : (
                                <>
                                    <h2 className="text-base text-[color:var(--color-text-primary)]">{group.title}</h2>
                                    <OpdsNavList items={group.navigation} onOpen={openNav} />
                                </>
                            )}
                        </div>
                    ))}

                    {visibleEntries.length > 0 && (
                        <section className="space-y-3" aria-label="Books">
                            <p className="text-[11px] text-[color:var(--color-text-muted)]" data-opds-count="">
                                {feed?.totalResults && feed.totalResults > visibleEntries.length
                                    ? `${visibleEntries.length.toLocaleString()} of ${feed.totalResults.toLocaleString()} books`
                                    : `${visibleEntries.length.toLocaleString()} ${visibleEntries.length === 1 ? "book" : "books"}`}
                                {selection.language || selection.format ? " · filtered" : ""}
                            </p>
                            <OpdsGrid
                                entries={visibleEntries}
                                scrollRef={scrollRef}
                                inLibrary={inLibrary}
                                isBusy={isBusy}
                                onSelect={setSelected}
                                onGet={getEntry}
                                onNearEnd={feed?.nextUrl ? browser.loadMore : undefined}
                            />
                        </section>
                    )}

                    {feed?.nextUrl && (
                        <div className="flex flex-col items-center gap-2 pb-6">
                            {state.moreError && <p className="text-xs text-[color:var(--color-error)]">{state.moreError}</p>}
                            <button
                                type="button"
                                onClick={browser.loadMore}
                                disabled={state.loadingMore}
                                className="flex items-center gap-1.5 border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-xs text-[color:var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-muted)] disabled:opacity-60"
                            >
                                {state.loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                {state.loadingMore ? "Loading…" : state.moreError ? "Try again" : "Load more"}
                            </button>
                        </div>
                    )}

                    {noResults && (
                        <div className="py-16 text-center" data-opds-empty="">
                            <p className="text-sm text-[color:var(--color-text-primary)]">
                                {localQuery ? `Nothing matches “${localQuery}”` : state.searchQuery ? `No results for “${state.searchQuery}”` : "Nothing here yet"}
                            </p>
                            {(selection.language || selection.format) && (
                                <button
                                    type="button"
                                    onClick={() => setSelection(DEFAULT_SELECTION)}
                                    className="mt-3 text-xs text-[color:var(--color-accent)] hover:underline"
                                >
                                    Clear filters
                                </button>
                            )}
                            {(localQuery || state.searchQuery) && (
                                <button type="button" onClick={clearSearchBox} className="mt-3 block w-full text-xs text-[color:var(--color-accent)] hover:underline">
                                    Clear search
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}

            <OpdsEntrySheet
                entry={selected}
                auth={browser.auth}
                onClose={() => setSelected(null)}
                onOpenFeed={(href, label) => browser.open(href, label)}
            />

            <ConfirmDialog
                isOpen={confirmRemove}
                title="Remove catalog"
                message={`Remove “${catalog.title}” from your sources? Books you already added stay in your Library.`}
                confirmLabel="Remove"
                cancelLabel="Cancel"
                variant="danger"
                onConfirm={() => {
                    removeCatalog(catalog.id);
                    setConfirmRemove(false);
                }}
                onCancel={() => setConfirmRemove(false)}
            />
        </div>
    );
}
