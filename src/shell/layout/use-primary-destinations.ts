import { useSettingsStore } from "../../core/store";
import { PRIMARY_DESTINATIONS } from "./nav-items";

/** Device-local visibility shared by the desktop rail and phone bar. */
export function usePrimaryDestinations() {
    const showDiscover = useSettingsStore((state) => state.showDiscover);
    const showFeeds = useSettingsStore((state) => state.showFeeds);
    return PRIMARY_DESTINATIONS.filter((item) =>
        (item.id !== "opds" || showDiscover) && (item.id !== "feeds" || showFeeds),
    );
}
