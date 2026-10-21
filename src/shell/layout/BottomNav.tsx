import { memo } from "react";
import { useUIStore } from "../../core/store";
import { isNavItemActive, PRIMARY_DESTINATIONS } from "./nav-items";

export { isNavItemActive };

// The same five destinations, in the same order, as the desktop rail (see nav-items.ts).
// Settings and Statistics live in the top bar on phones; Bookmarks is a tab inside Workbench.
export const BottomNav = memo(function BottomNav() {
    const currentRoute = useUIStore((state) => state.currentRoute);
    const setRoute = useUIStore((state) => state.setRoute);
    return (
        <nav aria-label="Primary navigation" className="ui-bottom-nav fixed bottom-0 left-0 right-0 z-[var(--z-nav)] pb-[env(safe-area-inset-bottom)] md:hidden">
            <ul className="ui-bottom-nav-list px-2">
                {PRIMARY_DESTINATIONS.map((item) => {
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
                                    <item.Icon className="h-[var(--icon-size-lg)] w-[var(--icon-size-lg)]" />
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
