/**
 * Android's real system-bar and cutout insets as CSS variables (`--system-inset-*`), which the
 * `--safe-area-*` tokens in design-tokens.css combine with the webview's own safe-area env().
 *
 * Android's WebView reports only the camera cutout through env(), so with edge-to-edge (always
 * on from Android 15) the page drew under the status bar and the gesture bar: onboarding's
 * Skip could not be tapped and the bottom bar's labels sat under the gesture handle. The
 * insets are read once at start and again whenever they can change (rotation, a switch
 * between gesture and button navigation, return to the app).
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauriMobile } from "./env";

export interface SystemInsets {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

const SIDES = ["top", "right", "bottom", "left"] as const;

/** Writes the insets as `--system-inset-*`; anything that is not a sane CSS pixel count is 0. */
export function applySystemInsets(insets: Partial<SystemInsets> | null | undefined, root: HTMLElement = document.documentElement): void {
    for (const side of SIDES) {
        const value = Number(insets?.[side]);
        const px = Number.isFinite(value) && value > 0 ? Math.min(Math.round(value * 100) / 100, 512) : 0;
        root.style.setProperty(`--system-inset-${side}`, `${px}px`);
    }
}

/** Android only; elsewhere env() is right and this does nothing. Returns a stop function. */
export function startSystemInsets(read: () => Promise<SystemInsets> = () => invoke<SystemInsets>("system_insets")): () => void {
    if (!isTauriMobile()) return () => undefined;
    let stopped = false;
    let latest = 0;
    const refresh = () => {
        const request = ++latest;
        read()
            .then((insets) => {
                // Only the newest answer counts, so a slow one never overwrites a later one.
                if (!stopped && request === latest) applySystemInsets(insets);
            })
            .catch(() => undefined);
    };
    const onVisibility = () => {
        if (!document.hidden) refresh();
    };
    refresh();
    window.addEventListener("resize", refresh);
    window.addEventListener("orientationchange", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
        stopped = true;
        window.removeEventListener("resize", refresh);
        window.removeEventListener("orientationchange", refresh);
        document.removeEventListener("visibilitychange", onVisibility);
    };
}
