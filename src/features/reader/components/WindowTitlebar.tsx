
import { useState, useEffect, useRef } from "react";
import {
    ArrowLeft,
    Bookmark as BookmarkIcon,
    Search,
    Maximize2,
    Minimize2,
    Minus,
    X,
    EllipsisVertical,
    Type,
    Info,
    Headphones,
    Zap,
    Presentation,
    Printer,
} from "lucide-react";
import { cn } from "../../../core/lib/utils";
import { isMobile, isTauri } from "../../../core/lib/env";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { DocMetadata, DocLocation } from "../../../core/types";

interface WindowTitlebarProps {
    metadata: DocMetadata | null;
    location?: DocLocation | null;
    onBack: () => void;
    canGoBack?: boolean;
    canGoForward?: boolean;
    onGoBack?: () => void;
    onGoForward?: () => void;
    onPrevPage?: () => void;
    onNextPage?: () => void;
    onToggleToc: () => void;
    onToggleSettings: () => void;
    onToggleBookmarks: () => void;
    onToggleSearch: () => void;
    onToggleInfo: () => void;
    onToggleMenu: () => void;
    onAddBookmark?: () => void;
    isCurrentPageBookmarked?: boolean;
    activePanel: string | null;
    fullscreen?: boolean;
    onToggleFullscreen?: () => void;
    /** PDF: full-screen, one page at a time. */
    onPresent?: () => void;
    onPrint?: () => void;
    immersionMode?: boolean;
    onToggleImmersion?: () => void;
    speedReadMode?: boolean;
    onToggleSpeedRead?: () => void;
    className?: string;
    
    hideReaderControls?: boolean;
    pdfControls?: any;
}

const ICON_BUTTON_CLASS = "inline-flex h-10 w-10 shrink-0 items-center justify-center border border-transparent bg-transparent p-0 text-[color:var(--color-text-secondary)] transition-[background-color,border-color,color] duration-200 ease-out hover:border-[var(--color-border)] hover:bg-[var(--color-surface-muted)] hover:text-[color:var(--color-text-primary)]";
const ICON_BUTTON_ACTIVE_CLASS = "border-[var(--color-text-primary)] bg-[var(--color-surface-muted)] text-[color:var(--color-text-primary)]";
const ICON_BUTTON_INACTIVE_CLASS = "border-transparent text-[color:var(--color-text-secondary)]";

function ToolbarButton({
    onClick,
    active,
    title,
    className,
    children,
    ...rest
}: {
    onClick?: () => void;
    active?: boolean;
    title: string;
    className?: string;
    children: React.ReactNode;
    'aria-label'?: string;
}) {
    return (
        <button
            onClick={(e) => { e.stopPropagation(); onClick?.(); }}
            className={cn(
                ICON_BUTTON_CLASS,
                active ? ICON_BUTTON_ACTIVE_CLASS : ICON_BUTTON_INACTIVE_CLASS,
                className,
            )}
            title={title}
            {...rest}
        >
            {children}
        </button>
    );
}

interface MenuProps {
    isOpen: boolean;
    onClose: () => void;
    items: Array<{
        label: string;
        icon: React.ReactNode;
        onClick: () => void;
        active?: boolean;
        disabled?: boolean;
        mobileOnly?: boolean;
    }>;
    triggerRef: React.RefObject<HTMLButtonElement | null>;
}

function MobileMenu({ isOpen, onClose, items, triggerRef: _triggerRef }: MenuProps) {
    if (!isOpen) return null;

    return (
        <>
            <div
                className="fixed inset-0 z-[160]"
                onClick={(e) => {
                    e.stopPropagation();
                    onClose();
                }}
            />
            <div
                className="absolute right-2 top-full mt-1.5 z-[161] min-w-[13rem] max-w-[calc(100vw-1rem)] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]/95 backdrop-blur-xl shadow-xl py-1 overflow-hidden transition-[opacity,transform] duration-200 ease-out"
            >
                {items.map((item, index) => (
                    <button
                        key={index}
                        onClick={(e) => {
                            e.stopPropagation();
                            onClose();
                            item.onClick();
                        }}
                        disabled={item.disabled}
                        className={cn(
                            "flex w-full items-center gap-3 px-3.5 py-2.5 text-xs text-left transition-colors text-[color:var(--color-text-primary)]",
                            item.active
                                ? "bg-[var(--color-surface-muted)] font-medium text-[color:var(--color-accent)]"
                                : "hover:bg-[var(--color-surface-muted)]",
                            item.disabled && "opacity-50 cursor-not-allowed",
                            item.mobileOnly && "sm:hidden"
                        )}
                    >
                        <span className="w-4 h-4 flex items-center justify-center opacity-80 shrink-0">{item.icon}</span>
                        <span className="flex-1 truncate">{item.label}</span>
                    </button>
                ))}
            </div>
        </>
    );
}

