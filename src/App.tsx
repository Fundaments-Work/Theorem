import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { RouteErrorBoundary } from "./ui/RouteErrorBoundary";
import { PageLoader, SplashScreen } from "./ui/loading";
import { AnnouncementBar } from "./ui/AnnouncementBar";
import { AppTitlebar, Sidebar, BottomNav } from "./shell";
import { useUIStore, useLibraryStore, useSettingsStore } from "./core/store";
import { isTauriDesktop, isTauri, isTauriMobile } from "./core/lib/env";
import { applyAppTheme, initReaderStyles, watchSystemTheme } from "./core/lib/design-tokens";
import { requestNotificationPermission } from "./core/lib/notifications";
import { startSystemInsets } from "./core/lib/system-insets";
import { importBooksIncremental, getBookFormat, isImportFormatSupported } from "./core/lib/import";
import { normalizeFilePath } from "./core/lib/utils";
import { navigationShortcuts } from "./shell/layout/nav-items";
import { registerShortcuts, useKeyboardShortcuts, SELECT_ALL_EVENT } from "./core/lib/keyboard-shortcuts";
import { initLogger } from "./core/lib/debug";
import { dispatchBackAction } from "./core/lib/back-navigation";
import { sqliteShrinkMemory } from "./core/lib/sqlite-storage";
import { flushAllPersistence, onPersistWriteFailure } from "./core/lib/persist-storage";
import { storageErrorHint } from "./core/lib/error-kind";
import { pruneExpiredTombstones } from "./core/lib/tombstone-pruner";
import { subscribeUntilCleanup } from "./core/lib/async-subscription";
import { bootstrapAutoSync } from "./core/lib/sync-bootstrap";
import { restoreReaderSession, startReaderSessionTracking } from "./core/lib/reader-session";
import { useDailyGoalReminder } from "./features/reader/hooks/useDailyGoalReminder";
import { Toaster, toast } from "sonner";

const ReadingSetup = lazy(() => import("./features/onboarding/ReadingSetup").then(module => ({ default: module.ReadingSetup })));

