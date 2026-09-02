import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { RouteErrorBoundary, KeyboardShortcutsHelp, AlertDialog, PageLoader, SplashScreen } from "./ui";
import { AppTitlebar, Sidebar, BottomNav } from "./shell";
import { useUIStore, useLibraryStore, useSettingsStore } from "./core/store";
import { isTauriDesktop, isTauri, isMobile } from "./core/lib/env";
import { initReaderStyles } from "./core/lib/design-tokens";
import { requestNotificationPermission } from "./core/lib/notifications";
import { importBooksIncremental, getBookFormat, isImportFormatSupported } from "./core/lib/import";
import { normalizeFilePath } from "./core/lib/utils";
import { registerShortcuts, useKeyboardShortcuts } from "./core/lib/keyboard-shortcuts";
import { initI18n } from "./core/lib/i18n";
import { initLogger } from "./core/lib/debug";
import { prewarmPdfJsRuntime } from "./core/lib/pdfjs-runtime";
import { prewarmFoliateRuntime } from "./core/lib/foliate-runtime";
import { dispatchBackAction } from "./core/lib/back-navigation";
import { sqliteShrinkMemory } from "./core/lib/sqlite-storage";
import { pruneExpiredTombstones } from "./core/lib/tombstone-pruner";
import { OnboardingFlow } from "./features/onboarding";
import { Toaster } from "sonner";

const LibraryPage = lazy(() =>
    import("./features/library").then((module) => ({ default: module.LibraryPage })),
);
const loadReaderPage = () => import("./features/reader");
let _readerChunkPromise: Promise<typeof import("./features/reader")> | null = null;
function getReaderChunk(): Promise<typeof import("./features/reader")> {
    if (!_readerChunkPromise) _readerChunkPromise = loadReaderPage();
    return _readerChunkPromise;
}
const ReaderPage = lazy(() =>
    getReaderChunk().then((module) => ({ default: module.ReaderPage })),
);
export function prewarmReaderChunk(): void {
    void getReaderChunk();
}

const ShelvesPage = lazy(() =>
    import("./features/library").then((module) => ({ default: module.ShelvesPage })),
);
const AnnotationsPage = lazy(() =>
    import("./features/library").then((module) => ({ default: module.AnnotationsPage })),
);
const BookmarksPage = lazy(() =>
    import("./features/library").then((module) => ({ default: module.BookmarksPage })),
);
const SettingsPage = lazy(() =>
    import("./features/settings").then((module) => ({ default: module.SettingsPage })),
);
const StatisticsPage = lazy(() =>
    import("./features/statistics").then((module) => ({ default: module.StatisticsPage })),
);
const FeedsPage = lazy(() =>
    import("./features/feeds").then((module) => ({ default: module.FeedsPage })),
);
const OPDSBrowserPage = lazy(() =>
    import("./features/catalogs").then((module) => ({ default: module.OPDSBrowserPage })),
);
const DESKTOP_STARTUP_MIN_WIDTH = 1024;
const DESKTOP_STARTUP_MIN_HEIGHT = 720;

function scheduleIdleTask(task: () => void, fallbackDelayMs = 1500): () => void {
    const win = window as Window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
        cancelIdleCallback?: (handle: number) => void;
    };
    if (typeof win.requestIdleCallback === "function") {
        const handle = win.requestIdleCallback(task, { timeout: 3000 });
        return () => win.cancelIdleCallback?.(handle);
    }
    const handle = window.setTimeout(task, fallbackDelayMs);
    return () => window.clearTimeout(handle);
}

