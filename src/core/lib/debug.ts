/**
 * Structured logging via tauri-plugin-log.
 * In browser-only mode, falls back to console methods.
 * Guards debug/trace behind `import.meta.env.DEV`.
 */

import { isTauri } from "./env";

type LogFn = (message: string) => Promise<void>;

let _trace: LogFn | undefined;
let _debug: LogFn | undefined;
let _info: LogFn | undefined;
let _warn: LogFn | undefined;
let _error: LogFn | undefined;
let _attachConsole: (() => Promise<() => void>) | undefined;

async function ensureLoggers() {
    if (_info) return;
    if (!isTauri()) return;
    try {
        const mod = await import("@tauri-apps/plugin-log");
        _trace = mod.trace;
        _debug = mod.debug;
        _info = mod.info;
        _warn = mod.warn;
        _error = mod.error;
        _attachConsole = mod.attachConsole;
    } catch {
        /* plugin not available */
    }
}

let initialized = false;

export async function initLogger() {
    if (initialized) return;
    initialized = true;
    await ensureLoggers();
    if (_attachConsole && isTauri()) {
        try {
            await _attachConsole();
        } catch {
            /* ignore */
        }
    }
    if (import.meta.env.DEV) {
        logInfo("[logger] initialized");
    }
}

export async function logTrace(message: string) {
    if (!import.meta.env.DEV) return;
    if (_trace) {
        await _trace(message);
    } else {
        console.log("[trace]", message);
    }
}

export async function logDebug(message: string) {
    if (!import.meta.env.DEV) return;
    if (_debug) {
        await _debug(message);
    } else {
        console.debug("[debug]", message);
    }
}

export async function logInfo(message: string) {
    if (_info) {
        await _info(message);
    } else {
        console.info("[info]", message);
    }
}

export async function logWarn(message: string) {
    if (_warn) {
        await _warn(message);
    } else {
        console.warn("[warn]", message);
    }
}

export async function logError(message: string) {
    if (_error) {
        await _error(message);
    } else {
        console.error("[error]", message);
    }
}

/** Longest crash report written to the log; stacks can be huge. */
const MAX_CAUGHT_ERROR_CHARS = 8_000;

/**
 * One log entry for an error a React error boundary caught: where, what,
 * the JS stack and the component stack. Only the error itself is recorded,
 * never app state.
 */
export function formatCaughtError(scope: string, error: unknown, componentStack?: string | null): string {
    let text: string;
    if (error instanceof Error) {
        text = `[${scope}] ${error.name}: ${error.message}`;
        if (error.stack) {
            // V8 stacks repeat "Name: message" as their first line.
            const frames = error.stack.startsWith(`${error.name}: ${error.message}`)
                ? error.stack.slice(`${error.name}: ${error.message}`.length)
                : `\n${error.stack}`;
            text += frames;
        }
    } else {
        text = `[${scope}] ${String(error)}`;
    }
    if (componentStack && componentStack.trim()) {
        text += `\nComponent stack:${componentStack}`;
    }
    if (text.length > MAX_CAUGHT_ERROR_CHARS) {
        text = `${text.slice(0, MAX_CAUGHT_ERROR_CHARS)}… [truncated]`;
    }
    return text;
}

/**
 * Writes an error caught by an error boundary to the native log file, so it
 * is in "Export logs". Never throws: a failing logger must not break the
 * fallback UI.
 */
export async function reportCaughtError(scope: string, error: unknown, componentStack?: string | null): Promise<void> {
    const message = formatCaughtError(scope, error, componentStack);
    try {
        await ensureLoggers();
        if (_error) {
            await _error(message);
            return;
        }
    } catch {
        /* fall through to the console */
    }
    console.error(message);
}
