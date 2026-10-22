// @vitest-environment jsdom
/**
 * Settings → Data & Storage backup/restore buttons and the startup recovery
 * screen. The Rust side (archive format, validation, identity stripping,
 * snapshots) is covered by `src-tauri/src/db_backup/tests.rs`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";

const h = vi.hoisted(() => ({
    tauri: true,
    mobile: false,
    invoke: vi.fn(),
    save: vi.fn(),
    open: vi.fn(),
    reload: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../src/core/lib/env", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/core/lib/env")>()),
    isTauri: () => h.tauri,
    isMobile: () => h.mobile,
    isTauriMobile: () => h.tauri && h.mobile,
    isTauriDesktop: () => h.tauri && !h.mobile,
}));
vi.mock("../src/core/lib/dialogs", () => ({
    showSaveFileDialog: h.save,
    showOpenFileDialog: h.open,
}));
vi.mock("../src/core/lib/db-backup", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/core/lib/db-backup")>()),
    reloadApp: h.reload,
}));

import { flush, render, unmountAll } from "./helpers/opds-browser-harness";
import { BackupSection } from "../src/features/settings/BackupSection";
import DatabaseRecovery from "../src/shell/DatabaseRecovery";
import {
    clearUnloadSnapshots,
    isPersistenceSuspended,
    resumePersistence,
    suspendPersistence,
} from "../src/core/lib/persist-storage";
import { readStartupDbHealth, type DbHealth } from "../src/core/lib/db-health";
import { defaultBackupFileName } from "../src/core/lib/db-backup";

const manifest = {
    format: "theorem-backup",
    formatVersion: 1,
    appVersion: "1.6.0",
    createdAt: "2026-10-20T08:00:00Z",
    platform: "linux",
    schema: { userVersion: 0, tables: ["book_metadata"] },
    counts: {
        books: 12,
        annotations: 1,
        vocabulary: 3,
        rssFeeds: 0,
        rssArticles: 0,
        readingSessions: 0,
        bookFiles: 11,
        missingBookFiles: 1,
        audiobookFiles: 0,
        dictionaryFiles: 0,
    },
    includesDictionaries: false,
    totalBytes: 1000,
};

const snapshot = { name: "theorem-1760000000-v1.6.0.db", createdAt: 1760000000, appVersion: "1.6.0", size: 2048 };

type Handler = (args?: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler>;

function button(label: string | RegExp): HTMLButtonElement {
    const all = Array.from(document.body.querySelectorAll("button"));
    const found = all.find((b) =>
        typeof label === "string"
            ? b.textContent?.trim().startsWith(label) || b.getAttribute("aria-label") === label
            : label.test(b.textContent ?? "") || label.test(b.getAttribute("aria-label") ?? ""),
    );
    if (!found) throw new Error(`No button ${label}; have: ${all.map((b) => b.textContent?.trim()).join(" | ")}`);
    return found as HTMLButtonElement;
}

async function click(el: HTMLElement) {
    await act(async () => {
        el.click();
    });
    await flush();
}

function calls(command: string) {
    return h.invoke.mock.calls.filter(([name]) => name === command);
}

beforeEach(() => {
    h.tauri = true;
    h.mobile = false;
    h.save.mockReset();
    h.open.mockReset();
    h.reload.mockReset();
    h.invoke.mockReset();
    handlers = {
        db_list_snapshots: () => [snapshot],
        db_backup_inspect: () => manifest,
        db_backup_create: () => ({ location: "/tmp/x.theorem-backup", manifest, size: 4096 }),
        db_backup_restore: () => ({ manifest, filesRestored: 11, migrationError: null }),
        db_restore_snapshot: () => ({ manifest: null, filesRestored: 0, migrationError: null }),
        db_health_dismiss: () => undefined,
    };
    h.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
        const handler = handlers[command];
        if (!handler) throw new Error(`unexpected invoke ${command}`);
        return handler(args);
    });
    resumePersistence();
});

afterEach(() => {
    unmountAll();
    resumePersistence();
});

describe("Settings backup section", () => {
    it("shows create, restore and the automatic copies", async () => {
        render(<BackupSection />);
        await flush();
        expect(button("Create Backup File")).toBeTruthy();
        expect(button("Restore from Backup")).toBeTruthy();
        expect(button(/Restore the copy from/)).toBeTruthy();
        expect(document.body.textContent).toContain("Theorem 1.6.0");
    });

    it("saves a backup where the user chose, with dictionaries only when asked", async () => {
        h.save.mockResolvedValue("/home/me/theorem.theorem-backup");
        render(<BackupSection />);
        await flush();

        await click(button("Create Backup File"));
        expect(h.save).toHaveBeenCalledTimes(1);
        expect(h.save.mock.calls[0][0].defaultPath).toMatch(/^theorem-\d{4}-\d{2}-\d{2}\.theorem-backup$/);
        expect(calls("db_backup_create")).toEqual([
            ["db_backup_create", { outputPath: "/home/me/theorem.theorem-backup", includeDictionaries: false }],
        ]);
        expect(document.body.textContent).toContain("Backup Saved");
        expect(document.body.textContent).toContain("1 book is not on this device");
        await click(button("OK"));

        await click(button("On"));
        await click(button("Create Backup File"));
        expect(calls("db_backup_create")[1][1]).toEqual({
            outputPath: "/home/me/theorem.theorem-backup",
            includeDictionaries: true,
        });
    });

    it("does nothing when the save dialog is cancelled", async () => {
        h.save.mockResolvedValue(null);
        render(<BackupSection />);
        await flush();
        await click(button("Create Backup File"));
        expect(calls("db_backup_create")).toHaveLength(0);
        expect(button("Create Backup File").disabled).toBe(false);
    });

    it("on Android writes to Downloads without a save dialog", async () => {
        h.mobile = true;
        render(<BackupSection />);
        await flush();
        await click(button("Create Backup File"));
        expect(h.save).not.toHaveBeenCalled();
        expect(calls("db_backup_create")[0][1]).toEqual({ outputPath: null, includeDictionaries: false });
    });

    it("reports a failed backup", async () => {
        h.save.mockResolvedValue("/x.theorem-backup");
        handlers.db_backup_create = () => {
            throw "Cannot write backup: disk full";
        };
        render(<BackupSection />);
        await flush();
        await click(button("Create Backup File"));
        expect(document.body.textContent).toContain("Backup Failed");
        expect(document.body.textContent).toContain("disk full");
    });

    it("asks before restoring, then replaces the library with writes suspended and reloads", async () => {
        h.open.mockResolvedValue("/home/me/old.theorem-backup");
        let suspendedDuringRestore: boolean | null = null;
        handlers.db_backup_restore = (args) => {
            suspendedDuringRestore = isPersistenceSuspended();
            expect(args).toEqual({ path: "/home/me/old.theorem-backup" });
            return { manifest, filesRestored: 11, migrationError: null };
        };
        localStorage.setItem("theorem-unload:theorem-library", "{}");
        localStorage.setItem("theorem-settings:active-tab", "storage");
        render(<BackupSection />);
        await flush();

        await click(button("Restore from Backup"));
        expect(calls("db_backup_inspect")).toEqual([["db_backup_inspect", { path: "/home/me/old.theorem-backup" }]]);
        expect(calls("db_backup_restore")).toHaveLength(0);
        const text = document.body.textContent ?? "";
        expect(text).toContain("12 books");
        expect(text).toContain("Theorem 1.6.0");
        expect(text).toContain("replaces");

        await click(button("Replace Library"));
        expect(calls("db_backup_restore")).toHaveLength(1);
        expect(suspendedDuringRestore).toBe(true);
        expect(isPersistenceSuspended()).toBe(true);
        expect(localStorage.getItem("theorem-unload:theorem-library")).toBeNull();
        expect(localStorage.getItem("theorem-settings:active-tab")).toBe("storage");
        expect(h.reload).toHaveBeenCalledTimes(1);
    });

    it("cancelling the confirmation restores nothing", async () => {
        h.open.mockResolvedValue("/home/me/old.theorem-backup");
        render(<BackupSection />);
        await flush();
        await click(button("Restore from Backup"));
        await click(button("Cancel"));
        expect(calls("db_backup_restore")).toHaveLength(0);
        expect(h.reload).not.toHaveBeenCalled();
    });

    it("rejects an invalid file before asking", async () => {
        h.open.mockResolvedValue("/home/me/notes.txt");
        handlers.db_backup_inspect = () => {
            throw "This is not a Theorem backup file (not a valid archive).";
        };
        render(<BackupSection />);
        await flush();
        await click(button("Restore from Backup"));
        expect(document.body.textContent).toContain("Cannot Restore This File");
        expect(document.body.textContent).toContain("not a Theorem backup");
        expect(document.body.textContent).not.toContain("Replace Library");
    });

    it("a failed restore resumes persistence and keeps the app running", async () => {
        h.open.mockResolvedValue("/b.theorem-backup");
        handlers.db_backup_restore = () => {
            throw "The backup's database is damaged";
        };
        render(<BackupSection />);
        await flush();
        await click(button("Restore from Backup"));
        await click(button("Replace Library"));
        expect(isPersistenceSuspended()).toBe(false);
        expect(h.reload).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain("Restore Failed");
        expect(button("Restore from Backup").disabled).toBe(false);
    });

    it("restores an automatic copy after confirmation", async () => {
        render(<BackupSection />);
        await flush();
        await click(button(/Restore the copy from/));
        expect(document.body.textContent).toContain("Restore Automatic Copy");
        await click(button("Replace Library"));
        expect(calls("db_restore_snapshot")).toEqual([["db_restore_snapshot", { name: snapshot.name }]]);
        expect(h.reload).toHaveBeenCalledTimes(1);
    });

    it("materializes an Android content URI before inspecting it", async () => {
        h.mobile = true;
        h.open.mockResolvedValue("content://downloads/42");
        handlers.materialize_android_content_uri = () => "/data/import/restore.theorem-backup";
        render(<BackupSection />);
        await flush();
        await click(button("Restore from Backup"));
        expect(h.open.mock.calls[0][0].filters).toBeUndefined();
        expect(calls("materialize_android_content_uri")[0][1]).toEqual({
            uri: "content://downloads/42",
            fileName: "restore.theorem-backup",
        });
        expect(calls("db_backup_inspect")[0][1]).toEqual({ path: "/data/import/restore.theorem-backup" });
    });

    it("explains that backups need the app in a browser", async () => {
        h.tauri = false;
        render(<BackupSection />);
        await flush();
        expect(document.body.querySelectorAll("button")).toHaveLength(0);
        expect(document.body.textContent).toContain("desktop and Android apps");
        expect(h.invoke).not.toHaveBeenCalled();
    });
});

describe("startup recovery screen", () => {
    const corrupt: DbHealth = {
        status: "corrupt",
        message: "Database is damaged: *** in database main ***",
        checked: true,
        snapshots: [snapshot],
    };

    it("startup health is only reported when something is wrong", async () => {
        handlers.db_health_status = () => ({ status: "ok", message: null, checked: false, snapshots: [] });
        expect(await readStartupDbHealth()).toBeNull();
        handlers.db_health_status = () => corrupt;
        expect(await readStartupDbHealth()).toEqual(corrupt);
        handlers.db_health_status = () => {
            throw "unknown command";
        };
        expect(await readStartupDbHealth()).toBeNull();
        h.tauri = false;
        expect(await readStartupDbHealth()).toBeNull();
    });

    it("offers the snapshot and restores it", async () => {
        suspendPersistence();
        render(<DatabaseRecovery health={corrupt} />);
        await flush();
        expect(document.body.textContent).toContain("damaged");
        expect(document.body.textContent).toContain(corrupt.message);
        await click(button(/Restore the copy from/));
        expect(calls("db_restore_snapshot")).toEqual([["db_restore_snapshot", { name: snapshot.name }]]);
        expect(h.reload).toHaveBeenCalledTimes(1);
    });

    it("shows a restore error and lets the user try something else", async () => {
        handlers.db_restore_snapshot = () => {
            throw "Restore failed: disk full";
        };
        render(<DatabaseRecovery health={corrupt} />);
        await flush();
        await click(button(/Restore the copy from/));
        expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("disk full");
        expect(button("Continue Anyway").disabled).toBe(false);
        expect(h.reload).not.toHaveBeenCalled();
    });

    it("restores from a backup file after confirming", async () => {
        h.open.mockResolvedValue("/b.theorem-backup");
        render(<DatabaseRecovery health={{ ...corrupt, snapshots: [] }} />);
        await flush();
        expect(document.body.textContent).not.toContain("Automatic copies");
        await click(button("Restore from Backup File"));
        expect(calls("db_backup_restore")).toHaveLength(0);
        await click(button("Replace Library"));
        expect(calls("db_backup_restore")).toEqual([["db_backup_restore", { path: "/b.theorem-backup" }]]);
        expect(h.reload).toHaveBeenCalledTimes(1);
    });

    it("continue anyway dismisses the warning, resumes writes and reloads", async () => {
        suspendPersistence();
        render(
            <DatabaseRecovery
                health={{ status: "migration_failed", message: "no such column", checked: true, snapshots: [] }}
            />,
        );
        await flush();
        expect(document.body.textContent).toContain("could not update");
        await click(button("Continue Anyway"));
        expect(calls("db_health_dismiss")).toHaveLength(1);
        expect(isPersistenceSuspended()).toBe(false);
        expect(h.reload).toHaveBeenCalledTimes(1);
    });
});

describe("helpers", () => {
    it("names backups by local date", () => {
        expect(defaultBackupFileName(new Date(2026, 0, 5, 23, 30))).toBe("theorem-2026-01-05.theorem-backup");
    });

    it("clearUnloadSnapshots removes only unload snapshots", () => {
        localStorage.clear();
        localStorage.setItem("theorem-unload:a", "1");
        localStorage.setItem("theorem-unload:b", "2");
        localStorage.setItem("theorem-library", "keep");
        clearUnloadSnapshots();
        expect(localStorage.getItem("theorem-unload:a")).toBeNull();
        expect(localStorage.getItem("theorem-unload:b")).toBeNull();
        expect(localStorage.getItem("theorem-library")).toBe("keep");
        clearUnloadSnapshots();
    });
});
