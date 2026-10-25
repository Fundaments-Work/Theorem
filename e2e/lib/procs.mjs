// Process-group helpers (Linux /proc) so teardown can wait until every process
// a run started is really gone. A run that returned while the previous app,
// WebKitWebDriver or compositor was still shutting down left the next launch
// racing it (the single-instance plugin finds the old app on the shared bus).

import { readdirSync, readFileSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Live (non-zombie) processes in process group `pgid`: [{ pid, cmd }]. */
export function groupMembers(pgid) {
    const out = [];
    let entries;
    try {
        entries = readdirSync("/proc");
    } catch {
        return out;
    }
    for (const name of entries) {
        if (!/^\d+$/.test(name)) continue;
        try {
            const stat = readFileSync(`/proc/${name}/stat`, "utf8");
            // "pid (comm) state ppid pgrp ..."; comm may contain spaces/parens.
            const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            const state = rest[0];
            const pgrp = Number(rest[2]);
            if (pgrp !== pgid || state === "Z" || state === "X") continue;
            const cmd = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0")[0];
            out.push({ pid: Number(name), cmd });
        } catch {
            // exited while we looked
        }
    }
    return out;
}

export function signalGroup(pgid, signal) {
    try {
        process.kill(-pgid, signal);
    } catch {
        // group already gone
    }
}

/** Wait until `pred(groupMembers(pgid))` is true; returns whether it became true in time. */
export async function waitGroup(pgid, pred, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (pred(groupMembers(pgid))) return true;
        await sleep(100);
    }
    return pred(groupMembers(pgid));
}

/** SIGTERM the group, wait for it to empty, then SIGKILL whatever is left. */
export async function stopGroup(pgid, { timeout = 8000 } = {}) {
    signalGroup(pgid, "SIGTERM");
    if (await waitGroup(pgid, (m) => m.length === 0, timeout)) return true;
    signalGroup(pgid, "SIGKILL");
    return waitGroup(pgid, (m) => m.length === 0, 3000);
}

/** Synchronous variant for `process.on("exit")`, where nothing async runs. */
export function stopGroupSync(pgid, timeout = 5000) {
    const pause = new Int32Array(new SharedArrayBuffer(4));
    signalGroup(pgid, "SIGTERM");
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline && groupMembers(pgid).length > 0) Atomics.wait(pause, 0, 0, 100);
    if (groupMembers(pgid).length > 0) {
        signalGroup(pgid, "SIGKILL");
        const end = Date.now() + 2000;
        while (Date.now() < end && groupMembers(pgid).length > 0) Atomics.wait(pause, 0, 0, 50);
    }
    return groupMembers(pgid).length === 0;
}
