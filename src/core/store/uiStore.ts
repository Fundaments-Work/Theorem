import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { isMobile } from "../lib/env";
import { theoremPersistStorage } from "../lib/persist-storage";
import type { AppRoute, UIState } from "../types";

interface UIStore extends UIState {
    setRoute: (route: AppRoute, bookId?: string, pushHistory?: boolean) => void;
    goBack: () => void;
    toggleSidebar: () => void;
    setSearchQuery: (query: string) => void;
    commitSearch: () => void;
    clearSearch: () => void;
    setSelectedBooks: (bookIds: string[]) => void;
    toggleBookSelection: (bookId: string) => void;
    clearSelection: () => void;
    setLoading: (loading: boolean, message?: string) => void;
    setError: (error?: string) => void;
    setHydrated: () => void;
    setVaultSyncStatus: (
        status: UIState["vaultSyncStatus"],
        message?: string,
        syncedAt?: string,
    ) => void;
    setDeviceSyncStatus: (
        status: UIState["deviceSyncStatus"],
        message?: string,
        syncedAt?: string,
    ) => void;
    setDownloadingBook: (bookId?: string) => void;
    setPendingReaderLocation: (location?: string) => void;
    
    setReaderToolbarVisible: (visible: boolean) => void;
    toggleReaderToolbar: () => void;
}

export const useUIStore = create<UIStore>()(
    persist(
        (set) => ({
            currentRoute: "library",
            currentBookId: undefined,
            sidebarOpen: !isMobile(),
            readerToolbarVisible: true,
            searchQuery: "",
            searchCommittedQuery: "",
            selectedBooks: [],
            isLoading: false,
            loadingMessage: undefined,
            error: undefined,
            vaultSyncStatus: "idle",
            vaultSyncMessage: undefined,
            vaultSyncAt: undefined,
            deviceSyncStatus: "idle",
            deviceSyncMessage: undefined,
            deviceSyncAt: undefined,
            downloadingBookId: undefined,
            pendingReaderLocation: undefined,
            hasHydrated: true,

            setRoute: (route, bookId, pushHistory = true) => {
                if (pushHistory && typeof window !== "undefined") {
                    window.history.pushState({ route, bookId }, "");
                }
                set((_state) => ({
                    currentRoute: route,
                    currentBookId: bookId,
                    searchQuery: "",
                    searchCommittedQuery: "",
                }));
            },
            goBack: () => {
                if (typeof window !== "undefined" && window.history.length > 1) {
                    window.history.back();
                } else {
                    set((_state) => ({
                        currentRoute: "library",
                        currentBookId: undefined,
                    }));
                }
            },
            toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
            setSearchQuery: (query) => set({ searchQuery: query }),
            commitSearch: () => set((state) => ({
                searchCommittedQuery: state.searchQuery.trim(),
            })),
            clearSearch: () => set({ searchQuery: "", searchCommittedQuery: "" }),
            setSelectedBooks: (bookIds) => set({ selectedBooks: bookIds }),
            toggleBookSelection: (bookId) =>
                set((state) => ({
                    selectedBooks: state.selectedBooks.includes(bookId)
                        ? state.selectedBooks.filter((id) => id !== bookId)
                        : [...state.selectedBooks, bookId],
                })),
            clearSelection: () => set({ selectedBooks: [] }),
            setLoading: (loading, message) =>
                set({ isLoading: loading, loadingMessage: message }),
            setError: (error) => set({ error }),
            setVaultSyncStatus: (vaultSyncStatus, vaultSyncMessage, vaultSyncAt) =>
                set({ vaultSyncStatus, vaultSyncMessage, vaultSyncAt }),
            setDeviceSyncStatus: (deviceSyncStatus, deviceSyncMessage, deviceSyncAt) =>
                set({ deviceSyncStatus, deviceSyncMessage, deviceSyncAt }),
            setDownloadingBook: (bookId) => set({ downloadingBookId: bookId }),
            setPendingReaderLocation: (location) => set({ pendingReaderLocation: location }),

            setHydrated: () => set({ hasHydrated: true }),

            setReaderToolbarVisible: (visible) => set({ readerToolbarVisible: visible }),
            toggleReaderToolbar: () => set((state) => ({ readerToolbarVisible: !state.readerToolbarVisible })),
        }),
        {
            name: 'theorem-ui',
            version: 1,
            storage: createJSONStorage(() => theoremPersistStorage),
            partialize: (state) => ({
                currentRoute: state.currentRoute,
                currentBookId: state.currentBookId,
                sidebarOpen: state.sidebarOpen,
            }),
        }
    )
);
