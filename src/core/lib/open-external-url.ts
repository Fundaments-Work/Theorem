/**
 * Unified external URL opener for Theorem.
 *
 * Uses Tauri's `@tauri-apps/plugin-opener` on native desktop/mobile platforms,
 * falling back to `window.open` in standard browser environments or when
 * the native plugin is unavailable.
 */
export async function openExternalUrl(url: string): Promise<void> {
    if (!url) return;

    try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(url);
        return;
    } catch {
        /* plugin unavailable (browser environment, test harness, or older native) — fall through */
    }

    if (typeof window !== "undefined") {
        window.open(url, "_blank", "noopener,noreferrer");
    }
}
