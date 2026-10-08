
import { useState, useEffect, memo } from "react";
import type { KeyboardEvent } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
    Minus,
    Maximize2,
    X,
    Search,
    BarChart3,
    ArrowDownUp,
} from "lucide-react";
import { cn } from "../core/lib/utils";
import { isMobile, isTauri } from "../core/lib/env";
import { useUIStore } from "../core/store";
import { getPairedDevices } from "../core/lib/device-sync";
import { getSearchPlaceholder, hasSearchDomain, resolveSearchDomain } from "../core/lib/search/domain";
import { TheoremLogo } from "./TheoremLogo";
import { MomoIcon } from "../ui/MomoIcon";
import { useSupportPrompt } from "../core/lib/support-prompt";

interface AppTitlebarProps {
    title: string;
    className?: string;
}

const TITLEBAR_ICON_BUTTON =
    "ui-icon-btn !h-9 !w-9";
const TITLEBAR_WINDOW_BUTTON =
    "inline-flex h-8 w-8 items-center justify-center border border-transparent bg-transparent p-0 text-[color:var(--color-text-secondary)] transition-[background-color,border-color,color] duration-200 ease-out hover:border-[var(--color-border)] hover:bg-[var(--color-surface-muted)] hover:text-[color:var(--color-text-primary)]";
const TITLEBAR_CLOSE_BUTTON = `${TITLEBAR_WINDOW_BUTTON} hover:bg-[color:color-mix(in_srgb,var(--color-error)_14%,transparent)] hover:text-[color:var(--color-error)]`;
const TITLEBAR_SEARCH_INPUT =
    "ui-input bg-[var(--color-surface)] pl-[calc(var(--control-padding-x)+var(--icon-size-sm)+var(--spacing-md))]";

