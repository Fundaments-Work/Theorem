import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Windows never closed because of a missing ACL permission, not app logic.
 *
 * Tauri's own `WebviewWindow.onCloseRequested` helper calls `this.destroy()`
 * once the handler returns without preventing the close:
 *
 *   async onCloseRequested(handler) {
 *     return this.listen(WINDOW_CLOSE_REQUESTED, async (event) => {
 *       const evt = new CloseRequestedEvent(event);
 *       await handler(evt);
 *       if (!evt.isPreventDefault()) await this.destroy();   // plugin:window|destroy
 *     });
 *   }
 *
 * `core:window:allow-close` alone is not enough: `destroy` is a separate command
 * and was absent from the capability, so the promise rejected with
 * "Command plugin:window|destroy not allowed by ACL" and the window stayed open.
 */
const capability = JSON.parse(
    readFileSync(resolve("src-tauri/capabilities/default.json"), "utf-8"),
) as { permissions: Array<string | { identifier: string }> };

function permissions(): string[] {
    return capability.permissions.map((p) => (typeof p === "string" ? p : p.identifier));
}

describe("window capability", () => {
    it("grants the window commands the close path actually uses", () => {
        const granted = permissions();
        expect(granted).toContain("core:window:allow-close");
        // Tauri's onCloseRequested helper destroys the window after the handler
        // unless it prevents the close; without this the close silently fails.
        expect(granted).toContain("core:window:allow-destroy");
    });

    it("still allows the window controls the reader titlebar draws", () => {
        const granted = permissions();
        expect(granted).toContain("core:window:allow-minimize");
        expect(granted).toContain("core:window:allow-maximize");
        expect(granted).toContain("core:window:allow-unmaximize");
    });

    it("keeps the capability scoped to first-party windows", () => {
        // Reader windows are dynamic labels (reader_<book id>), so the window
        // list must keep covering them.
        expect(capability.windows).toContain("main");
        expect(capability.windows).toContain("reader_*");
    });
});

describe("reader window chrome matches the main window", () => {
    const rust = readFileSync(resolve("src-tauri/src/lib.rs"), "utf-8");

    it("builds reader windows frameless, like the configured main window", () => {
        // decorations(true) stacked the OS title bar above the app's own.
        const config = JSON.parse(
            readFileSync(resolve("src-tauri/tauri.conf.json"), "utf-8"),
        ) as { app: { windows: Array<{ label: string; decorations?: boolean }> } };
        const main = config.app.windows.find((w) => w.label === "main");
        expect(main?.decorations).toBe(false);

        const builder = rust.slice(rust.indexOf("WebviewWindowBuilder::new"));
        expect(builder).toContain(".decorations(false)");
    });

    it("closes reader windows when the main window closes", () => {
        // They are independent webviews, not children of main.
        expect(rust).toContain("fn close_reader_windows");
        expect(rust).toContain('window.label().starts_with(READER_WINDOW_PREFIX)');
    });
});

describe("reader titlebar is draggable", () => {
    const titlebar = readFileSync(
        resolve("src/features/reader/components/WindowTitlebar.tsx"),
        "utf-8",
    );

    it("provides a drag region on the bar itself", () => {
        // A frameless window has no OS drag area, so the bar must supply one.
        expect(titlebar).toMatch(
            /data-tauri-drag-region=\{showDesktopWindowControls \? "true" : undefined\}/,
        );
    });

    it("opts the back button and title out of dragging", () => {
        const optOuts = titlebar.match(/data-tauri-drag-region=\{undefined\}/g) ?? [];
        expect(optOuts.length).toBeGreaterThanOrEqual(2);
    });
});