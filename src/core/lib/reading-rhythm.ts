import type { RhythmState } from "../types";
import { localDateKey } from "./date-keys";
import { isTauri } from "./env";
import { isPersistenceSuspended } from "./persist-storage";
import { useSettingsStore } from "../store";

export interface RhythmProgress {
    state: RhythmState;
    weekStart: string;
    weekEnd: string;
    qualifyingDays: number;
    targetDays: number;
    nextTargetDays: number;
    todaySeconds: number;
    xp: number;
    level: number;
}

type Request = {
    today: string;
    state?: RhythmState;
    incoming?: RhythmState;
    goal?: { days: number; stamp: string; id: string };
    reading?: { date: string; source: string; seconds: number };
    legacyActivity?: { date: string; minutes: number }[];
};
let evaluate: ((request: Request) => RhythmProgress | Promise<RhythmProgress>) | undefined;
let loading: Promise<void> | undefined;
let mutations: Promise<unknown> = Promise.resolve();

/** Native Rust on Tauri; the same rules compile to lazy WASM for browser use. */
export function prepareReadingRhythm(): Promise<void> {
    return loading ??= (async () => {
        if (isTauri()) {
            const { invoke } = await import("@tauri-apps/api/core");
            evaluate = request => invoke<RhythmProgress>("evaluate_reading_rhythm", { request });
        } else {
            const core = await import("./theorem-core");
            if (!await core.initTheoremCoreWasm()) throw new Error("Reading progress is unavailable. Please restart Theorem.");
            evaluate = core.evaluateReadingRhythm;
        }
    })().catch(error => { loading = undefined; throw error; });
}

export async function readingRhythmProgress(): Promise<RhythmProgress> {
    await prepareReadingRhythm();
    const stats = useSettingsStore.getState().stats;
    return evaluate!({ today: localDateKey(), state: stats.rhythm,
        legacyActivity: stats.dailyActivity });
}

function change(updates: Omit<Request, "today" | "state">, apply?: (state: RhythmState) => void): Promise<void> {
    const perform = async () => {
        await prepareReadingRhythm();
        while (true) {
            if (isPersistenceSuspended()) throw new Error("Reading progress is temporarily unavailable");
            const before = useSettingsStore.getState().stats.rhythm;
            const result = await evaluate!({ today: localDateKey(), state: before,
                legacyActivity: useSettingsStore.getState().stats.dailyActivity, ...updates });
            if (isPersistenceSuspended()) throw new Error("Reading progress is temporarily unavailable");
            // A restore or another store writer may run while native IPC is pending.
            if (useSettingsStore.getState().stats.rhythm !== before) continue;
            if (apply) apply(result.state);
            else if (JSON.stringify(result.state) !== JSON.stringify(before)) {
                useSettingsStore.getState().updateStats({ rhythm: result.state });
            }
            return;
        }
    };
    const result = mutations.then(perform);
    mutations = result.catch(() => {});
    return result;
}

export function setWeeklyReadingGoal(days: number): Promise<void> {
    return change({ goal: { days, stamp: new Date().toISOString(), id: crypto.randomUUID() } });
}

function applyPending(id: string, reading: NonNullable<Request["reading"]>): Promise<void> {
    return change({ reading }, state => {
        useSettingsStore.getState().updateStats({ rhythm: state });
        useSettingsStore.setState(current => {
            if (current.rhythmOutbox[id] !== reading) return {};
            const remaining = { ...current.rhythmOutbox };
            delete remaining[id];
            return { rhythmOutbox: remaining };
        });
    });
}

export function recordReadingRhythm(date: string, source: string, seconds: number): Promise<void> {
    if (!useSettingsStore.getState().stats.rhythm) return Promise.resolve();
    const id = `${date}:${source}`;
    const reading = { date, source, seconds };
    // Persist the cumulative counter before IPC, including on reader exit. Replaying
    // it after restart is harmless because Rust merges counters by source maximum.
    useSettingsStore.setState(current => ({ rhythmOutbox: { ...current.rhythmOutbox, [id]: reading } }));
    return applyPending(id, reading);
}

export async function flushReadingRhythmOutbox(): Promise<void> {
    // Persist historical day credit at startup, including existing rhythm profiles.
    await change({});
    for (const [id, reading] of Object.entries(useSettingsStore.getState().rhythmOutbox)) {
        await applyPending(id, reading);
    }
}

/** The callback lets sync apply legacy statistics and the extension together. */
export function mergeReadingRhythm(incoming?: RhythmState, apply?: (state: RhythmState | undefined) => void): Promise<void> {
    if (!incoming) {
        apply?.(useSettingsStore.getState().stats.rhythm);
        return Promise.resolve();
    }
    return change({ incoming }, apply);
}
