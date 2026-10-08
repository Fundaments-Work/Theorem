import { useState, useCallback } from "react";
import { openExternalUrl } from "./open-external-url";

export const BUY_ME_MOMO_URL = "https://buymemomo.com/usefundaments";
export const SUPPORT_LAST_SHOWN_KEY = "theorem-support:lastShownAt";
export const SUPPORT_HIDDEN_UNTIL_KEY = "theorem-support:hiddenUntil";
export const SUPPORT_CADENCE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Checks whether the Buy Me Momo support prompt is eligible to be shown.
 * Returns true if no hiddenUntil timestamp is set, or if now >= hiddenUntil.
 */
export function isSupportEligible(now = Date.now()): boolean {
    if (typeof localStorage === "undefined") return false;

    try {
        const raw = localStorage.getItem(SUPPORT_HIDDEN_UNTIL_KEY);
        if (!raw) return true;

        const hiddenUntil = parseInt(raw, 10);
        if (isNaN(hiddenUntil)) return true;

        return now >= hiddenUntil;
    } catch {
        return false;
    }
}

/**
 * Records a user interaction (click or dismiss), hiding the prompt for 30 days.
 */
export function recordSupportInteraction(now = Date.now()): void {
    if (typeof localStorage === "undefined") return;

    try {
        localStorage.setItem(SUPPORT_LAST_SHOWN_KEY, String(now));
        localStorage.setItem(SUPPORT_HIDDEN_UNTIL_KEY, String(now + SUPPORT_CADENCE_MS));
    } catch {
        // Storage errors ignored
    }
}

/**
 * Dispatches to Buy Me Momo external URL and resets the 30-day cadence.
 */
export async function openSupportLink(): Promise<void> {
    recordSupportInteraction();
    await openExternalUrl(BUY_ME_MOMO_URL);
}

/**
 * React hook to manage visibility and actions for the Buy Me Momo nudge.
 */
export function useSupportPrompt() {
    const [isEligible, setIsEligible] = useState<boolean>(() => isSupportEligible());

    const openSupport = useCallback(async () => {
        setIsEligible(false);
        await openSupportLink();
    }, []);

    const dismissSupport = useCallback(() => {
        setIsEligible(false);
        recordSupportInteraction();
    }, []);

    return {
        isEligible,
        openSupport,
        dismissSupport,
    };
}
