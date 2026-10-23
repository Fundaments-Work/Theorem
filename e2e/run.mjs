#!/usr/bin/env node
// Entry point for `pnpm e2e`.
//
//   pnpm e2e                 run every spec in e2e/specs
//   pnpm e2e --build         build the UI and the e2e binary first
//   pnpm e2e library         run specs whose file name contains "library"
//
// Isolation: the app runs on a private D-Bus session bus (so the single-instance
// plugin cannot find, or forward to, a Theorem the user has open) and on a
// private headless display (mutter --headless, or Xvfb when mutter is missing),
// with HOME and XDG_* pointing into a temporary directory per spec.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BINARY, REPO } from "./lib/app.mjs";

const argv = process.argv.slice(2);
const build = argv.includes("--build");
const filters = argv.filter((a) => !a.startsWith("--"));
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function which(cmd) {
    return spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).stdout.trim() || null;
}

function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { stdio: "inherit", cwd: REPO, ...opts });
    if (r.status !== 0) {
        console.error(`e2e: ${cmd} ${args.join(" ")} failed`);
        process.exit(r.status ?? 1);
    }
}

function cleanup() {
    for (const c of children.reverse()) {
        try {
            c.kill("SIGTERM");
        } catch {
            // already gone
        }
    }
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

if (build) {
    run("pnpm", ["exec", "vite", "build"]);
    run("cargo", ["build", "--features", "e2e"], { cwd: join(REPO, "src-tauri") });
}

const cargoDriver = join(process.env.HOME || "", ".cargo", "bin", "tauri-driver");
process.env.TAURI_DRIVER ||= which("tauri-driver") || (existsSync(cargoDriver) ? cargoDriver : "");
for (const [tool, hint] of [
    ["tauri-driver", "cargo install tauri-driver --locked"],
    ["WebKitWebDriver", "install webkit2gtk-driver (Debian/Ubuntu) or webkit2gtk-4.1 (Arch)"],
    ["dbus-daemon", "install dbus"],
]) {
    if (tool === "tauri-driver" ? !process.env.TAURI_DRIVER : !which(tool)) {
        console.error(`e2e: ${tool} not found (${hint})`);
        process.exit(1);
    }
}
if (!existsSync(BINARY)) {
    console.error(`e2e: ${BINARY} missing. Run \`pnpm e2e --build\` (cargo build --features e2e).`);
    process.exit(1);
}

// Short paths: Wayland socket paths are limited to 108 bytes.
const runtime = mkdtempSync(join("/tmp", "te2e-"));
process.on("exit", () => rmSync(runtime, { recursive: true, force: true }));

const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
delete env.DISPLAY;
delete env.WAYLAND_DISPLAY;
delete env.DBUS_SESSION_BUS_ADDRESS;

// 1. Private session bus.
const busAddress = `unix:path=${join(runtime, "bus")}`;
// No service directories: nothing (document portal, gvfs) gets auto-started on
// this bus, so nothing outlives the run or mounts FUSE inside the runtime dir.
const busConfig = join(runtime, "bus.conf");
writeFileSync(
    busConfig,
    `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>${busAddress}</listen><auth>EXTERNAL</auth>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>`,
);
const dbus = spawn("dbus-daemon", [`--config-file=${busConfig}`, "--nofork"], { env, stdio: "ignore", detached: true });
children.push(dbus);
env.DBUS_SESSION_BUS_ADDRESS = busAddress;
for (let i = 0; i < 50 && !existsSync(join(runtime, "bus")); i++) await sleep(50);

// 2. Private headless display.
const display = process.env.THEOREM_E2E_DISPLAY || (which("mutter") ? "mutter" : which("Xvfb") ? "xvfb" : null);
if (display === "mutter") {
    const m = spawn("mutter", ["--headless", "--wayland", "--no-x11", "--wayland-display", "e2e-0", "--virtual-monitor", "1280x800"], {
        env,
        stdio: "ignore", detached: true,
    });
    children.push(m);
    env.WAYLAND_DISPLAY = "e2e-0";
    env.GDK_BACKEND = "wayland";
    for (let i = 0; i < 100 && !existsSync(join(runtime, "e2e-0")); i++) await sleep(100);
    if (!existsSync(join(runtime, "e2e-0"))) {
        console.error("e2e: headless mutter did not start");
        process.exit(1);
    }
} else if (display === "xvfb") {
    const num = 90 + Math.floor(Math.random() * 400);
    const x = spawn("Xvfb", [`:${num}`, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { env, stdio: "ignore", detached: true });
    children.push(x);
    env.DISPLAY = `:${num}`;
    env.GDK_BACKEND = "x11";
    await sleep(1000);
} else {
    console.error("e2e: need mutter or Xvfb for a private headless display");
    process.exit(1);
}

if (argv.includes("--explore")) {
    const r = spawnSync(process.execPath, [join(REPO, "e2e", process.env.E2E_SCRIPT || "explore.mjs"), ...filters], { env: { ...env, THEOREM_E2E_TMP: tmpdir() }, stdio: "inherit" });
    process.exit(r.status ?? 1);
}

// 3. Specs, one at a time (each launches its own app).
const specDir = join(REPO, "e2e", "specs");
const specs = readdirSync(specDir)
    .filter((f) => f.endsWith(".test.mjs"))
    .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
    .sort()
    .map((f) => join(specDir, f));
const started = Date.now();
const res = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=spec", ...specs], {
    env: { ...env, THEOREM_E2E_TMP: tmpdir() },
    stdio: "inherit",
    cwd: REPO,
});
console.log(`e2e: finished in ${((Date.now() - started) / 1000).toFixed(1)} s`);
// Detached helpers (bus, display) keep the event loop alive: exit explicitly.
process.exit(res.status ?? 1);
