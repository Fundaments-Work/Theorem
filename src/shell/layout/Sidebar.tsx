import { type ReactNode, memo } from "react";
import {
    Flame,
    Compass,
    FolderOpen,
    Library,
    NotebookPen,
    Rss,
    Settings,
} from "lucide-react";
import { cn } from "../../core/lib/utils";
import { useUIStore } from "../../core/store";
import { useSettingsStore } from "../../core/store";
import type { AppRoute } from "../../core/types";
import { TheoremLogo } from "../TheoremLogo";
import { MomoIcon } from "../../ui/MomoIcon";
import { useSupportPrompt } from "../../core/lib/support-prompt";

interface SidebarItem {
    id: AppRoute;
    label: string;
    icon: ReactNode;
    /** Other routes that belong to this item, so it stays lit on them. */
    alsoActiveOn?: ReadonlyArray<AppRoute>;
}

const mainNavItems: SidebarItem[] = [
    { id: "library", label: "Library", icon: <Library className="h-[var(--icon-size-sm)] w-[var(--icon-size-sm)]" /> },
    // Bookmarks is a tab inside Workbench (with Highlights, Notes and Words), not a rail destination.
    { id: "annotations", label: "Workbench", icon: <NotebookPen className="h-[var(--icon-size-sm)] w-[var(--icon-size-sm)]" />, alsoActiveOn: ["bookmarks", "vocabulary"] },
    { id: "shelves", label: "Shelves", icon: <FolderOpen className="h-[var(--icon-size-sm)] w-[var(--icon-size-sm)]" /> },
    { id: "feeds", label: "Snapshots", icon: <Rss className="h-[var(--icon-size-sm)] w-[var(--icon-size-sm)]" /> },
    { id: "opds", label: "Discover", icon: <Compass className="h-[var(--icon-size-sm)] w-[var(--icon-size-sm)]" /> },
];

export const Sidebar = memo(function Sidebar() {
    const currentRoute = useUIStore((state) => state.currentRoute);
    const setRoute = useUIStore((state) => state.setRoute);
    const currentStreak = useSettingsStore((state) => state.stats.currentStreak);
    const { isEligible: showSupport, openSupport: handleSupportClick } = useSupportPrompt();

    const displayStreak = currentStreak > 0;

    const items = mainNavItems;

    const select = (id: AppRoute) => {
        if (currentRoute !== id) {
            setRoute(id);
            if (id !== "library") {
                sessionStorage.removeItem("theorem-selected-shelf");
            }
        }
    };

    // Same rule as the Fundaments.work activity bar: the open item is marked by a
    // lime edge, hover is the signal colour and never a background.
    const railButton = (id: AppRoute, label: string, icon: ReactNode, onClick: () => void, alsoActiveOn?: ReadonlyArray<AppRoute>) => {
        const isActive = currentRoute === id || (alsoActiveOn?.includes(currentRoute) ?? false);
        return (
            <button
                key={id}
                type="button"
                onClick={onClick}
                className={cn(
                    "group relative flex h-12 w-12 shrink-0 items-center justify-center",
                    isActive ? "text-[color:var(--color-accent)]" : "text-[color:var(--color-text-secondary)] ui-signal-hover",
                )}
                aria-label={label}
                aria-current={isActive ? "page" : undefined}
            >
                {isActive && <span className="absolute inset-y-0 left-0 w-0.5 bg-[color:var(--color-accent)]"aria-hidden="true" />}
                {icon}
                <span
                    className="pointer-events-none absolute left-full top-1/2 z-30 ml-1 hidden -translate-y-1/2 whitespace-nowrap border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-2 py-1 text-xs text-[color:var(--color-text-primary)] group-hover:flex group-focus-visible:flex"
                    aria-hidden="true"
                >
                    {label}
                </span>
            </button>
        );
    };

    return (
        <aside
            aria-label="Workbench views"
            className="relative z-30 flex h-full w-[var(--layout-sidebar-width)] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-background)]"
        >
            <div className="flex h-[var(--layout-sidebar-header-height)] items-center justify-center border-b border-[var(--color-border)]">
                <TheoremLogo size={24} className="shrink-0" />
            </div>
            <nav aria-label="Main navigation"className="flex flex-1 flex-col min-h-0">
                {items.map((item) => railButton(item.id, item.label, item.icon, () => select(item.id), item.alsoActiveOn))}
            </nav>
            <div className="mt-auto flex flex-col">
                {displayStreak && (
                    <div className="flex flex-col items-center gap-0.5 py-2"title={`${currentStreak} day streak`}>
                        <Flame className="h-4 w-4 text-[color:var(--color-accent)]" />
                        <span className="font-mono text-[10px] text-[color:var(--color-text-primary)]">{currentStreak}</span>
                    </div>
                )}
                {showSupport && (
                    <button
                        type="button"
                        onClick={() => void handleSupportClick()}
                        className="group relative flex h-12 w-12 items-center justify-center text-[color:var(--color-text-secondary)] ui-signal-hover"
                        aria-label="Support Theorem on Buy Me Momo"
                    >
                        <MomoIcon className="h-4 w-4" />
                    </button>
                )}
                {railButton("settings", "Settings", <Settings className="h-4 w-4" />, () => setRoute("settings"))}
            </div>
        </aside>
    );
});
