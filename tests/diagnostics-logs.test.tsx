// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
    logError: vi.fn(),
    saveFileAs: vi.fn(),
    isTauri: vi.fn(() => true),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-log", () => ({
    error: mocks.logError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    attachConsole: vi.fn(),
}));
vi.mock("../src/core/lib/env", () => ({
    isTauri: () => mocks.isTauri(),
    isTauriDesktop: () => mocks.isTauri(),
    isTauriMobile: () => false,
    isMobile: () => false,
}));
vi.mock("../src/core/lib/book-export", () => ({ saveFileAs: mocks.saveFileAs }));

import { buildLogExportFilename, exportLogs } from "../src/core/lib/log-export";
import { formatCaughtError, reportCaughtError } from "../src/core/lib/debug";
import { ErrorBoundary } from "../src/shell/ErrorBoundary";
import { RouteErrorBoundary } from "../src/ui/RouteErrorBoundary";

// @ts-expect-error React 19 act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
    vi.resetAllMocks();
    mocks.isTauri.mockReturnValue(true);
    mocks.logError.mockResolvedValue(undefined);
});

describe("buildLogExportFilename", () => {
    it("names the bundle by local date and time, zero padded", () => {
        expect(buildLogExportFilename(new Date(2026, 0, 2, 3, 4))).toBe("theorem-logs-2026-01-02-0304.zip");
        expect(buildLogExportFilename(new Date(2026, 11, 31, 23, 59))).toBe("theorem-logs-2026-12-31-2359.zip");
    });
});

describe("exportLogs", () => {
    it("saves the zip the native side built", async () => {
        const bytes = new Uint8Array([0x50, 0x4b, 3, 4]);
        mocks.invoke.mockResolvedValue(bytes.buffer);
        mocks.saveFileAs.mockResolvedValue({ ok: true, message: "Saved" });

        const result = await exportLogs(new Date(2026, 9, 22, 9, 5));

        expect(result).toEqual({ ok: true, message: "Saved" });
        expect(mocks.invoke).toHaveBeenCalledWith("export_logs_bundle");
        const [filename, blob] = mocks.saveFileAs.mock.calls[0];
        expect(filename).toBe("theorem-logs-2026-10-22-0905.zip");
        expect(blob).toBeInstanceOf(Blob);
        expect((blob as Blob).type).toBe("application/zip");
        expect(new Uint8Array(await (blob as Blob).arrayBuffer())).toEqual(bytes);
    });

    it("explains that the browser build has no log files", async () => {
        mocks.isTauri.mockReturnValue(false);
        const result = await exportLogs();
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/desktop and Android/);
        expect(mocks.invoke).not.toHaveBeenCalled();
        expect(mocks.saveFileAs).not.toHaveBeenCalled();
    });

    it("reports a native failure instead of throwing", async () => {
        mocks.invoke.mockRejectedValue("Could not find the log folder");
        const result = await exportLogs();
        expect(result).toEqual({ ok: false, message: "Could not find the log folder" });
        expect(mocks.saveFileAs).not.toHaveBeenCalled();
    });

    it("rejects an empty bundle", async () => {
        mocks.invoke.mockResolvedValue(new ArrayBuffer(0));
        const result = await exportLogs();
        expect(result.ok).toBe(false);
        expect(mocks.saveFileAs).not.toHaveBeenCalled();
    });
});

describe("reportCaughtError", () => {
    it("formats scope, message, stack and component stack", () => {
        const err = new TypeError("boom");
        err.stack = "TypeError: boom\n    at render (app.js:1:2)";
        const text = formatCaughtError("Route", err, "\n    in Library\n    in App");
        expect(text).toContain("[Route] TypeError: boom");
        expect(text).toContain("at render (app.js:1:2)");
        expect(text).toContain("Component stack:");
        expect(text).toContain("in Library");
    });

    it("handles thrown non-Error values and missing stacks", () => {
        expect(formatCaughtError("App", "plain string", null)).toBe("[App] plain string");
        expect(formatCaughtError("App", undefined)).toBe("[App] undefined");
        expect(formatCaughtError("App", { code: 7 })).toBe("[App] [object Object]");
    });

    it("caps very long reports", () => {
        const err = new Error("x".repeat(20_000));
        err.stack = undefined;
        const text = formatCaughtError("App", err);
        expect(text.length).toBeLessThanOrEqual(8_100);
        expect(text.endsWith("[truncated]")).toBe(true);
    });

    it("writes the report to the native log", async () => {
        await reportCaughtError("App", new Error("kaput"));
        expect(mocks.logError).toHaveBeenCalledTimes(1);
        expect(mocks.logError.mock.calls[0][0]).toContain("[App] Error: kaput");
    });

    it("never throws when the log plugin fails", async () => {
        mocks.logError.mockRejectedValue(new Error("ipc down"));
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        await expect(reportCaughtError("App", new Error("kaput"))).resolves.toBeUndefined();
        spy.mockRestore();
    });
});

describe("error boundaries log what they catch", () => {
    let container: HTMLDivElement;
    let root: Root;
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        consoleSpy.mockRestore();
    });

    function Thrower({ message }: { message: string }): React.ReactElement {
        throw new Error(message);
    }

    it("ErrorBoundary", async () => {
        await act(async () => {
            root.render(<ErrorBoundary><Thrower message="app crash" /></ErrorBoundary>);
        });
        await vi.waitFor(() => expect(mocks.logError).toHaveBeenCalled());
        const report = mocks.logError.mock.calls[0][0] as string;
        expect(report).toContain("[ErrorBoundary] Error: app crash");
        expect(report).toContain("Component stack:");
        expect(container.textContent).toContain("Application Error");
    });

    it("RouteErrorBoundary", async () => {
        await act(async () => {
            root.render(<RouteErrorBoundary><Thrower message="page crash" /></RouteErrorBoundary>);
        });
        await vi.waitFor(() => expect(mocks.logError).toHaveBeenCalled());
        expect(mocks.logError.mock.calls[0][0]).toContain("[RouteErrorBoundary] Error: page crash");
        expect(container.textContent).toContain("This page encountered an error");
    });
});
