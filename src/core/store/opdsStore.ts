import { create } from "zustand";
import { persist } from "zustand/middleware";
import { deferredJsonStorage, memoizePartialize } from "../lib/persist-storage";
import { DEFAULT_OPDS_PRESETS } from "../services/OpdsService";
import type { OpdsCatalog } from "../types";

export interface OpdsState {
    catalogs: OpdsCatalog[];
    activeCatalogId: string | null;
    currentFeedUrl: string | null;
    feedHistory: string[];

    addCatalog: (catalog: Omit<OpdsCatalog, "id">) => string;
    removeCatalog: (id: string) => void;
    updateCatalog: (id: string, updates: Partial<OpdsCatalog>) => void;
    setActiveCatalog: (id: string | null) => void;
    navigateToFeed: (url: string) => void;
    navigateBack: () => boolean;
    resetNavigation: () => void;
}

export const useOpdsStore = create<OpdsState>()(
    persist(
        (set, get) => ({
            catalogs: DEFAULT_OPDS_PRESETS,
            activeCatalogId: "project-gutenberg",
            currentFeedUrl: "https://www.gutenberg.org/ebooks.opds/",
            feedHistory: [],

            addCatalog: (catalog) => {
                const id = `catalog-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                const newCatalog: OpdsCatalog = { ...catalog, id };
                set((state) => {
                    const current = Array.isArray(state.catalogs) ? state.catalogs : DEFAULT_OPDS_PRESETS;
                    return {
                        catalogs: [...current, newCatalog],
                        activeCatalogId: id,
                        currentFeedUrl: newCatalog.url,
                        feedHistory: [],
                    };
                });
                return id;
            },

            removeCatalog: (id) => {
                set((state) => {
                    const current = Array.isArray(state.catalogs) ? state.catalogs : DEFAULT_OPDS_PRESETS;
                    const filtered = current.filter((c) => c.id !== id);
                    const isCurrentActive = state.activeCatalogId === id;
                    const nextActive = isCurrentActive ? (filtered[0]?.id || null) : state.activeCatalogId;
                    const nextUrl = isCurrentActive ? (filtered[0]?.url || null) : state.currentFeedUrl;
                    return {
                        catalogs: filtered,
                        activeCatalogId: nextActive,
                        currentFeedUrl: nextUrl,
                        feedHistory: isCurrentActive ? [] : state.feedHistory,
                    };
                });
            },

            updateCatalog: (id, updates) => {
                set((state) => {
                    const current = Array.isArray(state.catalogs) ? state.catalogs : DEFAULT_OPDS_PRESETS;
                    return {
                        catalogs: current.map((c) => (c.id === id ? { ...c, ...updates } : c)),
                    };
                });
            },

            setActiveCatalog: (id) => {
                if (!id) {
                    set({ activeCatalogId: null, currentFeedUrl: null, feedHistory: [] });
                    return;
                }
                const catalog = get().catalogs.find((c) => c.id === id);
                if (catalog) {
                    set({
                        activeCatalogId: id,
                        currentFeedUrl: catalog.url,
                        feedHistory: [],
                    });
                }
            },

            navigateToFeed: (url) => {
                const current = get().currentFeedUrl;
                if (current && current !== url) {
                    set((state) => ({
                        currentFeedUrl: url,
                        feedHistory: [...state.feedHistory, current],
                    }));
                } else {
                    set({ currentFeedUrl: url });
                }
            },

            navigateBack: () => {
                const { feedHistory } = get();
                if (feedHistory.length === 0) return false;
                const previous = feedHistory[feedHistory.length - 1];
                set({
                    currentFeedUrl: previous,
                    feedHistory: feedHistory.slice(0, -1),
                });
                return true;
            },

            resetNavigation: () => {
                const active = get().catalogs.find((c) => c.id === get().activeCatalogId);
                set({
                    currentFeedUrl: active?.url || null,
                    feedHistory: [],
                });
            },
        }),
        {
            name: "theorem-opds",
            version: 2,
            storage: deferredJsonStorage,
            partialize: memoizePartialize(
                (state) => [state.catalogs, state.activeCatalogId],
                (state) => ({
                    catalogs: state.catalogs,
                    activeCatalogId: state.activeCatalogId,
                }),
            ),
            migrate: (persistedState: any, version: number) => {
                if (version < 2 && persistedState) {
                    const catalogs = Array.isArray(persistedState.catalogs)
                        ? persistedState.catalogs.map((c: OpdsCatalog) => {
                              if (c.url === "https://standardebooks.org/feeds/opds") {
                                  return { ...c, url: "https://standardebooks.org/feeds/atom/new-releases" };
                              }
                              if (c.url === "https://m.gutenberg.org/ebooks.opds/") {
                                  return { ...c, url: "https://www.gutenberg.org/ebooks.opds/" };
                              }
                              return c;
                          })
                        : DEFAULT_OPDS_PRESETS;
                    return {
                        ...persistedState,
                        catalogs,
                        activeCatalogId: "project-gutenberg",
                    };
                }
                return persistedState;
            },
        }
    )
);
