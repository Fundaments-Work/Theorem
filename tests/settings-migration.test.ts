import { describe, expect, it } from "vitest";
import { useSettingsStore } from "../src/core/store/settingsStore";

type Migrate = (state: unknown, version: number) => {
    settings: Record<string, any>;
};

function migrate(): Migrate {
    const options = (useSettingsStore as any).persist?.getOptions?.();
    expect(options).toBeDefined();
    return options.migrate as Migrate;
}

describe("settings defaults", () => {
    it("enables TTS and automatic sync out of the box", () => {
        const { settings } = useSettingsStore.getState();
        expect(settings.tts.enabled).toBe(true);
        expect(settings.deviceSync.autoSyncEnabled).toBe(true);
        expect(settings.deviceSync.syncOnConnect).toBe(true);
    });
});

describe("settings migration", () => {
    it("fills in sync and TTS defaults when migrating from before version 12", () => {
        const legacyState = {
            settings: {
                theme: "system",
                tts: { voice: "af_bella", speed: 1.0 },
                deviceSync: { deviceId: "test-device", deviceName: "My Phone", pairedDevices: [] },
            },
        };

        const migrated = migrate()(legacyState, 11);
        expect(migrated.settings.tts.enabled).toBe(true);
        expect(migrated.settings.deviceSync.autoSyncEnabled).toBe(true);
        expect(migrated.settings.deviceSync.syncOnConnect).toBe(true);
        expect(migrated.settings.deviceSync.deviceId).toBe("test-device");
    });

    it("never forces autoSyncEnabled off for a device that already chose a value", () => {
        const migrated = migrate()(
            { settings: { deviceSync: { deviceId: "d", autoSyncEnabled: false } } },
            11,
        );
        expect(migrated.settings.deviceSync.autoSyncEnabled).toBe(false);
    });

    it("resets the retired series library sort to the default", () => {
        const defaultSort = useSettingsStore.getState().settings.librarySortBy;
        const migrated = migrate()({ settings: { librarySortBy: "series" } }, 13);
        expect(migrated.settings.librarySortBy).toBe(defaultSort);
        expect(migrated.settings.librarySortBy).not.toBe("series");
    });

    it("keeps every other persisted library sort untouched", () => {
        for (const sortBy of ["title", "author", "lastRead", "progress"]) {
            const migrated = migrate()({ settings: { librarySortBy: sortBy } }, 13);
            expect(migrated.settings.librarySortBy).toBe(sortBy);
        }
    });
});
