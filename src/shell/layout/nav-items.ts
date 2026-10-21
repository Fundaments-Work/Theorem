import { Compass, FolderOpen, Library, NotebookPen, Rss, type LucideIcon } from "lucide-react";
import type { AppRoute } from "../../core/types";

export interface NavDestination {
    id: AppRoute;
    label: string;
    Icon: LucideIcon;
    /** Other routes that belong to this destination, so it stays lit on them. */
    alsoActiveOn?: ReadonlyArray<AppRoute>;
}

/**
 * The five primary destinations, in the one order every surface uses: the desktop rail, the
 * phone bottom bar and Ctrl+1–5. One order everywhere keeps spatial memory when switching
 * devices (Material 3 and Apple's HIG both require the rail and the bottom bar to match).
 *
 * Grouped by the reader's job: your books (Library, Shelves), then new reading (Discover,
 * Feeds), then what you kept (Workbench). Library is home, so it comes first. Five is the most a
 * bottom bar holds and a glance takes in; Statistics and Settings are utilities and live apart
 * (rail foot on desktop, top bar on phones). Bookmarks is a tab inside Workbench.
 */
export const PRIMARY_DESTINATIONS: ReadonlyArray<NavDestination> = [
    { id: "library", label: "Library", Icon: Library },
    { id: "shelves", label: "Shelves", Icon: FolderOpen },
    { id: "opds", label: "Discover", Icon: Compass },
    { id: "feeds", label: "Feeds", Icon: Rss },
    { id: "annotations", label: "Workbench", Icon: NotebookPen, alsoActiveOn: ["bookmarks", "vocabulary"] },
];

export function isNavItemActive(item: Pick<NavDestination, "id" | "alsoActiveOn">, route: AppRoute): boolean {
    return route === item.id || (item.alsoActiveOn?.includes(route) ?? false);
}

/**
 * Page shortcuts, numbered like the screen: Ctrl+1–5 are the destinations in rail order, then
 * the utilities and Bookmarks. Settings keeps the platform convention Ctrl+,.
 */
export function navigationShortcuts(): { label: string; keys: string; route: AppRoute }[] {
    return [
        ...PRIMARY_DESTINATIONS.map((d, i) => ({ label: `Go to ${d.label}`, keys: `Ctrl+${i + 1}`, route: d.id })),
        { label: "Go to Statistics", keys: "Ctrl+6", route: "statistics" },
        { label: "Go to Bookmarks", keys: "Ctrl+7", route: "bookmarks" },
        { label: "Go to Settings", keys: "Ctrl+,", route: "settings" },
    ];
}