export function WindowTitlebar({
    metadata,
    location,
    onBack,
    canGoBack: _canGoBack,
    canGoForward: _canGoForward,
    onGoBack: _onGoBack,
    onGoForward: _onGoForward,
    onPrevPage: _onPrevPage,
    onNextPage: _onNextPage,
    onToggleToc: _onToggleToc,
    onToggleSettings,
    onToggleBookmarks,
    onToggleSearch,
    onToggleInfo,
    onToggleMenu,
    onAddBookmark,
    isCurrentPageBookmarked,
    activePanel,
    fullscreen,
    onToggleFullscreen,
    onPresent,
    onPrint,
    immersionMode,
    onToggleImmersion,
    speedReadMode,
    onToggleSpeedRead,
    className,
}: WindowTitlebarProps) {
    const [isMaximized, setIsMaximized] = useState(false);
    const menuButtonRef = useRef<HTMLButtonElement>(null);
    const isMenuOpen = activePanel === 'menu';

    const isTauriRuntime = isTauri();
    const isMobileRuntime = isMobile();
    const showDesktopWindowControls = isTauriRuntime && !isMobileRuntime;

    useEffect(() => {
        if (!showDesktopWindowControls) return;
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
        window.addEventListener("resize", updateMaximizedState);
        updateMaximizedState();
        return () => window.removeEventListener("resize", updateMaximizedState);
    }, [showDesktopWindowControls]);

    const formatLocation = () => {
        if (!location) return null;
        if (location.pageInfo) {
            const totalStr = location.pageInfo.totalPages ? ` / ${location.pageInfo.totalPages}` : "";
            if (location.pageItem?.label && location.pageItem.label !== String(location.pageInfo.currentPage)) {
                return `${location.pageItem.label} (${location.pageInfo.currentPage}${totalStr})`;
            }
            return `Page ${location.pageInfo.currentPage}${totalStr}`;
        }
        if (location.pageItem?.label) {
            return location.pageItem.label;
        }
        const percentage = Math.round((location.percentage || 0) * 100);
        return `${percentage}%`;
    };

    const handleMinimize = async () => {
        if (!showDesktopWindowControls) return;
        try { await getCurrentWebviewWindow().minimize(); } catch (err) {  }
    };
    const handleMaximize = async () => {
        if (!showDesktopWindowControls) return;
        try {
            const win = getCurrentWebviewWindow();
            if (isMaximized) await win.unmaximize(); else await win.maximize();
        } catch (err) {  }
    };
    const handleClose = async () => {
        if (!showDesktopWindowControls) return;
        try { await getCurrentWebviewWindow().close(); } catch (err) {  }
    };

    const menuItems: Array<{
        label: string;
        icon: React.ReactNode;
        onClick: () => void;
        active?: boolean;
        disabled?: boolean;
        mobileOnly?: boolean;
    }> = [
            { label: "Search", icon: <Search className="w-5 h-5" />, onClick: onToggleSearch, active: activePanel === "search", mobileOnly: true },
            { label: "Bookmark", icon: <BookmarkIcon className="w-5 h-5" />, onClick: () => onAddBookmark?.(), active: isCurrentPageBookmarked, mobileOnly: true },
            { label: "Reading Settings", icon: <Type className="w-5 h-5" />, onClick: onToggleSettings, active: activePanel === "settings", mobileOnly: true },
            { label: "Annotations & Notes", icon: <BookmarkIcon className="w-5 h-5" />, onClick: onToggleBookmarks, active: activePanel === "bookmarks" },
            { label: "Book Info", icon: <Info className="w-5 h-5" />, onClick: onToggleInfo, active: activePanel === "info" },
        ];

    if (onToggleFullscreen && !isMobileRuntime) {
        menuItems.push({
            label: fullscreen ? "Exit Fullscreen" : "Fullscreen",
            icon: fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />,
            onClick: onToggleFullscreen,
            active: fullscreen,
        });
    }

    if (onPresent && !isMobileRuntime) {
        menuItems.push({ label: "Present", icon: <Presentation className="w-4 h-4" />, onClick: onPresent });
    }
    if (onPrint && !isMobileRuntime) {
        menuItems.push({ label: "Print…", icon: <Printer className="w-4 h-4" />, onClick: onPrint });
    }

    if (onToggleImmersion) {
        menuItems.push({
            label: immersionMode ? "Exit Immersion" : "Immersion Reading",
            icon: <Headphones className={cn("w-5 h-5", immersionMode && "fill-current")} />,
            onClick: onToggleImmersion,
            active: immersionMode,
            mobileOnly: true,
        });
    }
    if (onToggleSpeedRead) {
        menuItems.push({
            label: speedReadMode ? "Exit Speed Read" : "Speed Read",
            icon: <Zap className="w-5 h-5" />,
            onClick: onToggleSpeedRead,
            active: speedReadMode,
            mobileOnly: true,
        });
    }

    return (
        <div
            className={cn(
                "w-full z-[150] select-none reader-toolbar relative",
                "border-b border-[var(--color-border)] bg-[var(--color-surface)]",
                "pt-[max(env(safe-area-inset-top,0px),2px)] lg:pt-0",
                className
            )}
            onDoubleClick={showDesktopWindowControls ? handleMaximize : undefined}
        >
            <div className="h-12 lg:h-11 flex items-center gap-1 pl-3 pr-2">
                
                <div className="flex items-center gap-1 min-w-0 flex-1 lg:flex-none lg:max-w-[480px]">
                    <button
                        onClick={onBack}
                        className={cn(ICON_BUTTON_CLASS, "mr-1 sm:mr-2 shrink-0 text-[color:var(--color-text-primary)]")}
                        aria-label="Back to Library"
                        title="Back to Library"
                    >
                        <ArrowLeft className="w-5 h-5" />
                    </button>

                    <div className="flex-1 min-w-0 text-left overflow-hidden pr-1 sm:pr-2">
                        <h1
                            className="text-xs sm:text-sm font-bold truncate leading-tight text-[color:var(--color-text-primary)]"
                            title={metadata?.title}
                        >
                            {metadata?.title || "Loading..."}
                        </h1>
                        {formatLocation() && (
                            <div
                                className="text-[10px] sm:text-[11px] truncate font-mono font-medium mt-0.5 leading-tight text-[color:var(--color-text-secondary)]"
                            >
                                {formatLocation()}
                            </div>
                        )}
                    </div>
                </div>

                {/* Center Spacer (Desktop only to prevent taking mobile title space) */}
                <div className="hidden lg:block flex-1 min-w-0 pointer-events-none" />

                <div className="hidden sm:flex items-center gap-0.5 mr-0.5">
                    <ToolbarButton onClick={onToggleSearch} active={activePanel === "search"} title="Search" aria-label="Search">
                        <Search className="w-5 h-5" />
                    </ToolbarButton>

                    {onAddBookmark && (
                        <ToolbarButton
                            onClick={onAddBookmark}
                            active={isCurrentPageBookmarked}
                            title={isCurrentPageBookmarked ? "Remove Bookmark" : "Add Bookmark"}
                            aria-label={isCurrentPageBookmarked ? "Remove Bookmark" : "Add Bookmark"}
                        >
                            <BookmarkIcon className={cn("w-5 h-5", isCurrentPageBookmarked ? "fill-current" : "")} />
                        </ToolbarButton>
                    )}

                    {onToggleImmersion && (
                        <ToolbarButton
                            onClick={onToggleImmersion}
                            active={immersionMode}
                            title={immersionMode ? "Exit Immersion Reading" : "Immersion Reading"}
                            aria-label={immersionMode ? "Exit Immersion Reading" : "Immersion Reading"}
                        >
                            <Headphones className={cn("w-5 h-5", immersionMode && "fill-current")} />
                        </ToolbarButton>
                    )}
                    {onToggleSpeedRead && (
                        <ToolbarButton
                            onClick={onToggleSpeedRead}
                            active={speedReadMode}
                            title={speedReadMode ? "Exit Speed Read" : "Speed Read"}
                            aria-label={speedReadMode ? "Exit Speed Read" : "Speed Read"}
                        >
                            <Zap className="w-5 h-5" />
                        </ToolbarButton>
                    )}

                    <ToolbarButton onClick={onToggleSettings} active={activePanel === "settings"} title="Reading Settings" aria-label="Reading Settings">
                        <Type className="w-5 h-5" />
                    </ToolbarButton>
                </div>

                <div className="sm:hidden">
                    <ToolbarButton onClick={onToggleSettings} active={activePanel === "settings"} title="Reading Settings" aria-label="Reading Settings">
                        <Type className="w-5 h-5" />
                    </ToolbarButton>
                </div>

                <button
                    ref={menuButtonRef}
                    onClick={onToggleMenu}
                    className={cn(ICON_BUTTON_CLASS, isMenuOpen && ICON_BUTTON_ACTIVE_CLASS, "text-[color:var(--color-text-primary)]")}
                    aria-label="More options"
                >
                    <EllipsisVertical className="w-5 h-5" />
                </button>

                <MobileMenu
                    isOpen={isMenuOpen}
                    onClose={onToggleMenu}
                    items={menuItems}
                    triggerRef={menuButtonRef}
                />

                {showDesktopWindowControls && (
                    <div className="hidden lg:flex items-center gap-1 ml-2 pl-2 border-l border-[var(--color-border)]">
                        <button onClick={handleMinimize} className={cn(ICON_BUTTON_CLASS, "text-[color:var(--color-text-primary)]")} aria-label="Minimize"><Minus className="w-5 h-5" /></button>
                        <button onClick={handleMaximize} className={cn(ICON_BUTTON_CLASS, "text-[color:var(--color-text-primary)]")} aria-label={isMaximized ? "Restore" : "Maximize"}><Maximize2 className="w-5 h-5" /></button>
                        <button onClick={handleClose} className={cn(ICON_BUTTON_CLASS, "text-[color:var(--color-text-primary)] hover:bg-[color:color-mix(in_srgb,var(--color-error)_14%,transparent)] hover:text-[color:var(--color-error)]")} aria-label="Close"><X className="w-5 h-5" /></button>
                    </div>
                )}
            </div>
        </div>
    );
}

export default WindowTitlebar;