// Closed at startup and built on Radix: load on first use, not with the app shell.
const KeyboardShortcutsHelp = lazy(() =>
    import("./ui/KeyboardShortcutsHelp").then((m) => ({ default: m.KeyboardShortcutsHelp })),
);
const AlertDialog = lazy(() =>
    import("./ui/ConfirmDialog").then((m) => ({ default: m.AlertDialog })),
);

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
let readerSessionRestoreAttempted = false;
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
    // Keep the dialog mounted once opened so its close transition still plays.
    const [shortcutsHelpLoaded, setShortcutsHelpLoaded] = useState(false);
    useEffect(() => {
        if (showShortcutsHelp) setShortcutsHelpLoaded(true);
    }, [showShortcutsHelp]);
    const [alertInfo, setAlertInfo] = useState<{ title: string; message: string } | null>(null);
    const appTheme = useSettingsStore((state) => state.settings.theme);
    const accentColor = useSettingsStore((state) => state.settings.accentColor);

    useEffect(() => {
        if (appTheme !== "system") return;
        return watchSystemTheme(() => {
            applyAppTheme("system", accentColor);
        });
    }, [appTheme, accentColor]);

    useDailyGoalReminder();

    // A store that cannot be saved (storage full, private mode) must not fail
    // silently: the user would lose their library on the next reload.
    useEffect(
        () =>
            onPersistWriteFailure((_name, error) => {
                toast.error("Theorem could not save your changes", {
                    id: "persist-write-failure",
                    description:
                        storageErrorHint(error) ??
                        "Browser storage is full or unavailable. Recent changes may be lost when you reload.",
                    duration: 10000,
                });
            }),
        [],
    );

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
            
            // Numbered like the rail and the bottom bar (nav-items.ts), so Ctrl+N is the Nth icon.
            ...navigationShortcuts().map(({ label, keys, route }) => ({
                label,
                keys,
                category: "Navigation",
                handler: () => setRoute(route),
            })),
            
            { label: "Find / Search",       keys: "Ctrl+F", category: "Search",     handler: () => {
                const route = useUIStore.getState().currentRoute;
                if (route === "reader") return; 
                const searchInput = document.querySelector<HTMLInputElement>('input[placeholder*="Search"]');
                if (searchInput) { searchInput.focus(); searchInput.select(); }
            }},
            
            { label: "Select all",          keys: "Ctrl+A", category: "Library",    handler: () => {
                const route = useUIStore.getState().currentRoute;
                if (route !== "library" && route !== "shelves") return;
                window.dispatchEvent(new Event(SELECT_ALL_EVENT));
            }},
        ]);
    }, [setRoute]);

    const handleOnboardingComplete = useCallback((destination: "library" | "opds" = "library") => {
        updateSettings({ hasCompletedOnboarding: true });
        setRoute(destination);
        if (typeof localStorage !== "undefined") {
            localStorage.setItem("theorem-onboarding-complete", "true");
        }
    }, [updateSettings, setRoute]);

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

    // The native startup maintenance (a background thread) may find files for
    // books flagged as synced without one; the library loaded the old flag.
    useEffect(() => {
        if (!isTauri()) return;
        let cancelled = false;
        let unlisten: (() => void) | null = null;
        const stops: Array<() => void> = [];
        void (async () => {
            try {
                const [{ listen }, healed] = await Promise.all([
                    import("@tauri-apps/api/event"),
                    import("./core/lib/healed-books"),
                ]);
                const off = await listen<unknown>(healed.HEALED_BOOKS_EVENT, (event) => {
                    const library = useLibraryStore.getState();
                    stops.push(healed.applyHealedBooksWhenLoaded(healed.parseHealedBooks(event.payload), {
                        getBook: (id) => useLibraryStore.getState().getBook(id),
                        updateBook: library.updateBook,
                        subscribeBooks: (listener) => useLibraryStore.subscribe((state, previous) => {
                            if (state.books !== previous.books) listener();
                        }),
                    }));
                });
                if (cancelled) off();
                else unlisten = off;
            } catch (error) {
                if (import.meta.env.DEV) console.warn("[library] healed-books listener failed", error);
            }
        })();
        return () => {
            cancelled = true;
            unlisten?.();
            for (const stop of stops) stop();
        };
    }, []);

    // Phones: reopen the book when Android ended the app in the background
    // while it was in the reader (see reader-session.ts). Once per page load.
    useEffect(() => {
        if (!isTauriMobile() || !storesHydrated || !hasCompletedOnboarding) return;
        const stopTracking = startReaderSessionTracking({
            getRoute: () => useUIStore.getState(),
            subscribeRoute: (listener) => useUIStore.subscribe(listener),
        });
        let stopRestore = () => {};
        if (!readerSessionRestoreAttempted) {
            readerSessionRestoreAttempted = true;
            stopRestore = restoreReaderSession({
                getRoute: () => useUIStore.getState(),
                openBook: (bookId) => useUIStore.getState().setRoute("reader", bookId),
                hasBook: (bookId) => Boolean(useLibraryStore.getState().getBook(bookId)),
                subscribeBooks: (listener) => useLibraryStore.subscribe((state, previous) => {
                    if (state.books !== previous.books) listener();
                }),
            });
        }
        return () => {
            stopRestore();
            stopTracking();
        };
    }, [storesHydrated, hasCompletedOnboarding]);

    // Phones: trim memory when the app goes to the background. Desktop does this from Rust when
    // the window loses focus: asking from a page that is being hidden makes WebKit cancel the IPC
    // request and log an "access control checks" error.
    useEffect(() => {
        if (!isTauriMobile() || typeof document === "undefined") return;

        const handleVisibilityChange = () => {
            if (document.visibilityState === "hidden") {
                void sqliteShrinkMemory();
            }
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
    }, []);

    useEffect(() => {
        if (!isTauri()) return;
        return subscribeUntilCleanup("Window close handler", () =>
            getCurrentWebviewWindow().onCloseRequested(async (event) => {
                const handled = dispatchBackAction();
                if (handled) {
                    event.preventDefault();
                    return;
                }
                const currentUIState = useUIStore.getState();
                if (currentUIState.currentRoute === "reader") {
                    event.preventDefault();
                    setRoute("library", undefined, false);
                    return;
                }
                if (currentUIState.currentRoute !== "library") {
                    event.preventDefault();
                    setRoute("library", undefined, false);
                    return;
                }
                // Tauri awaits this handler before destroying the window.
                await flushAllPersistence();
            }),
        );
    }, [setRoute]);

    // Tray "Quit": Rust waits (bounded) for every window to acknowledge that
    // its pending store writes reached SQLite before exiting the process.
    useEffect(() => {
        if (!isTauri()) return;
        return subscribeUntilCleanup("Quit handler", async () => {
            const [{ listen }, { invoke }] = await Promise.all([
                import("@tauri-apps/api/event"),
                import("@tauri-apps/api/core"),
            ]);
            return listen("app-quit-requested", async () => {
                try {
                    await flushAllPersistence();
                } finally {
                    await invoke("app_quit_ready").catch((error) => {
                        console.error("[App] Acknowledging quit failed:", error);
                    });
                }
            });
        });
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
        // Nothing translates at first paint, so keep i18next and the locale files
        // (~50 kB) out of the startup bundle.
        void import("./core/lib/i18n").then((m) => m.initI18n());
    }, []);

    useEffect(() => {
        void initLogger();
    }, []);

    // Before anything is laid out under the status or gesture bar (Android edge-to-edge).
    useEffect(() => startSystemInsets(), []);

    useEffect(() => {
        void requestNotificationPermission();
    }, []);

    useEffect(() => {
        if (!storesHydrated) return;
        // Warm the reader component chunk during idle after first paint so the first
        // book open skips chunk load. Document engines (PDF.js, Foliate) are loaded
        // on demand when a book of that format is opened.
        return scheduleIdleTask(() => {
            void prewarmReaderChunk();
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

        const stopSync = bootstrapAutoSync(
            () => import("./core/lib/sync-orchestrator"),
            autoSyncEnabled,
            2000,
        );

        return () => {
            stopSync();
            import("./core/lib/device-sync").then(m => m.irohStop()).catch((error) => {
                console.error("[App] Stopping sync transport failed:", error);
            });
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

    useEffect(() => {
        if (!storesHydrated) return;
        void import("./core/lib/reading-records").then(({ flushReadingOutbox }) => flushReadingOutbox())
            .catch(error => console.error("[reading] Pending reading time will be retried", error));
        void import("./core/lib/reading-rhythm").then(({ flushReadingRhythmOutbox }) => flushReadingRhythmOutbox())
            .catch(error => console.error("[reading] Pending reading progress will be retried", error));
    }, [storesHydrated]);

    const isReaderMode = currentRoute === "reader";

    // Route keep-alive (#103): non-reader pages stay mounted across
    // navigation and toggle via `hidden`, preserving scroll position,
    // virtualizer caches, and filter state instead of remounting.
    // The reader stays exclusive (heavy engines unmount on exit).

    const showLibraryRoute = currentRoute === "library";
    const showAnnotationsRoute = currentRoute === "annotations" || currentRoute === "vocabulary" || currentRoute === "bookmarks";
    const showOpdsRoute = currentRoute === "opds";

    // Mount-on-first-visit keep-alive: wrappers stay in the DOM, but a
    // page's chunk and effects only load the first time its route shows.
    // Afterwards it stays mounted, so back-navigation is an instant class
    // toggle with scroll, filters, and virtualizer caches intact.
    const [visitedRoutes, setVisitedRoutes] = useState<ReadonlySet<string>>(() => new Set(["library"]));
    useEffect(() => {
        const key = showLibraryRoute ? "library"
            : currentRoute === "shelves" ? "shelves"
            : showAnnotationsRoute ? "annotations"
            : showOpdsRoute ? "opds"
            : currentRoute;
        setVisitedRoutes((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    }, [currentRoute, showLibraryRoute, showAnnotationsRoute, showOpdsRoute]);

    if (!storesHydrated) {
        return <SplashScreen isReady={false} />;
    }

    if (!hasCompletedOnboarding) {
        return <Suspense fallback={<PageLoader message="Preparing reading setup…" />}><ReadingSetup onComplete={handleOnboardingComplete} /></Suspense>;
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

    return (
        <>
        <div className="flex h-screen min-h-[100dvh] bg-[var(--color-background)]">
            
            <div className="hidden md:block">
                <Sidebar />
            </div>

            <div className="relative flex-1 flex flex-col min-w-0">
                <AppTitlebar title="Theorem" />
                <AnnouncementBar />

                <main id="app-main" ref={mainScrollRef} className="flex flex-1 flex-col overflow-y-auto pb-[calc(4rem+var(--spacing-lg))] md:pb-0 md:px-8 md:py-6 scrollbar-solid overscroll-contain">
                    <div className={showLibraryRoute ? "flex flex-1 flex-col min-h-0" : "hidden"} aria-hidden={!showLibraryRoute}>
                        {visitedRoutes.has("library") && (
                        <RouteErrorBoundary>
                            <Suspense fallback={<PageLoader />}>
                                <LibraryPage />
                            </Suspense>
                        </RouteErrorBoundary>
                        )}
                    </div>
                    <div className={currentRoute === "shelves" ? "flex flex-1 flex-col min-h-0" : "hidden"} aria-hidden={currentRoute !== "shelves"}>
                        {visitedRoutes.has("shelves") && (
                        <RouteErrorBoundary>
                            <Suspense fallback={<PageLoader />}>
                                <ShelvesPage />
                            </Suspense>
                        </RouteErrorBoundary>
                        )}
                    </div>
                    <div className={showAnnotationsRoute ? "flex flex-1 flex-col min-h-0" : "hidden"} aria-hidden={!showAnnotationsRoute}>
                        {visitedRoutes.has("annotations") && (
                        <RouteErrorBoundary>
                            <Suspense fallback={<PageLoader />}>
                                <AnnotationsPage />
                            </Suspense>
                        </RouteErrorBoundary>
                        )}
                    </div>
                    <div className={currentRoute === "settings" ? "flex flex-1 flex-col min-h-0" : "hidden"} aria-hidden={currentRoute !== "settings"}>
                        {visitedRoutes.has("settings") && (
                        <RouteErrorBoundary>
                            <Suspense fallback={<PageLoader />}>
                                <SettingsPage />
                            </Suspense>
                        </RouteErrorBoundary>
                        )}
                    </div>
                    <div className={currentRoute === "statistics" ? "flex flex-1 flex-col min-h-0" : "hidden"} aria-hidden={currentRoute !== "statistics"}>
                        {visitedRoutes.has("statistics") && (
                        <RouteErrorBoundary>
                            <Suspense fallback={<PageLoader />}>
                                <StatisticsPage />
                            </Suspense>
                        </RouteErrorBoundary>
                        )}
                    </div>
                    <div className={currentRoute === "feeds" ? "flex flex-1 flex-col min-h-0" : "hidden"} aria-hidden={currentRoute !== "feeds"}>
                        {visitedRoutes.has("feeds") && (
                        <RouteErrorBoundary>
                            <Suspense fallback={<PageLoader />}>
                                <FeedsPage />
                            </Suspense>
                        </RouteErrorBoundary>
                        )}
                    </div>
                    <div className={showOpdsRoute ? "flex flex-1 flex-col min-h-0" : "hidden"} aria-hidden={!showOpdsRoute}>
                        {visitedRoutes.has("opds") && (
                        <RouteErrorBoundary>
                            <Suspense fallback={<PageLoader />}>
                                <OPDSBrowserPage />
                            </Suspense>
                        </RouteErrorBoundary>
                        )}
                    </div>
                </main>
            </div>

            <BottomNav />

            {shortcutsHelpLoaded && (
                <Suspense fallback={null}>
                    <KeyboardShortcutsHelp
                        isOpen={showShortcutsHelp}
                        onClose={() => setShowShortcutsHelp(false)}
                    />
                </Suspense>
            )}
            
        </div>
            <Toaster position="bottom-right" />

            {alertInfo && (
                <Suspense fallback={null}>
                    <AlertDialog
                        isOpen={!!alertInfo}
                        title={alertInfo.title}
                        message={alertInfo.message}
                        okLabel="OK"
                        onClose={() => setAlertInfo(null)}
                    />
                </Suspense>
            )}
        </>
    );
}

export default App;