export const AppTitlebar = memo(function AppTitlebar({
    title,
    className,
}: AppTitlebarProps) {
    const [isMaximized, setIsMaximized] = useState(false);
    const [isMobileSearchOpen, setIsMobileSearchOpen] = useState(false);
    const [isQuickSyncing, setIsQuickSyncing] = useState(false);
    const currentRoute = useUIStore((state) => state.currentRoute);
    const searchQuery = useUIStore((state) => state.searchQuery);
    const setSearchQuery = useUIStore((state) => state.setSearchQuery);
    const commitSearch = useUIStore((state) => state.commitSearch);
    const setRoute = useUIStore((state) => state.setRoute);
    const setDeviceSyncStatus = useUIStore((state) => state.setDeviceSyncStatus);
    const deviceSyncStatus = useUIStore((state) => state.deviceSyncStatus);
    const deviceSyncAt = useUIStore((state) => state.deviceSyncAt);
    const isTauriRuntime = isTauri();
    const isMobileRuntime = isMobile();
    const { isEligible: showSupport, openSupport: handleSupportClick } = useSupportPrompt();
    const [lastSyncedLabel, setLastSyncedLabel] = useState("");
    const showDesktopWindowControls = isTauriRuntime && !isMobileRuntime;
    const searchDomain = resolveSearchDomain({
        placement: "appTitlebar",
        route: currentRoute,
    });
    const isSearchVisible = hasSearchDomain(searchDomain);
    const searchPlaceholder = getSearchPlaceholder(searchDomain);

    useEffect(() => {
        if (!showDesktopWindowControls) {
            return;
        }

        const updateMaximizedState = async () => {
            try {
                const win = getCurrentWebviewWindow();
                const maximized = await win.isMaximized();
                setIsMaximized(maximized);
            } catch (err) {
                
                const isMax = window.innerWidth === window.screen.availWidth &&
                    window.innerHeight === window.screen.availHeight;
                setIsMaximized(isMax);
            }
        };

        let resizeTimer: ReturnType<typeof setTimeout> | null = null;

        const handleResize = () => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(updateMaximizedState, 150);
        };

        window.addEventListener("resize", handleResize);
        updateMaximizedState();

        return () => {
            window.removeEventListener("resize", handleResize);
            if (resizeTimer) clearTimeout(resizeTimer);
        };
    }, [showDesktopWindowControls]);

    useEffect(() => {
        setIsMobileSearchOpen(false);
    }, [currentRoute]);

    useEffect(() => {
        updateLastSyncedLabel();
        const interval = setInterval(updateLastSyncedLabel, 30000);
        return () => clearInterval(interval);
    }, [deviceSyncAt]);

    function updateLastSyncedLabel() {
        if (!deviceSyncAt) {
            setLastSyncedLabel("");
            return;
        }
        const seconds = Math.floor((Date.now() - new Date(deviceSyncAt).getTime()) / 1000);
        if (seconds < 10) {
            setLastSyncedLabel("just now");
        } else if (seconds < 60) {
            setLastSyncedLabel(`${seconds}s ago`);
        } else if (seconds < 3600) {
            setLastSyncedLabel(`${Math.floor(seconds / 60)}m ago`);
        } else if (seconds < 86400) {
            setLastSyncedLabel(`${Math.floor(seconds / 3600)}h ago`);
        } else {
            setLastSyncedLabel(`${Math.floor(seconds / 86400)}d ago`);
        }
    }

    useEffect(() => {
        if (!isSearchVisible) {
            setIsMobileSearchOpen(false);
        }
    }, [isSearchVisible]);

    const handleMinimize = async () => {
        if (!showDesktopWindowControls) {
            return;
        }
        try {
            const win = getCurrentWebviewWindow();
            await win.minimize();
        } catch (err) {
        }
    };

    const handleMaximize = async () => {
        if (!showDesktopWindowControls) {
            return;
        }
        try {
            const win = getCurrentWebviewWindow();
            if (isMaximized) {
                await win.unmaximize();
            } else {
                await win.maximize();
            }
        } catch (err) {
        }
    };

    const handleClose = async () => {
        if (!showDesktopWindowControls) {
            return;
        }
        try {
            const win = getCurrentWebviewWindow();
            await win.close();
        } catch (err) {
        }
    };

    const getPageTitle = () => {
        switch (currentRoute) {
            case "library":
                return "Library";
            case "reader":
                return "Books";

            case "settings":
                return "Settings";
            case "statistics":
                return "Statistics";
            case "annotations":
                return "Workbench";
            case "bookmarks":
                return "Bookmarks";
            case "shelves":
                return "Shelves";
            case "feeds":
                return "Feeds";
            default:
                return title;
        }
    };

    const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
            commitSearch();
        }
    };

    const handleQuickSync = async () => {
        if (isQuickSyncing || deviceSyncStatus === "syncing") {
            return;
        }

        if (!isTauriRuntime) {
            setDeviceSyncStatus("idle", "Device sync is available in desktop/mobile app.");
            return;
        }

        setIsQuickSyncing(true);

        try {
            const pairedDevices = await getPairedDevices();

            if (pairedDevices.length === 0) {
                setDeviceSyncStatus("idle", "No paired devices. Open Settings > Integrations to pair.");
                return;
            }

            const { runDeviceSync } = await import("../core/lib/sync-orchestrator");
            await runDeviceSync(pairedDevices[0].deviceId, undefined, true);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            setDeviceSyncStatus("error", message);
        } finally {
            setIsQuickSyncing(false);
        }
    };

    return (
        <div
            className={cn(
                "w-full z-50 select-none border-b border-[var(--color-border)] bg-[var(--color-surface)]",
                "px-4 pb-2 pt-[max(env(safe-area-inset-top,0px),4px)] lg:py-0",
                showDesktopWindowControls ? "lg:pl-14 lg:pr-2" : "lg:px-14",
                className
            )}
            data-tauri-drag-region={showDesktopWindowControls ? "true" : undefined}
        >
            <div
                className="flex h-12 items-center justify-between gap-3 sm:gap-4 lg:h-11"
                data-tauri-drag-region={showDesktopWindowControls ? "true" : undefined}
            >
                
                <div
                    className="flex items-center gap-2 shrink-0 min-w-0"
                    data-tauri-drag-region={showDesktopWindowControls ? "true" : undefined}
                    onDoubleClick={showDesktopWindowControls ? handleMaximize : undefined}
                >

                    <button
                        onClick={() => {
                            if (currentRoute !== "library") {
                                setRoute("library");
                            }
                        }}
                        className="sm:hidden inline-flex items-center p-1 -ml-1"
                        aria-label="Go to Library"
                    >
                        <div>
                            <TheoremLogo size={24} />
                        </div>
                    </button>

                    <h1 className="hidden sm:block font-sans text-sm font-semibold text-[color:var(--color-text-primary)] truncate">
                        {getPageTitle()}
                    </h1>
                </div>

                {isSearchVisible && (
                    <div
                        className="hidden lg:flex lg:flex-1 lg:min-w-[18rem] lg:max-w-3xl"
                        data-tauri-drag-region={showDesktopWindowControls ? "true" : undefined}
                    >
                        <div className="relative w-full">
                            <label htmlFor="app-search" className="sr-only">Search</label>
                            <input
                                id="app-search"
                                type="text"
                                placeholder={searchPlaceholder}
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                onKeyDown={handleSearchKeyDown}
                                className={cn(
                                    TITLEBAR_SEARCH_INPUT,
                                    "pr-8"
                                )}
                            />
                            {searchQuery && (
                                <button
                                    type="button"
                                    onClick={() => useUIStore.getState().clearSearch()}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors"
                                    aria-label="Clear search"
                                >
                                    ×
                                </button>
                            )}
                        </div>
                    </div>
                )}

                <div
                    className={cn(
                        "flex items-center shrink-0",
                        showDesktopWindowControls ? "gap-0.5" : "gap-1",
                    )}
                >
                    {isSearchVisible && (
                        <button
                            onClick={() => setIsMobileSearchOpen((prev) => !prev)}
                            className={cn(
                                "sm:!hidden",
                                TITLEBAR_ICON_BUTTON
                            )}
                            aria-label={isMobileSearchOpen ? "Hide search" : "Search"}
                            data-active={isMobileSearchOpen ? "true" : undefined}
                            aria-pressed={isMobileSearchOpen}
                        >
                            <Search className="w-5 h-5" />
                        </button>
                    )}

                    {isMobileRuntime && showSupport && (
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                void handleSupportClick();
                            }}
                            data-tauri-drag-region={undefined}
                            className={cn(
                                "sm:!hidden",
                                TITLEBAR_ICON_BUTTON,
                                "text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
                            )}
                            title="Support Theorem"
                            aria-label="Support Theorem on Buy Me Momo"
                        >
                            <MomoIcon className="w-4 h-4" />
                        </button>
                    )}

                    <div className="flex items-center gap-1.5">
                        {lastSyncedLabel && (
                            <span className="hidden lg:block text-xs text-[color:var(--color-text-tertiary)] whitespace-nowrap">
                                {lastSyncedLabel}
                            </span>
                        )}
                        <button
                            onClick={() => {
                                void handleQuickSync();
                            }}
                            className={cn(
                                TITLEBAR_ICON_BUTTON,
                                (deviceSyncStatus === "syncing" || isQuickSyncing) && "text-[color:var(--color-accent)]",
                                deviceSyncStatus === "error" && "text-[color:var(--color-error)]",
                            )}
                            title={
                                isQuickSyncing || deviceSyncStatus === "syncing"
                                    ? "Syncing devices..."
                                    : "Sync devices" + (lastSyncedLabel ? ` (${lastSyncedLabel})` : "")
                            }
                            data-active={
                                isQuickSyncing || deviceSyncStatus === "syncing"
                                    ? "true"
                                    : undefined
                            }
                            aria-pressed={isQuickSyncing || deviceSyncStatus === "syncing"}
                            aria-label="Sync devices"
                        >
                            <span className="relative inline-flex">
                                <ArrowDownUp className="w-5 h-5" />
                                <span
                                    className={cn(
                                        "absolute -bottom-px -right-px w-2.5 h-2.5 rounded-full ring-2 ring-[var(--color-surface)] transition-colors duration-300",
                                        deviceSyncStatus === "idle" && "bg-gray-400",
                                        deviceSyncStatus === "syncing" && "bg-amber-400 animate-pulse",
                                        deviceSyncStatus === "synced" && "bg-green-500",
                                        deviceSyncStatus === "error" && "bg-red-500",
                                    )}
                                />
                            </span>
                        </button>
                        <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
                            {deviceSyncStatus === "syncing" ? "Syncing with remote device"
                                : deviceSyncStatus === "synced" ? "Sync complete"
                                : deviceSyncStatus === "error" ? `Sync error: ${deviceSyncStatus || ""}`
                                : ""}
                        </span>
                    </div>

                    <button
                        onClick={() => setRoute("statistics")}
                        className={TITLEBAR_ICON_BUTTON}
                        aria-label="Statistics"
                        data-active={currentRoute === "statistics" ? "true" : undefined}
                        aria-pressed={currentRoute === "statistics"}
                    >
                        <BarChart3 className="w-5 h-5" />
                    </button>

                    {showDesktopWindowControls && (
                        <div className="hidden sm:flex items-center gap-1 ml-1.5 pl-2.5 border-l border-[var(--color-border)]">
                            <button
                                onClick={handleMinimize}
                                className={TITLEBAR_WINDOW_BUTTON}
                                title="Minimize"
                            >
                                <Minus className="w-4 h-4" />
                            </button>
                            <button
                                onClick={handleMaximize}
                                className={TITLEBAR_WINDOW_BUTTON}
                                title={isMaximized ? "Restore" : "Maximize"}
                            >
                                <Maximize2 className="w-4 h-4" />
                            </button>
                            <button
                                onClick={handleClose}
                                className={TITLEBAR_CLOSE_BUTTON}
                                title="Close"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {isSearchVisible && isMobileSearchOpen && (
                <div className="mt-1.5 sm:hidden">
                    <div className="relative w-full">
                        <input
                            type="text"
                            placeholder={searchPlaceholder}
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            onKeyDown={handleSearchKeyDown}
                            autoFocus
                            className={cn(
                                TITLEBAR_SEARCH_INPUT,
                                "pr-12"
                            )}
                        />
                        <button
                            onClick={() => {
                                useUIStore.getState().clearSearch();
                                setIsMobileSearchOpen(false);
                            }}
                            className={cn(
                                "absolute right-2 top-1/2 -translate-y-1/2 !h-7 !w-7",
                                "ui-icon-btn"
                            )}
                            title="Close search"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            )}

            {isSearchVisible && (
                <div className="mt-1.5 hidden sm:block lg:hidden">
                    <div className="relative w-full">
                        <input
                            type="text"
                            placeholder={searchPlaceholder}
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            onKeyDown={handleSearchKeyDown}
                            className={cn(
                                TITLEBAR_SEARCH_INPUT,
                                "pr-12"
                            )}
                        />
                        {searchQuery && (
                            <button
                                type="button"
                                onClick={() => useUIStore.getState().clearSearch()}
                                className="absolute right-2 top-1/2 -translate-y-1/2 !h-7 !w-7 ui-icon-btn"
                                aria-label="Clear search"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
});

export default AppTitlebar;
