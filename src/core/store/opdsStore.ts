import { create } from "zustand";
import { persist } from "zustand/middleware";
import { deferredJsonStorage, memoizePartialize } from "../lib/persist-storage";
import { DEFAULT_OPDS_PRESETS, normalizeCatalogUrl } from "../services/OpdsService";
import type { OpdsCatalog, OpdsCredentials } from "../types";

export interface OpdsState {
    catalogs: OpdsCatalog[];
    /** The catalog being browsed, or `null` for the built-in Fundaments catalog. */
    activeCatalogId: string | null;

    addCatalog: (catalog: Omit<OpdsCatalog, "id">) => string;
    removeCatalog: (id: string) => void;
    updateCatalog: (id: string, updates: Partial<OpdsCatalog>) => void;
    setCredentials: (id: string, auth: OpdsCredentials | undefined) => void;
    setActiveCatalog: (id: string | null) => void;
}

/** Sources that were built in before 1.6.0, when the app gained its own catalog. */
const FORMER_PRESET_IDS = new Set(["project-gutenberg", "standard-ebooks"]);

/** Keys of the client-side Discover storefront's cache, retired in 1.6.0. */
const RETIRED_STORAGE_KEYS = ["theorem_discover_cache_v3", "theorem_discover_cache_v2", "theorem_discover_cache"];

function withPresets(catalogs: unknown): OpdsCatalog[] {
    const list = Array.isArray(catalogs) ? (catalogs as OpdsCatalog[]) : [];
    // Presets are part of the app: always present, and always at the front.
    const presets = DEFAULT_OPDS_PRESETS.map((preset) => {
        const saved = list.find((c) => c.id === preset.id);
        return saved ? { ...preset, auth: saved.auth } : preset;
    });
    return [...presets, ...list.filter((c) => !c.isPreset && !DEFAULT_OPDS_PRESETS.some((p) => p.id === c.id))];
}

export const useOpdsStore = create<OpdsState>()(
    persist(
        (set) => ({
            catalogs: DEFAULT_OPDS_PRESETS,
            activeCatalogId: null,

            addCatalog: (catalog) => {
                const id = `catalog-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                const created: OpdsCatalog = { ...catalog, id, url: normalizeCatalogUrl(catalog.url) };
                set((state) => ({
                    catalogs: [...withPresets(state.catalogs), created],
                    activeCatalogId: id,
                }));
                return id;
            },

            removeCatalog: (id) => {
                set((state) => {
                    const target = state.catalogs.find((c) => c.id === id);
                    // Presets cannot be removed: they are the app's own sources.
                    if (!target || target.isPreset) return state;
                    return {
                        catalogs: state.catalogs.filter((c) => c.id !== id),
                        activeCatalogId: state.activeCatalogId === id ? null : state.activeCatalogId,
                    };
                });
            },

            updateCatalog: (id, updates) => {
                set((state) => ({
                    catalogs: state.catalogs.map((c) =>
                        c.id === id
                            ? { ...c, ...updates, ...(updates.url ? { url: normalizeCatalogUrl(updates.url) } : {}) }
                            : c,
                    ),
                }));
            },

            setCredentials: (id, auth) => {
                set((state) => ({
                    catalogs: state.catalogs.map((c) => (c.id === id ? { ...c, auth } : c)),
                }));
            },

            setActiveCatalog: (id) => {
                set((state) => {
                    if (id !== null && !state.catalogs.some((c) => c.id === id)) return state;
                    return { activeCatalogId: id };
                });
            },
        }),
        {
            name: "theorem-opds",
            version: 4,
            storage: deferredJsonStorage,
            partialize: memoizePartialize(
                (state) => [state.catalogs, state.activeCatalogId],
                (state) => ({
                    catalogs: state.catalogs,
                    activeCatalogId: state.activeCatalogId,
                }),
            ),
            migrate: (persisted: unknown, version: number) => {
                const state = (persisted ?? {}) as { catalogs?: OpdsCatalog[]; activeCatalogId?: string | null };
                let catalogs = Array.isArray(state.catalogs) ? state.catalogs : [];
                if (version < 2) {
                    catalogs = catalogs.map((c) => {
                        if (c?.url === "https://m.gutenberg.org/ebooks.opds/") return { ...c, url: "https://www.gutenberg.org/ebooks.opds/" };
                        return c;
                    });
                }
                let activeCatalogId: string | null = null;
                if (version < 4) {
                    // v4: Fundaments' own catalog replaces Project Gutenberg and Standard Ebooks as
                    // the built-in source (Discover's home now carries both). They were the app's
                    // defaults, not the reader's choice, so they go; one the reader signed in to
                    // (a Standard Ebooks patron) was a choice and stays as an ordinary catalog.
                    catalogs = catalogs.flatMap((c) => {
                        if (!c || !FORMER_PRESET_IDS.has(c.id)) return [c];
                        return c.auth ? [{ ...c, isPreset: false }] : [];
                    });
                    try {
                        for (const key of RETIRED_STORAGE_KEYS) localStorage.removeItem(key);
                    } catch {
                        // No storage (tests, private mode): nothing to clean.
                    }
                }
                if (version >= 3 && typeof state.activeCatalogId === "string") activeCatalogId = state.activeCatalogId;
                const migrated = withPresets(catalogs.filter((c) => c && typeof c.id === "string" && typeof c.url === "string"));
                // A remembered catalog that no longer exists falls back to the built-in one.
                if (activeCatalogId && !migrated.some((c) => c.id === activeCatalogId)) activeCatalogId = null;
                return { catalogs: migrated, activeCatalogId };
            },
        },
    ),
);
