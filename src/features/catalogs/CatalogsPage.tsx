import { useEffect, useRef, useState } from "react";
import { Compass, Library, Lock, Plus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "../../core/lib/utils";
import { useOpdsStore } from "../../core/store";
import { DiscoverHome } from "./DiscoverHome";
import { AddCatalogModal } from "./opds/AddCatalogModal";
import { OpdsBrowser } from "./opds/OpdsBrowser";

const sourceChip =
    "flex shrink-0 items-center gap-1.5 whitespace-nowrap border border-[var(--color-border)] px-3 py-2 font-sans text-xs transition-colors";

/**
 * Discover. Its home is Fundaments' own catalog (curated on the server), laid out as a front page
 * by `DiscoverHome`; it is the page itself, not one source among others. Catalogs the reader adds
 * (a school, a university, their own Calibre) appear as tabs next to it, and only then is there a
 * tab row at all. The Library downloads land in is the same one everywhere.
 */
export function CatalogsPage() {
    const catalogs = useOpdsStore((s) => s.catalogs);
    const activeId = useOpdsStore((s) => s.activeCatalogId);
    const setActive = useOpdsStore((s) => s.setActiveCatalog);
    const addCatalog = useOpdsStore((s) => s.addCatalog);
    const scrollRef = useRef<HTMLDivElement>(null);
    const tabsRef = useRef<HTMLDivElement>(null);
    const [adding, setAdding] = useState(false);

    const builtIn = catalogs.find((c) => c.isPreset);
    const added = catalogs.filter((c) => !c.isPreset);
    // A remembered catalog that was removed, or the built-in one, both mean the Discover home.
    const active = activeId ? added.find((c) => c.id === activeId) : undefined;

    // On a phone the row of tabs scrolls; keep the one you are on (or just added) in view.
    useEffect(() => {
        const selected = tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
        selected?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
    }, [active?.id, added.length]);

    const switchTo = (id: string | null) => {
        setActive(id);
        scrollRef.current?.scrollTo({ top: 0 });
    };

    const tab = (selected: boolean) =>
        cn(sourceChip, selected ? "ui-selected" : "bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]");

    return (
        <div className="flex h-full min-h-0 flex-1 flex-col">
            {added.length > 0 && (
                <div className="border-b border-[var(--color-border)] px-4 py-3 sm:px-6 lg:px-8">
                    <div className="mx-auto w-full max-w-[var(--layout-content-max-width)]">
                        <div className="flex items-center gap-1">
                            <div
                                ref={tabsRef}
                                role="tablist"
                                aria-label="Catalog sources"
                                className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none"
                            >
                                <button type="button" role="tab" aria-selected={!active} onClick={() => switchTo(null)} className={tab(!active)}>
                                    <Compass className="h-3.5 w-3.5" /> Discover
                                </button>
                                {added.map((c) => (
                                    <button key={c.id} type="button" role="tab" aria-selected={active?.id === c.id} onClick={() => switchTo(c.id)} className={tab(active?.id === c.id)}>
                                        <Library className="h-3.5 w-3.5" />
                                        {c.title}
                                        {c.auth && <Lock className="h-3 w-3 opacity-60" aria-label="Signed in" />}
                                    </button>
                                ))}
                            </div>
                            {/* Outside the scroller so it is always reachable, however many tabs there are. */}
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
            )}

            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-solid">
                <div className="mx-auto w-full max-w-[var(--layout-content-max-width)] px-4 py-6 pb-12 sm:px-6 lg:px-8 lg:py-8 lg:pb-16">
                    {active ? (
                        <OpdsBrowser key={active.id} catalog={active} scrollRef={scrollRef} />
                    ) : builtIn ? (
                        <OpdsBrowser
                            key={builtIn.id}
                            // Shown as "Discover" in the trail: it is the page, not a third-party source.
                            catalog={{ ...builtIn, title: "Discover" }}
                            scrollRef={scrollRef}
                            searchPlaceholder="Search free books"
                            renderHome={(ctx) => (
                                <DiscoverHome {...ctx} onAddCatalog={() => setAdding(true)} addInHeader={added.length === 0} />
                            )}
                        />
                    ) : null}
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
