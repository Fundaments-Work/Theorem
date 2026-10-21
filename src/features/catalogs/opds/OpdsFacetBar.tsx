import { X } from "lucide-react";
import { cn } from "../../../core/lib/utils";
import type { OpdsFacetGroup } from "../../../core/types";
import { Dropdown } from "../../../ui";
import { FILTER_CHIP_SELECTED, FILTER_CHIP_UNSELECTED_ON_SURFACE } from "../../../ui/filter-chips";
import {
    CATALOG_SORT_ORDERS,
    formatLabel,
    type CatalogFacetSelection,
    type CatalogFacets,
    type CatalogSortOrder,
} from "../catalog-facets";
import { languageName } from "./opds-ui-utils";

const chip = "shrink-0 border px-2.5 py-1.5 text-[11px] transition-colors";

/**
 * Two kinds of narrowing in one row. The server's own facets (OPDS facet groups, e.g. "Format",
 * "Language", sort links) are links to other lists and are followed; sorting and the language /
 * format chips act on the books already loaded, instantly.
 */
export function OpdsFacetBar({
    serverFacets,
    onServerFacet,
    available,
    selection,
    onSelection,
    showClientControls,
}: {
    serverFacets: OpdsFacetGroup[];
    onServerFacet: (href: string) => void;
    available: CatalogFacets;
    selection: CatalogFacetSelection;
    onSelection: (next: CatalogFacetSelection) => void;
    showClientControls: boolean;
}) {
    const hasLanguage = available.languages.length > 1;
    const hasFormat = available.formats.length > 1;
    const active = selection.language !== null || selection.format !== null;

    if (serverFacets.length === 0 && !showClientControls) return null;

    return (
        <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none" role="group" aria-label="Sort and filter">
            {serverFacets.map((group) => {
                // Nothing marked active means "no filter": show the group's name, not its first choice.
                const current = group.items.find((i) => i.active);
                return (
                    <Dropdown
                        key={group.title}
                        size="sm"
                        className="w-auto max-w-[18rem] shrink-0"
                        placeholder={group.title}
                        value={current?.href}
                        options={group.items.map((i) => ({
                            value: i.href,
                            label: `${group.title}: ${i.title}${i.count !== undefined ? ` (${i.count})` : ""}`,
                        }))}
                        onChange={(href) => {
                            if (href !== current?.href) onServerFacet(href);
                        }}
                    />
                );
            })}

            {showClientControls && (
                <>
                    <Dropdown
                        size="sm"
                        className="w-auto shrink-0"
                        value={selection.sortOrder}
                        options={CATALOG_SORT_ORDERS.map((o) => ({ value: o.id, label: o.label }))}
                        onChange={(sortOrder) => onSelection({ ...selection, sortOrder: sortOrder as CatalogSortOrder })}
                    />
                    {hasLanguage &&
                        available.languages.slice(0, 6).map((lang) => (
                            <button
                                key={lang}
                                type="button"
                                aria-pressed={selection.language === lang}
                                onClick={() => onSelection({ ...selection, language: selection.language === lang ? null : lang })}
                                className={cn(chip, selection.language === lang ? FILTER_CHIP_SELECTED : FILTER_CHIP_UNSELECTED_ON_SURFACE)}
                            >
                                {languageName(lang) ?? lang}
                            </button>
                        ))}
                    {hasFormat &&
                        available.formats.slice(0, 6).map((fmt) => (
                            <button
                                key={fmt}
                                type="button"
                                aria-pressed={selection.format === fmt}
                                onClick={() => onSelection({ ...selection, format: selection.format === fmt ? null : fmt })}
                                className={cn(chip, selection.format === fmt ? FILTER_CHIP_SELECTED : FILTER_CHIP_UNSELECTED_ON_SURFACE)}
                            >
                                {formatLabel(fmt)}
                            </button>
                        ))}
                    {active && (
                        <button
                            type="button"
                            onClick={() => onSelection({ ...selection, language: null, format: null })}
                            className="inline-flex shrink-0 items-center gap-1 px-2 py-1.5 text-[11px] text-[color:var(--color-text-secondary)] transition-colors hover:text-[color:var(--color-accent)]"
                        >
                            <X className="h-3 w-3" /> Clear
                        </button>
                    )}
                </>
            )}
        </div>
    );
}
