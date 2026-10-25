// Launches the real Theorem binary under tauri-driver with a throwaway data
// directory, and exposes user-level actions (find by role/label/text, click,
// type, wait). Tests talk to this API only.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { groupMembers, stopGroup, stopGroupSync, waitGroup } from "./procs.mjs";
import { Session } from "./webdriver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "../..");
export const APP_ID = "work.fundamentals.theorem";
const A11Y = readFileSync(join(HERE, "a11y-page.js"), "utf8");
const ARTIFACTS = process.env.THEOREM_E2E_ARTIFACTS || join(REPO, "e2e", ".artifacts");

export const BINARY = process.env.THEOREM_E2E_BINARY || join(REPO, "src-tauri", "target", "debug", "theorem");
const TAURI_DRIVER = process.env.TAURI_DRIVER || "tauri-driver";

export const Keys = { Enter: "", Escape: "", Right: "", Left: "", PageDown: "", Tab: "", Backspace: "" };

function freePort() {
    return new Promise((res, rej) => {
        const srv = createServer();
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address();
            srv.close(() => res(port));
        });
        srv.on("error", rej);
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// tauri-driver runs in a process group of its own, with WebKitWebDriver and the
// app under it, so a spec that crashes still takes all of them down with it.
const liveGroups = new Set();
process.on("exit", () => {
    for (const pgid of liveGroups) stopGroupSync(pgid);
});

/**
 * A sandbox: one fake HOME (so the app's data dir is fresh) and one
 * tauri-driver. Several app launches (restarts) can share it.
 */
export class Sandbox {
    constructor(name) {
        this.name = name;
        this.root = mkdtempSync(join(process.env.THEOREM_E2E_TMP || tmpdir(), `theorem-e2e-${name}-`));
        this.home = join(this.root, "home");
        this.files = join(this.root, "files");
        mkdirSync(this.home, { recursive: true });
        mkdirSync(this.files, { recursive: true });
        this.dialogs = join(this.root, "dialogs");
        mkdirSync(this.dialogs, { recursive: true });
        this.dialogSeq = 0;
        this.env = {
            ...process.env,
            HOME: this.home,
            XDG_DATA_HOME: join(this.home, ".local/share"),
            XDG_CONFIG_HOME: join(this.home, ".config"),
            XDG_CACHE_HOME: join(this.home, ".cache"),
            XDG_STATE_HOME: join(this.home, ".local/state"),
            // Software rendering: stable in headless compositors and CI.
            WEBKIT_DISABLE_COMPOSITING_MODE: "1",
            WEBKIT_DISABLE_DMABUF_RENDERER: "1",
            LIBGL_ALWAYS_SOFTWARE: "1",
            NO_AT_BRIDGE: "1",
            // Answers for native dialogs (e2e builds only, see src-tauri/src/e2e_hooks.rs).
            THEOREM_E2E_DIALOGS: join(this.root, "dialogs"),
        };
        this.driver = null;
        this.app = null;
    }

    /** The app's data directory (Tauri app_data_dir) inside the sandbox. */
    get dataDir() {
        return join(this.env.XDG_DATA_HOME, APP_ID);
    }

    async startDriver() {
        if (this.driver) return;
        const port = await freePort();
        const nativePort = await freePort();
        this.base = `http://127.0.0.1:${port}`;
        const log = join(this.root, "tauri-driver.log");
        const args = ["--port", String(port), "--native-port", String(nativePort)];
        if (process.env.WEBKIT_WEBDRIVER) args.push("--native-driver", process.env.WEBKIT_WEBDRIVER);
        this.driver = spawn(TAURI_DRIVER, args, { env: this.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
        this.driverGroup = this.driver.pid;
        liveGroups.add(this.driverGroup);
        this.driverLog = [];
        this.driver.stdout.on("data", (d) => this.driverLog.push(String(d)));
        this.driver.stderr.on("data", (d) => this.driverLog.push(String(d)));
        this.driverClosed = new Promise((r) => this.driver.once("close", r)).then(() => {
            if (existsSync(this.root)) writeFileSync(log, this.driverLog.join(""));
        });
        for (let i = 0; i < 100; i++) {
            try {
                const r = await fetch(`${this.base}/status`);
                if (r.ok || r.status < 500) return;
            } catch {
                // not up yet
            }
            await sleep(100);
        }
        throw new Error("tauri-driver did not start");
    }

    /** Launch the app. `args` are passed to the binary like "Open with". */
    async launch({ args = [] } = {}) {
        await this.startDriver();
        const session = await Session.create(this.base, {
            "tauri:options": { application: BINARY, args },
            "webkitgtk:browserOptions": { args: [] },
        });
        this.app = new App(session, this);
        await this.app.waitForReady();
        return this.app;
    }

    /**
     * Quit like the tray's "Quit" (e2e builds watch for a `quit` file): every
     * window flushes its pending writes, then the process exits. `{ hard: true }`
     * just ends the process, like a crash or a kill.
     */
    async quit({ hard = false } = {}) {
        if (!this.app) return;
        if (!hard) {
            writeFileSync(join(this.dialogs, "quit"), "");
            // The app exits within its 3 s flush budget; then the session is dead.
            const deadline = Date.now() + 8000;
            while (Date.now() < deadline) {
                try {
                    await this.app.session.title();
                } catch {
                    break;
                }
                await sleep(200);
            }
        }
        await this.app.session.delete().catch(() => {});
        this.app = null;
        await this.waitAppGone();
    }

    /**
     * Wait until the app process has exited. Launching again while it is still
     * shutting down races it: the single-instance plugin finds the old app on
     * the bus and the new one exits.
     */
    async waitAppGone() {
        if (!this.driverGroup) return;
        const isApp = (p) => p.cmd === BINARY;
        if (await waitGroup(this.driverGroup, (m) => !m.some(isApp), 10000)) return;
        for (const p of groupMembers(this.driverGroup).filter(isApp)) {
            try {
                process.kill(p.pid, "SIGKILL");
            } catch {
                // gone
            }
        }
        await waitGroup(this.driverGroup, (m) => !m.some(isApp), 3000);
    }

    /** Remove the app's data (as if freshly installed). The app must be closed. */
    wipeData() {
        rmSync(this.env.XDG_DATA_HOME, { recursive: true, force: true });
        rmSync(this.env.XDG_CONFIG_HOME, { recursive: true, force: true });
        rmSync(this.env.XDG_CACHE_HOME, { recursive: true, force: true });
        rmSync(join(this.home, ".local/state"), { recursive: true, force: true });
    }

    async dispose({ keep = false } = {}) {
        await this.quit();
        if (this.driver) {
            // The driver, WebKitWebDriver, the app and its helpers: stop all of
            // them and wait until they are gone, so the next spec starts clean.
            await stopGroup(this.driverGroup);
            liveGroups.delete(this.driverGroup);
            await Promise.race([this.driverClosed, sleep(3000)]);
            this.driver = null;
            this.driverGroup = null;
        }
        if (!keep && !process.env.THEOREM_E2E_KEEP) rmSync(this.root, { recursive: true, force: true });
    }
}

export class App {
    constructor(session, sandbox) {
        this.session = session;
        this.sandbox = sandbox;
    }

    async waitForReady() {
        await this.waitFor(async () => {
            const state = await this.session.execute("return document.readyState + '|' + (document.body ? document.body.innerText.length : 0)");
            return state.startsWith("complete") && Number(state.split("|")[1]) > 0;
        }, { timeout: 30000, what: "app UI to render" });
    }

    a11y(op, query) {
        return this.session.execute(`${A11Y}\nreturn __a11y(arguments[0], arguments[1]);`, op, serializeQuery(query));
    }

    /** Wait until `fn` returns a truthy value; returns it. */
    async waitFor(fn, { timeout = 10000, interval = 150, what = "condition" } = {}) {
        const start = Date.now();
        let lastError;
        while (Date.now() - start < timeout) {
            try {
                const v = await fn();
                if (v) return v;
            } catch (e) {
                lastError = e;
            }
            await sleep(interval);
        }
        const outline = await this.outline().catch(() => "(no outline)");
        const shot = await this.screenshot(`timeout-${this.sandbox.name}-${Date.now()}`).catch(() => null);
        if (shot) lastError = Object.assign(lastError ?? new Error("condition stayed false"), { message: `${lastError?.message ?? "condition stayed false"}; screenshot: ${shot}` });
        throw new Error(`Timed out after ${timeout} ms waiting for ${what}${lastError ? ` (last error: ${lastError.message})` : ""}\n--- page outline ---\n${outline.slice(0, 6000)}`);
    }

    /** Find one element: {role, name} | {label} | {text}; name/label/text may be a string or RegExp. */
    async find(query, { timeout = 10000 } = {}) {
        return this.waitFor(() => this.a11y("find", query), { timeout, what: describe(query) });
    }

    async findAll(query) {
        return this.a11y("findAll", query);
    }

    async names(query) {
        return this.a11y("names", query);
    }

    /** Current value of a form control (textbox, spinbutton, combobox). */
    async value(query) {
        const el = await this.find(query);
        return this.session.execute("return arguments[0].value", el);
    }

    async exists(query) {
        return Boolean(await this.a11y("find", query));
    }

    async waitGone(query, { timeout = 10000 } = {}) {
        await this.waitFor(async () => !(await this.a11y("find", query)), { timeout, what: `${describe(query)} to disappear` });
    }

    async click(query, opts) {
        const el = await this.find(query, opts);
        await this.session.execute("arguments[0].scrollIntoView({block:'center', inline:'center'})", el);
        try {
            await this.session.click(el);
        } catch (e) {
            // Overlapped by an animating overlay: retry once after it settles.
            if (!/intercepted|not interactable/i.test(e.message)) throw e;
            await sleep(400);
            await this.session.click(el);
        }
        return el;
    }

    async fill(query, text) {
        const el = await this.find(query);
        await this.session.click(el).catch(() => {});
        await this.session.clear(el).catch(() => {});
        await this.session.type(el, text);
        return el;
    }

    /**
     * Book content lives in iframes (possibly inside shadow roots). Returns, per
     * frame, its viewport rectangle and current text selection. Reads only what
     * a user sees: the rendered book and the selection.
     */
    bookFrames() {
        return this.session.execute(`
const out = [];
const walk = (root) => {
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) walk(el.shadowRoot);
    if (el.tagName === 'IFRAME') {
      try {
        const d = el.contentDocument; const r = el.getBoundingClientRect();
        out.push({ x: r.x, y: r.y, width: r.width, height: r.height, selection: d.getSelection().toString() });
      } catch (e) { /* cross-origin frame */ }
    }
  }
};
walk(document);
return out;`);
    }

    /** True when `query` is on screen and would receive a click (not covered or slid away). */
    async isClickable(query) {
        const el = await this.a11y("find", query);
        if (!el) return false;
        return this.session.execute(
            `const el = arguments[0]; const r = el.getBoundingClientRect();
             if (r.bottom <= 0 || r.top >= innerHeight) return false;
             const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
             return !!hit && (el === hit || el.contains(hit)) && getComputedStyle(el).pointerEvents !== 'none';`,
            el,
        );
    }

    /** The reader hides its toolbars while reading; a tap in the middle of the page brings them back. */
    async revealReaderChrome() {
        const back = { role: "button", name: "Back to Library" };
        for (let i = 0; i < 3 && !(await this.isClickable(back)); i++) {
            await this.session.pointer([{ type: "move", x: 640, y: 420 }, { type: "down" }, { type: "up" }]);
            await sleep(700);
        }
        await this.waitFor(() => this.isClickable(back), { what: "reader toolbar" });
    }

    /** Press and drag with the mouse between two viewport points (selects text). */
    async drag(from, to) {
        await this.session.pointer([
            { type: "move", ...from },
            { type: "down" },
            { type: "move", x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, duration: 150 },
            { type: "move", ...to, duration: 150 },
            { type: "up" },
        ]);
    }

    keys(...k) {
        return this.session.keys(...k);
    }

    async text() {
        return this.a11y("text");
    }

    async waitForText(pattern, { timeout = 10000 } = {}) {
        const re = typeof pattern === "string" ? new RegExp(escapeRe(pattern)) : pattern;
        return this.waitFor(async () => re.test(await this.text()), { timeout, what: `text ${re}` });
    }

    async outline() {
        return this.a11y("outline");
    }

    /**
     * Answer the next native dialog of `kind` with `value`:
     * "open" (a path, an array of paths, or null = cancel), "save" (a path or null),
     * "message" (the label of the button to press; unqueued messages press OK/Yes).
     */
    queueDialog(kind, value) {
        const seq = String(++this.sandbox.dialogSeq).padStart(6, "0");
        writeFileSync(join(this.sandbox.dialogs, `${seq}.${kind}.json`), JSON.stringify(value));
    }

    /** Every native dialog the app asked for so far: [{kind, args}]. */
    dialogCalls() {
        const file = join(this.sandbox.dialogs, "calls.jsonl");
        if (!existsSync(file)) return [];
        return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    }

    /** Invoke a backend command the way the UI does (only for setup/inspection, never as the action under test). */
    invoke(cmd, args = {}) {
        return this.session.executeAsync(
            "const done = arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then((v) => done({ok: v}), (e) => done({err: String(e)}));",
            cmd,
            args,
        ).then((r) => {
            if (r && "err" in r) throw new Error(`${cmd}: ${r.err}`);
            return r?.ok;
        });
    }

    async screenshot(name) {
        mkdirSync(ARTIFACTS, { recursive: true });
        const file = join(ARTIFACTS, `${name}.png`);
        writeFileSync(file, await this.session.screenshot());
        return file;
    }
}

function serializeQuery(q) {
    if (!q || typeof q !== "object" || q.ELEMENT || q["element-6066-11e4-a52e-4f735466cecf"]) return q;
    const out = {};
    for (const [k, v] of Object.entries(q)) out[k] = v instanceof RegExp ? { source: v.source, flags: v.flags } : v;
    return out;
}

function describe(q) {
    const parts = Object.entries(q).filter(([k]) => k !== "within").map(([k, v]) => `${k}=${v instanceof RegExp ? v : JSON.stringify(v)}`);
    return `element(${parts.join(", ")})`;
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export { sleep };
