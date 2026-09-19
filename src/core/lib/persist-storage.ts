import type { StateStorage } from 'zustand/middleware';
import { isTauri } from './env';
import { sqliteDeleteKv, sqliteGetKv, sqliteSetKv } from './sqlite-storage';

const SQLITE_PERSIST_KEY_PREFIX = 'zustand:';
const PERSIST_WRITE_DEBOUNCE_MS = 350;

const inMemoryPersistCache = new Map<string, string | null>();
const pendingPersistWrites = new Map<string, string>();
const pendingPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();
let flushHandlersInstalled = false;
const PERSIST_CACHE_MAX_ENTRY_CHARS = 500_000;

function setPersistCacheEntry(name: string, value: string | null): void {
    if (value && value.length > PERSIST_CACHE_MAX_ENTRY_CHARS) return;
    inMemoryPersistCache.set(name, value);
}

function asSqlitePersistKey(name: string): string {
    return `${SQLITE_PERSIST_KEY_PREFIX}${name}`;
}

function getLocalItem(name: string): string | null {
    if (typeof localStorage === 'undefined') {
        return null;
    }
    return localStorage.getItem(name);
}

function setLocalItem(name: string, value: string): void {
    if (typeof localStorage === 'undefined') {
        return;
    }
    localStorage.setItem(name, value);
}

function removeLocalItem(name: string): void {
    if (typeof localStorage === 'undefined') {
        return;
    }
    localStorage.removeItem(name);
}

function clearPendingPersistWrite(name: string): void {
    const timer = pendingPersistTimers.get(name);
    if (timer) {
        clearTimeout(timer);
        pendingPersistTimers.delete(name);
    }
    pendingPersistWrites.delete(name);
}

async function flushPersistWrite(name: string): Promise<void> {
    const pendingValue = pendingPersistWrites.get(name);
    if (pendingValue == null) {
        return;
    }

    clearPendingPersistWrite(name);

    if (!isTauri()) {
        setLocalItem(name, pendingValue);
        return;
    }

    const sqliteKey = asSqlitePersistKey(name);

    try {
        await sqliteSetKv(sqliteKey, pendingValue);
        removeLocalItem(name);
    } catch (error) {
        setLocalItem(name, pendingValue);
    }
}

async function flushAllPersistWrites(): Promise<void> {
    const names = [...pendingPersistWrites.keys()];
    if (names.length === 0) {
        return;
    }
    await Promise.allSettled(names.map((name) => flushPersistWrite(name)));
}

function schedulePersistWrite(name: string, value: string): void {
    pendingPersistWrites.set(name, value);

    const existingTimer = pendingPersistTimers.get(name);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
        pendingPersistTimers.delete(name);
        void flushPersistWrite(name);
    }, PERSIST_WRITE_DEBOUNCE_MS);
    pendingPersistTimers.set(name, timer);
}

function installFlushHandlers(): void {
    if (flushHandlersInstalled || typeof window === 'undefined') {
        return;
    }

    window.addEventListener('visibilitychange', () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            void flushAllPersistWrites();
            void flushDeferredPersistWrites(false);
        }
    });

    window.addEventListener('beforeunload', () => {
        for (const [name, value] of pendingPersistWrites.entries()) {
            setLocalItem(name, value);
        }
        flushDeferredPersistWrites(true);
    });

    flushHandlersInstalled = true;
}

export const theoremPersistStorage: StateStorage = {    async getItem(name) {
        installFlushHandlers();

        const pendingValue = pendingPersistWrites.get(name);
        if (pendingValue != null) {
            return pendingValue;
        }

        if (inMemoryPersistCache.has(name)) {
            return inMemoryPersistCache.get(name) ?? null;
        }

        if (!isTauri()) {
            const localValue = getLocalItem(name);
            setPersistCacheEntry(name, localValue);
            return localValue;
        }

        const sqliteKey = asSqlitePersistKey(name);

        try {
            const sqliteValue = await sqliteGetKv(sqliteKey);
            if (sqliteValue != null) {
                setPersistCacheEntry(name, sqliteValue);
                return sqliteValue;
            }

            const legacyValue = getLocalItem(name);
            if (legacyValue != null) {
                setPersistCacheEntry(name, legacyValue);
                await sqliteSetKv(sqliteKey, legacyValue);
                return legacyValue;
            }

            setPersistCacheEntry(name, null);
            return null;
        } catch (error) {
            const fallbackValue = getLocalItem(name);
            setPersistCacheEntry(name, fallbackValue);
            return fallbackValue;
        }
    },

    async setItem(name, value) {
        installFlushHandlers();
        setPersistCacheEntry(name, value);
        schedulePersistWrite(name, value);
    },

    async removeItem(name) {
        installFlushHandlers();
        clearPendingPersistWrite(name);
        inMemoryPersistCache.delete(name);

        if (!isTauri()) {
            removeLocalItem(name);
            return;
        }

        const sqliteKey = asSqlitePersistKey(name);

        try {
            await sqliteDeleteKv(sqliteKey);
        } catch (error) {
        }

        removeLocalItem(name);
    },
};

