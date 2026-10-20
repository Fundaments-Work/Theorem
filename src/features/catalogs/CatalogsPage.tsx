import { useEffect, useRef, useState } from "react";
import { Compass, Library, Lock, Plus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "../../core/lib/utils";
import { useOpdsStore } from "../../core/store";
import { DiscoverPage } from "./DiscoverPage";
import { AddCatalogModal } from "./opds/AddCatalogModal";
import { OpdsBrowser } from "./opds/OpdsBrowser";

const sourceChip =
    "flex shrink-0 items-center gap-1.5 whitespace-nowrap border border-[var(--color-border)] px-3 py-2 font-sans text-xs transition-colors";

/**
 * Discover: the curated storefront plus every catalog you have added, switched from one row of
 * sources. A catalog opens in place with its own sections, search and filters; the Library
 * downloads land in is the same one everywhere.
 */
export function CatalogsPage() {
    const catalogs = useOpdsStore((s) => s.catalogs);
    const activeId = useOpdsStore((s) => s.activeCatalogId);
    const setActive = useOpdsStore((s) => s.setActiveCatalog);
    const addCatalog = useOpdsStore((s) => s.addCatalog);
    const scrollRef = useRef<HTMLDivElement>(null);
    const tabsRef = useRef<HTMLDivElement>(null);
    const [adding, setAdding] = useState(false);

    const active = activeId ? catalogs.find((c) => c.id === activeId) : undefined;

    // On a phone the row of sources scrolls; keep the one you are on (or just added) in view.
    useEffect(() => {
        const selected = tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
        selected?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
    }, [active?.id, catalogs.length]);

    const switchTo = (id: string | null) => {
        setActive(id);
        scrollRef.current?.scrollTo({ top: 0 });
    };

    return (
        <div className="flex h-full min-h-0 flex-1 flex-col">
            <div className="border-b border-[var(--color-border)] px-4 py-3 sm:px-6 lg:px-8">
                <div className="mx-auto w-full max-w-[var(--layout-content-max-width)]">
                    <div className="flex items-center gap-1">
                        <div
                            ref={tabsRef}
                            role="tablist"
                            aria-label="Catalog sources"
                            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none"
                        >
                            <button
                                type="button"
                                role="tab"
                                aria-selected={!active}
                                onClick={() => switchTo(null)}
                                className={cn(sourceChip, !active ? "ui-selected" : "bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]")}
                            >
                                <Compass className="h-3.5 w-3.5" /> Discover
                            </button>
                            {catalogs.map((c) => (
                                <button
                                    key={c.id}
                                    type="button"
                                    role="tab"
                                    aria-selected={active?.id === c.id}
                                    onClick={() => switchTo(c.id)}
                                    className={cn(
                                        sourceChip,
                                        active?.id === c.id ? "ui-selected" : "bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]",
                                    )}
                                >
                                    <Library className="h-3.5 w-3.5" />
                                    {c.title}
                                    {c.auth && <Lock className="h-3 w-3 opacity-60" aria-label="Signed in" />}
                                </button>
                            ))}
                        </div>
                        {/* Outside the scroller so it is always reachable, however many sources there are. */}
                        <button
                            type="button"
                            onClick={() => setAdding(true)}
                            className={cn(sourceChip, "bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-accent)]")}
                            aria-label="Add a catalog"
                        >
                            <Plus className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">Add</span>
                        </button>
                    </div>
                </div>
            </div>

            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-solid">
                <div className="mx-auto w-full max-w-[var(--layout-content-max-width)] px-4 py-6 pb-12 sm:px-6 lg:px-8 lg:py-8 lg:pb-16">
                    {active ? <OpdsBrowser key={active.id} catalog={active} scrollRef={scrollRef} /> : <DiscoverPage scrollRef={scrollRef} />}
                </div>
            </div>

            <AddCatalogModal
                isOpen={adding}
                onClose={() => setAdding(false)}
                onAdd={(catalog) => {
                    addCatalog(catalog);
                    toast.success(`Added “${catalog.title}”`);
                }}
            />
        </div>
    );
}

export default CatalogsPage;