function App() {
    const currentRoute = useUIStore((state) => state.currentRoute);
    const setRoute = useUIStore((state) => state.setRoute);
    const setLoading = useUIStore((state) => state.setLoading);
    const mainScrollRef = useRef<HTMLElement>(null);
    const autoSyncEnabled = useSettingsStore((state) => state.settings.deviceSync?.autoSyncEnabled ?? true);
    const updateSettings = useSettingsStore((state) => state.updateSettings);
    const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
    const [alertInfo, setAlertInfo] = useState<{ title: string; message: string } | null>(null);

    const [storesHydrated, setStoresHydrated] = useState(() =>
        useSettingsStore.persist.hasHydrated(),
    );

    useLayoutEffect(() => {
        if (storesHydrated) {
            setLoading(false);
            return;
        }
        setLoading(true, "Loading Theorem…");
        let cancelled = false;
        const done = () => {
            if (!cancelled) {
                setStoresHydrated(true);
                setLoading(false);
            }
        };
        const timeout = setTimeout(done, 3000);
        const unsub = useSettingsStore.subscribe(() => {
            if (cancelled) return;
            if (useSettingsStore.persist.hasHydrated()) {
                clearTimeout(timeout);
                done();
            }
        });
        return () => {
            cancelled = true;
            clearTimeout(timeout);
            unsub();
        };
    }, [storesHydrated, setLoading]);

    const hasCompletedOnboardingStore = useSettingsStore(
        (state) => state.settings.hasCompletedOnboarding,
    );
    
    const hasCompletedOnboarding =
        typeof localStorage !== "undefined" &&
        localStorage.getItem("theorem-onboarding-complete") === "true"
            ? true
            : hasCompletedOnboardingStore;

    useKeyboardShortcuts(currentRoute);

    useEffect(() => {
        return registerShortcuts("app", [
            {
                label: "Show keyboard shortcuts",
                keys: "Shift+?",
                category: "App",
                handler: () => setShowShortcutsHelp((prev) => !prev),
            },
            
            { label: "Go to Library",       keys: "Ctrl+1", category: "Navigation", handler: () => setRoute("library") },
            { label: "Go to Shelves",       keys: "Ctrl+2", category: "Navigation", handler: () => setRoute("shelves") },
            { label: "Go to Feeds",         keys: "Ctrl+3", category: "Navigation", handler: () => setRoute("feeds") },
            { label: "Go to Workbench",    keys: "Ctrl+4", category: "Navigation", handler: () => setRoute("annotations") },
            { label: "Go to Statistics",    keys: "Ctrl+5", category: "Navigation", handler: () => setRoute("statistics") },
            { label: "Go to Workbench",     keys: "Ctrl+6", category: "Navigation", handler: () => setRoute("annotations") },
            { label: "Go to Bookmarks",     keys: "Ctrl+7", category: "Navigation", handler: () => setRoute("bookmarks") },
            { label: "Go to Settings",      keys: "Ctrl+,", category: "Navigation", handler: () => setRoute("settings") },
            
            { label: "Find / Search",       keys: "Ctrl+F", category: "Search",     handler: () => {
                const route = useUIStore.getState().currentRoute;
                if (route === "reader") return; 
                const searchInput = document.querySelector<HTMLInputElement>('input[placeholder*="Search"]');
                if (searchInput) { searchInput.focus(); searchInput.select(); }
            }},
            
            { label: "Toggle sidebar",      keys: "Ctrl+B", category: "App",        handler: () => {
                useUIStore.getState().toggleSidebar();
            }},
            
            { label: "Select all",          keys: "Ctrl+A", category: "Library",    handler: () => {
                const route = useUIStore.getState().currentRoute;
                if (route !== "library" && route !== "shelves" && route !== "bookmarks") return;
                const toggleSelectMode = (document.querySelector('[data-action="toggle-select-mode"]') as HTMLButtonElement);
                if (toggleSelectMode) toggleSelectMode.click();
            }},
        ]);
    }, [setRoute]);

    const handleOnboardingComplete = useCallback(() => {
        updateSettings({ hasCompletedOnboarding: true });
        if (typeof localStorage !== "undefined") {
            localStorage.setItem("theorem-onboarding-complete", "true");
        }
    }, [updateSettings]);

    useEffect(() => {
        if (currentRoute === "vocabulary") {
            setRoute("annotations");
        }
    }, [currentRoute, setRoute]);

    useEffect(() => {
        if (typeof window === "undefined") return;
        try {
            const params = new URLSearchParams(window.location.search);
            const targetRoute = params.get("route");
            const targetBookId = params.get("bookId");
            if (targetRoute === "reader" && targetBookId) {
                setRoute("reader", targetBookId, false);
            }
        } catch {
            // Ignore parse errors
        }
    }, [setRoute]);

    useEffect(() => {
        if (typeof window === "undefined") return;

        window.history.replaceState({ route: currentRoute, bookId: useUIStore.getState().currentBookId }, "");

        const handlePopState = (event: PopStateEvent) => {
            const state = event.state;
            const currentUIState = useUIStore.getState();

            const handled = dispatchBackAction();
            if (handled) {
                window.history.pushState(
                    { route: currentUIState.currentRoute, bookId: currentUIState.currentBookId },
                    "",
                );
                return;
            }

            if (currentUIState.currentRoute === "reader") {
                setRoute("library", undefined, false);
                return;
            }

            if (state && state.route) {
                if (state.route !== currentUIState.currentRoute || state.bookId !== currentUIState.currentBookId) {
                    setRoute(state.route, state.bookId, false);
                }
            } else if (currentUIState.currentRoute !== "library") {
                setRoute("library", undefined, false);
            }
        };

        window.addEventListener("popstate", handlePopState);
        return () => window.removeEventListener("popstate", handlePopState);
    }, [setRoute]); 

    useEffect(() => {
        pruneExpiredTombstones();
    }, []);

    useEffect(() => {
        if (!isTauri() || typeof document === "undefined") return;

        const handleVisibilityChange = () => {
            if (document.visibilityState === "hidden") {
                void sqliteShrinkMemory();
            }
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
    }, []);

    // CLI auto-heal: if the user enabled the Terminal CLI and the
    // ~/.local/bin/theorem symlink went missing (e.g. a fresh AppImage mount),
    // recreate it silently at startup. Linux desktop only.
    useEffect(() => {
        if (!isTauriDesktop() || !navigator.userAgent.includes("Linux")) return;
        const { settings } = useSettingsStore.getState();
        if (!settings.cli?.enabled) return;
        void import("@tauri-apps/api/core").then(({ invoke }) =>
            invoke("setup_linux_cli_symlink").catch(() => {
                // Silent: the Settings page surfaces status when opened.
            }),
        );
    }, []); 

    useEffect(() => {
        if (!isTauri() || typeof window === "undefined") {
            return;
        }

        let cancelled = false;
        let unlistenPromise: Promise<() => void> | null = null;

        const openPaths = async (paths: string[]) => {
            if (cancelled || paths.length === 0) {
                return;
            }

            const uniquePaths = Array.from(
                new Set(paths.map((path) => path.trim()).filter(Boolean)),
            );

            for (const rawPath of uniquePaths) {
                if (cancelled) {
                    return;
                }

                const normalizedPath = normalizeFilePath(rawPath);
                const format = getBookFormat(normalizedPath);
                if (!format || !isImportFormatSupported(format)) {
                    continue;
                }

                const existing = useLibraryStore
                    .getState()
                    .books
                    .find((book) => normalizeFilePath(book.filePath) === normalizedPath);

                if (existing) {
                    useUIStore.getState().setRoute("reader", existing.id);
                    continue;
                }

                const failures: Array<{ source: string; message: string }> = [];
                const imported = await importBooksIncremental(
                    [normalizedPath],
                    (book) => {
                        useLibraryStore.getState().addBook(book);
                    },
                    (source, error) => {
                        failures.push({
                            source,
                            message: error instanceof Error ? error.message : String(error),
                        });
                    },
                );

                if (cancelled) {
                    return;
                }

                const importedBook = imported[0];
                if (importedBook) {
                    useUIStore.getState().setRoute("reader", importedBook.id);
                } else if (failures.length > 0) {
                    setAlertInfo({ title: "Open File Error", message: `Failed to open file.\n\n${failures[0]?.source}\n${failures[0]?.message}` });
                } else {
                }
            }
        };

        const initOpenWith = async () => {
            try {
                const { invoke } = await import("@tauri-apps/api/core");
                const pending = await invoke<unknown>("take_pending_open_files");
                if (Array.isArray(pending)) {
                    await openPaths(pending.filter((value): value is string => typeof value === "string"));
                }
            } catch (error) {
            }

            try {
                const { listen } = await import("@tauri-apps/api/event");
                unlistenPromise = listen<unknown>("theorem://open-files", (event) => {
                    const payload = event.payload;
                    const paths = Array.isArray(payload)
                        ? payload.filter((value): value is string => typeof value === "string")
                        : typeof payload === "string"
                            ? [payload]
                            : [];
                    void openPaths(paths);
                });
            } catch (error) {
            }
        };

        void initOpenWith();

        return () => {
            cancelled = true;
            if (unlistenPromise) {
                void unlistenPromise.then((unlisten) => unlisten());
            }
        };
    }, []);

    useEffect(() => {
        initReaderStyles(useSettingsStore.getState().settings.readerSettings);
    }, []);

    useEffect(() => {
        void initI18n();
    }, []);

    useEffect(() => {
        void initLogger();
    }, []);

    useEffect(() => {
        void requestNotificationPermission();
    }, []);

    useEffect(() => {
        if (!storesHydrated) return;
        // Warm the reader, PDF.js, and foliate runtime chunks during idle after
        // first paint so the first book open skips chunk load + engine parse.
        return scheduleIdleTask(() => {
            void prewarmReaderChunk();
            void prewarmPdfJsRuntime();
            void prewarmFoliateRuntime();
        });
    }, [storesHydrated]);

    useEffect(() => {
        if (!isTauriDesktop()) return;
        const registerGlobal = async () => {
            const { register } = await import("@tauri-apps/plugin-global-shortcut");
            await register("CommandOrControl+Shift+F", () => {
                useUIStore.getState().setRoute("library");
            });
            await register("CommandOrControl+Shift+R", () => {
                useUIStore.getState().setRoute("feeds");
            });
        };
        void registerGlobal().catch(() => {});
    }, []);

    useEffect(() => {
        if (!isTauri()) {
            return;
        }
        const initFingerprint = async () => {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("set_android_fingerprint").catch(e => console.error("[catch]", e));
        };
        void initFingerprint();
    }, []);

    useEffect(() => {
        if (!isTauri() || !hasCompletedOnboarding) {
            return;
        }

        let cancelled = false;
        let bridgeCleanup: (() => void) | null = null;
        let cleanupStopSync: (() => void) | null = null;
        const bootstrap = async () => {
            if (cancelled) return;

            const syncModule = await import("./core/lib/sync-orchestrator");

            if (!autoSyncEnabled) {
                syncModule.stopAutoSync();
                return;
            }

            try {
                await syncModule.ensureResponderSyncReady();
            } catch {}
            if (cancelled) return;

            try {
                bridgeCleanup = syncModule.subscribeZustandToIrohDocs();
            } catch {}

            try {
                await syncModule.startAutoSync();
            } catch {}

            cleanupStopSync = syncModule.stopAutoSync;
        };

        const timer = setTimeout(() => {
            void bootstrap();
        }, 2000);

        return () => {
            cancelled = true;
            clearTimeout(timer);
            bridgeCleanup?.();
            cleanupStopSync?.();
            import("./core/lib/device-sync").then(m => m.irohStop()).catch(() => {});
        };
    }, [hasCompletedOnboarding, autoSyncEnabled]);

    useEffect(() => {
        if (!isTauriDesktop()) {
            return;
        }

        let cancelled = false;
        const ensureDesktopWindowSize = async () => {
            try {
                const win = getCurrentWebviewWindow();
                const size = await win.innerSize();
                if (cancelled) {
                    return;
                }

                if (
                    size.width < DESKTOP_STARTUP_MIN_WIDTH
                    || size.height < DESKTOP_STARTUP_MIN_HEIGHT
                ) {
                    await win.maximize();
                }
            } catch (error) {
            }
        };

        void ensureDesktopWindowSize();
        return () => {
            cancelled = true;
        };
    }, []);

    const isReaderMode = currentRoute === "reader";

    useEffect(() => {
        if (isReaderMode) {
            return;
        }
        mainScrollRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }, [currentRoute, isReaderMode]);

    const renderPage = () => {
        switch (currentRoute) {
            case "library":
                return <LibraryPage />;
            case "reader":
                return <ReaderPage />;
            case "vocabulary":
                return <AnnotationsPage />;
            case "shelves":
                return <ShelvesPage />;
            case "annotations":
                return <AnnotationsPage />;
            case "bookmarks":
                return <BookmarksPage />;
            case "settings":
                return <SettingsPage />;
            case "statistics":
                return <StatisticsPage />;
            case "feeds":
                return <FeedsPage />;
            case "opds":
                return isMobile() ? <LibraryPage /> : <OPDSBrowserPage />;
            default:
                return <LibraryPage />;
        }
    };

    if (!storesHydrated) {
        return <SplashScreen isReady={false} />;
    }

    if (!hasCompletedOnboarding) {
        return <OnboardingFlow onComplete={handleOnboardingComplete} />;
    }

    if (isReaderMode) {
        return (
            <RouteErrorBoundary>
                <Suspense fallback={<PageLoader message="Opening reader..." className="fixed inset-0" />}>
                    <ReaderPage />
                </Suspense>
            </RouteErrorBoundary>
        );
    }

    const isMobileDevice = isMobile();

    return (
        <>
        <div className="flex h-screen min-h-[100dvh] bg-[var(--color-background)]">
            
            <div className="hidden md:block">
                <Sidebar isMobile={isMobileDevice} />
            </div>

            <div className="relative flex-1 flex flex-col min-w-0">
                <AppTitlebar title="Theorem" />

                <main id="app-main" ref={mainScrollRef} className="flex flex-1 flex-col overflow-y-auto pb-[calc(4rem+var(--spacing-lg))] md:pb-0 md:px-8 md:py-6 custom-scrollbar overscroll-contain">
                    <RouteErrorBoundary>
                        <Suspense fallback={<PageLoader />}>
                            {renderPage()}
                        </Suspense>
                    </RouteErrorBoundary>
                </main>
            </div>

            <BottomNav />

            <KeyboardShortcutsHelp
                isOpen={showShortcutsHelp}
                onClose={() => setShowShortcutsHelp(false)}
            />
            
        </div>
            <Toaster position="bottom-right" />

            {alertInfo && (
                <AlertDialog
                    isOpen={!!alertInfo}
                    title={alertInfo.title}
                    message={alertInfo.message}
                    okLabel="OK"
                    onClose={() => setAlertInfo(null)}
                />
            )}
        </>
    );
}

export default App;
