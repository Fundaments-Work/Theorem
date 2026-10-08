import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    isSupportEligible,
    recordSupportInteraction,
    openSupportLink,
    BUY_ME_MOMO_URL,
    SUPPORT_HIDDEN_UNTIL_KEY,
    SUPPORT_LAST_SHOWN_KEY,
    SUPPORT_CADENCE_MS,
} from "../src/core/lib/support-prompt";

const mockOpenExternalUrl = vi.fn();
vi.mock("../src/core/lib/open-external-url", () => ({
    openExternalUrl: (url: string) => mockOpenExternalUrl(url),
}));

describe("support-prompt cadence logic", () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
    });

    it("returns true on initial launch with empty localStorage", () => {
        expect(isSupportEligible()).toBe(true);
    });

    it("records interaction and calculates exactly 30 days ahead", () => {
        const testNow = 1700000000000;
        recordSupportInteraction(testNow);

        expect(localStorage.getItem(SUPPORT_LAST_SHOWN_KEY)).toBe(String(testNow));
        expect(localStorage.getItem(SUPPORT_HIDDEN_UNTIL_KEY)).toBe(
            String(testNow + SUPPORT_CADENCE_MS)
        );
    });

    it("enforces strict boundary conditions around hiddenUntil timestamp", () => {
        const testNow = 1700000000000;
        recordSupportInteraction(testNow);

        const hiddenUntil = testNow + SUPPORT_CADENCE_MS;

        // 1ms before expiry -> still hidden
        expect(isSupportEligible(hiddenUntil - 1)).toBe(false);

        // Exactly at expiry boundary -> becomes eligible
        expect(isSupportEligible(hiddenUntil)).toBe(true);

        // 1ms after expiry -> eligible
        expect(isSupportEligible(hiddenUntil + 1)).toBe(true);
    });

    it("handles corrupted non-numeric storage gracefully", () => {
        localStorage.setItem(SUPPORT_HIDDEN_UNTIL_KEY, "not-a-number");
        expect(isSupportEligible()).toBe(true);
    });

    it("opens Buy Me Momo link and resets cadence", async () => {
        const now = 1700000000000;
        vi.spyOn(Date, "now").mockReturnValue(now);

        await openSupportLink();

        expect(mockOpenExternalUrl).toHaveBeenCalledWith(BUY_ME_MOMO_URL);
        expect(localStorage.getItem(SUPPORT_LAST_SHOWN_KEY)).toBe(String(now));
        expect(localStorage.getItem(SUPPORT_HIDDEN_UNTIL_KEY)).toBe(
            String(now + SUPPORT_CADENCE_MS)
        );
    });
});
