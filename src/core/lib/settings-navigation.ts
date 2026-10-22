import { useUIStore } from "../store";

/** Settings tab ids, as Settings.tsx stores them. */
export type SettingsTab = "general" | "dictionary" | "integrations" | "storage" | "shortcuts" | "about";

/**
 * Opens Settings on a tab and, optionally, scrolls to one of its sections
 * (Settings reads both once from sessionStorage when it mounts).
 */
export function openSettingsSection(tab: SettingsTab, section?: string): void {
    try {
        window.sessionStorage.setItem("theorem-settings:active-tab", tab);
        if (section) window.sessionStorage.setItem("theorem-settings:focus-section", section);
    } catch {
        // Settings opens on its last tab.
    }
    useUIStore.getState().setRoute("settings");
}

/** Opens Settings → Devices at the Device Sync section. */
export function openDeviceSyncSettings(): void {
    openSettingsSection("integrations", "device-sync");
}
