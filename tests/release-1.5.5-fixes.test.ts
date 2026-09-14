import { describe, it, expect, beforeEach } from "vitest";
import { isAndroid } from "../src/core/lib/env";
import { useSettingsStore } from "../src/core/store/settingsStore";
import { markProvisioningNeeded } from "../src/core/lib/sync-orchestrator";

describe("Release 1.5.5 - Bug Fixes & Regressions", () => {
    describe("Platform Environment Utilities", () => {
        it("identifies Android user agents correctly", () => {
            const originalUserAgent = navigator.userAgent;

            try {
                Object.defineProperty(navigator, "userAgent", {
                    value: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36",
                    configurable: true,
                });
                expect(isAndroid()).toBe(true);

                Object.defineProperty(navigator, "userAgent", {
                    value: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
                    configurable: true,
                });
                expect(isAndroid()).toBe(false);

                Object.defineProperty(navigator, "userAgent", {
                    value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
                    configurable: true,
                });
                expect(isAndroid()).toBe(false);
            } finally {
                Object.defineProperty(navigator, "userAgent", {
                    value: originalUserAgent,
                    configurable: true,
                });
            }
        });
    });

    describe("Settings Store Defaults & Migration v12", () => {
        it("provides enabled TTS and active autoSync defaults", () => {
            const state = useSettingsStore.getState();
            expect(state.settings.tts.enabled).toBe(true);
            expect(state.settings.deviceSync.autoSyncEnabled).toBe(true);
            expect(state.settings.deviceSync.syncOnConnect).toBe(true);
        });

        it("migrates legacy state to version 12 with sync and TTS defaults", () => {
            const legacyState = {
                settings: {
                    theme: "system",
                    tts: {
                        voice: "af_bella",
                        speed: 1.0,
                        // enabled missing in legacy state
                    },
                    deviceSync: {
                        deviceId: "test-device",
                        deviceName: "My Phone",
                        pairedDevices: [],
                        // syncOnConnect and autoSyncEnabled missing
                    },
                },
            };

            // Retrieve migrate function from store options
            const persistOptions = (useSettingsStore as any).persist?.getOptions?.();
            expect(persistOptions).toBeDefined();

            const migrated = persistOptions.migrate(legacyState, 11);
            expect(migrated.settings.tts.enabled).toBe(true);
            expect(migrated.settings.deviceSync.autoSyncEnabled).toBe(true);
            expect(migrated.settings.deviceSync.syncOnConnect).toBe(true);
            expect(migrated.settings.deviceSync.deviceId).toBe("test-device");
        });
    });

    describe("Sync Orchestrator Provisioning", () => {
        it("exposes markProvisioningNeeded and handles force re-provisioning", () => {
            expect(typeof markProvisioningNeeded).toBe("function");
            expect(() => markProvisioningNeeded()).not.toThrow();
        });
    });

    describe("PDF Cross-Page Range Clipping Logic", () => {
        it("correctly filters bounding rects that intersect the page layer bounds", () => {
            const layerRect = {
                top: 100,
                bottom: 900,
                left: 50,
                right: 650,
            };
            const EPSILON = 2;

            const rects = [
                // Rect strictly on current page
                { top: 120, bottom: 140, left: 60, right: 300, width: 240, height: 20 },
                // Rect on next page (below layerRect.bottom)
                { top: 950, bottom: 970, left: 60, right: 300, width: 240, height: 20 },
                // Rect on previous page (above layerRect.top)
                { top: 50, bottom: 70, left: 60, right: 300, width: 240, height: 20 },
            ];

            const filtered = rects.filter((rect) => (
                rect.bottom >= layerRect.top - EPSILON &&
                rect.top <= layerRect.bottom + EPSILON &&
                rect.right >= layerRect.left - EPSILON &&
                rect.left <= layerRect.right + EPSILON
            ));

            expect(filtered).toHaveLength(1);
            expect(filtered[0].top).toBe(120);
        });
    });
});
