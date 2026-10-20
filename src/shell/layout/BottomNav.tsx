import { type ReactNode, memo } from "react";
import {
    Compass,
    FolderOpen,
    Library,
    NotebookPen,
    Rss,
} from "lucide-react";
import { useUIStore } from "../../core/store";
import type { AppRoute } from "../../core/types";

interface NavItem {
    id: AppRoute;
    label: string;
    icon: ReactNode;
    /** Other routes that belong to this tab, so it stays lit on them (Bookmarks is a Workbench tab). */
    alsoActiveOn?: ReadonlyArray<AppRoute>;
}

// Five destinations is what a thumb reaches comfortably. Settings lives in the top bar next to
// Statistics; Bookmarks is a tab inside Workbench (see WorkbenchTabs).
const navItems: NavItem[] = [
    { id: "library", label: "Library", icon: <Library className="h-[var(--icon-size-lg)] w-[var(--icon-size-lg)]" /> },
    { id: "shelves", label: "Shelves", icon: <FolderOpen className="h-[var(--icon-size-lg)] w-[var(--icon-size-lg)]" /> },
    { id: "opds", label: "Discover", icon: <Compass className="h-[var(--icon-size-lg)] w-[var(--icon-size-lg)]" /> },
    {
        id: "annotations",
        label: "Workbench",
        icon: <NotebookPen className="h-[var(--icon-size-lg)] w-[var(--icon-size-lg)]" />,
        alsoActiveOn: ["bookmarks", "vocabulary"],
    },
    { id: "feeds", label: "Feeds", icon: <Rss className="h-[var(--icon-size-lg)] w-[var(--icon-size-lg)]" /> },
];

export function isNavItemActive(item: NavItem, route: AppRoute): boolean {
    return route === item.id || (item.alsoActiveOn?.includes(route) ?? false);
}

export const BottomNav = memo(function BottomNav() {
    const currentRoute = useUIStore((state) => state.currentRoute);
    const setRoute = useUIStore((state) => state.setRoute);
    return (
        <nav aria-label="Primary navigation" className="ui-bottom-nav fixed bottom-0 left-0 right-0 z-[var(--z-nav)] pb-[env(safe-area-inset-bottom)] md:hidden">
            <ul className="ui-bottom-nav-list px-2">
                {navItems.map((item) => {
                    const isActive = isNavItemActive(item, currentRoute);
                    return (
                        <li key={item.id} className="flex-1">
                            <button
                                onClick={() => {
                                    if (!isActive) {
                                        setRoute(item.id);
                                        if (item.id !== "library") {
                                            sessionStorage.removeItem("theorem-selected-shelf");
                                        }
                                    }
                                }}
                                className="ui-bottom-nav-btn"
                                data-active={isActive ? "true" : undefined}
                                aria-current={isActive ? "page" : undefined}
                            >
                                <span className="ui-bottom-nav-pill">
                                    {item.icon}
                                </span>
                                <span className="ui-bottom-nav-label">{item.label}</span>
                            </button>
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
});