// ─── Deferred JSON adapter ──────────────────────────────────────────────
// zustand v5 persist runs partialize + JSON.stringify synchronously inside
// every set() — the 350ms debounce in theoremPersistStorage only defers the
// storage write, not the main-thread serialization. This adapter receives
// the partialized { state, version } object, coalesces bursts on a trailing
// timer, and moves JSON.stringify into an idle callback, so a set() costs
// O(slices) identity checks (+ O(n) light allocs only when a persisted
// slice actually changed) instead of O(n) string building every time.
// Crash-consistency is preserved: pending values flush on tab hide and
// synchronously on page unload, mirroring the string-storage behavior.

interface DeferredPersistValue {
    state: unknown;
    version?: number;
}

const pendingDeferredWrites = new Map<string, DeferredPersistValue>();
const pendingDeferredTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleIdleFlush(task: () => void): void {
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(() => task(), { timeout: 1000 });
    } else {
        setTimeout(task, 0);
    }
}

async function flushDeferredWrite(name: string): Promise<void> {
    const pending = pendingDeferredWrites.get(name);
    if (pending == null) {
        return;
    }
    pendingDeferredWrites.delete(name);
    const timer = pendingDeferredTimers.get(name);
    if (timer) {
        clearTimeout(timer);
        pendingDeferredTimers.delete(name);
    }
    try {
        const json = JSON.stringify(pending);
        await theoremPersistStorage.setItem(name, json);
    } catch {
        // Best-effort background persistence; next flush retries.
    }
}

function flushDeferredWriteSync(name: string): void {
    const pending = pendingDeferredWrites.get(name);
    if (pending == null) {
        return;
    }
    pendingDeferredWrites.delete(name);
    const timer = pendingDeferredTimers.get(name);
    if (timer) {
        clearTimeout(timer);
        pendingDeferredTimers.delete(name);
    }
    try {
        setLocalItem(name, JSON.stringify(pending));
    } catch {
        // Unload path: nothing left to try.
    }
}

export function flushDeferredPersistWrites(sync: boolean): void {
    const names = [...pendingDeferredWrites.keys()];
    if (sync) {
        for (const name of names) flushDeferredWriteSync(name);
        return;
    }
    void Promise.allSettled(names.map((name) => flushDeferredWrite(name)));
}

function scheduleDeferredWrite(name: string, value: DeferredPersistValue): void {
    const existing = pendingDeferredWrites.get(name);
    if (existing && existing.state === value.state && existing.version === value.version) {
        return;
    }
    pendingDeferredWrites.set(name, value);

    if (pendingDeferredTimers.has(name)) {
        return;
    }
    const timer = setTimeout(() => {
        pendingDeferredTimers.delete(name);
        scheduleIdleFlush(() => {
            void flushDeferredWrite(name);
        });
    }, PERSIST_WRITE_DEBOUNCE_MS);
    pendingDeferredTimers.set(name, timer);
}

export const deferredJsonStorage = {
    async getItem(name: string): Promise<DeferredPersistValue | null> {
        const pending = pendingDeferredWrites.get(name);
        if (pending != null) {
            return pending;
        }
        const raw = await theoremPersistStorage.getItem(name);
        if (raw == null) return null;
        try {
            return JSON.parse(raw) as DeferredPersistValue;
        } catch {
            return null;
        }
    },
    setItem(name: string, value: DeferredPersistValue): Promise<void> {
        installFlushHandlers();
        scheduleDeferredWrite(name, value);
        return Promise.resolve();
    },
    async removeItem(name: string): Promise<void> {
        pendingDeferredWrites.delete(name);
        const timer = pendingDeferredTimers.get(name);
        if (timer) {
            clearTimeout(timer);
            pendingDeferredTimers.delete(name);
        }
        await theoremPersistStorage.removeItem(name);
    },
};

// Memoized partialize: rebuild the persisted shape only when one of the
// selected slices changed identity. Unrelated sets hit the O(slices) fast
// path and reuse the previous result object, which also lets the deferred
// adapter skip rescheduling via the state-identity check above.
export function memoizePartialize<S, P>(
    selectSlices: (state: S) => unknown[],
    build: (state: S) => P,
): (state: S) => P {
    let lastSlices: unknown[] | null = null;
    let lastResult: P | null = null;
    return (state: S): P => {
        const slices = selectSlices(state);
        if (
            lastSlices !== null
            && lastResult !== null
            && slices.length === lastSlices.length
            && slices.every((slice, index) => slice === lastSlices![index])
        ) {
            return lastResult;
        }
        lastSlices = slices;
        lastResult = build(state);
        return lastResult;
    };
}
