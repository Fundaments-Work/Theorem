// Minimal W3C WebDriver client (no dependencies). Enough for tauri-driver +
// WebKitWebDriver: sessions, script execution, element clicks and keys.

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

export class WebDriverError extends Error {
    constructor(method, path, status, body) {
        super(`${method} ${path} -> ${status}: ${body?.value?.error ?? ""} ${body?.value?.message ?? JSON.stringify(body)}`);
        this.code = body?.value?.error;
    }
}

export class Session {
    constructor(base, id) {
        this.base = base;
        this.id = id;
    }

    static async create(base, capabilities) {
        const res = await request(base, "POST", "/session", { capabilities: { alwaysMatch: capabilities } });
        return new Session(base, res.sessionId);
    }

    cmd(method, path, body) {
        return request(this.base, method, `/session/${this.id}${path}`, body);
    }

    async delete() {
        try {
            await this.cmd("DELETE", "");
        } catch {
            // The app may already be gone.
        }
    }

    /** Run a function body in the page. `args` may contain element references. */
    execute(script, ...args) {
        return this.cmd("POST", "/execute/sync", { script, args: args.map(wrapArg) });
    }

    executeAsync(script, ...args) {
        return this.cmd("POST", "/execute/async", { script, args: args.map(wrapArg) });
    }

    async click(el) {
        await this.cmd("POST", `/element/${elementId(el)}/click`, {});
    }

    async type(el, text) {
        // WebKit's element send-keys path can lose the Shift modifier on
        // uppercase letters under the headless compositor. Send those with an
        // explicit modifier so the typed value matches the requested text.
        for (const part of text.split(/([A-Z])/).filter(Boolean)) {
            if (!/^[A-Z]$/.test(part)) {
                await this.cmd("POST", `/element/${elementId(el)}/value`, { text: part });
                continue;
            }
            const value = part.toLowerCase();
            await this.cmd("POST", "/actions", { actions: [{ type: "key", id: "kbd", actions: [
                { type: "keyDown", value: "\uE008" },
                { type: "keyDown", value }, { type: "keyUp", value },
                { type: "keyUp", value: "\uE008" },
            ] }] });
            await this.cmd("DELETE", "/actions");
        }
    }

    async clear(el) {
        await this.cmd("POST", `/element/${elementId(el)}/clear`, {});
    }

    /** Send keys to whatever has focus (W3C actions). Keys: "" Enter, "" Right, "" Left, "" Escape. */
    async keys(...keys) {
        const actions = [];
        for (const k of keys) {
            actions.push({ type: "keyDown", value: k }, { type: "keyUp", value: k });
        }
        await this.cmd("POST", "/actions", { actions: [{ type: "key", id: "kbd", actions }] });
        await this.cmd("DELETE", "/actions").catch(() => {});
    }

    /** Pointer actions in viewport coordinates: [{type:"move",x,y}|{type:"down"}|{type:"up"}|{type:"pause",ms}]. */
    async pointer(steps) {
        const actions = steps.map((s) => {
            if (s.type === "move") return { type: "pointerMove", origin: "viewport", x: Math.round(s.x), y: Math.round(s.y), duration: s.duration ?? 50 };
            if (s.type === "down") return { type: "pointerDown", button: s.button ?? 0 };
            if (s.type === "up") return { type: "pointerUp", button: s.button ?? 0 };
            return { type: "pause", duration: s.ms ?? 50 };
        });
        await this.cmd("POST", "/actions", { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }] });
        await this.cmd("DELETE", "/actions").catch(() => {});
    }

    async screenshot() {
        return Buffer.from(await this.cmd("GET", "/screenshot"), "base64");
    }

    title() {
        return this.cmd("GET", "/title");
    }
}

function wrapArg(arg) {
    return arg;
}

export function elementId(el) {
    if (!el) throw new Error("No element");
    return el[ELEMENT_KEY] ?? el.ELEMENT;
}

async function request(base, method, path, body) {
    const res = await fetch(base + path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
        json = text ? JSON.parse(text) : {};
    } catch {
        json = { value: { message: text } };
    }
    if (!res.ok || (json.value && json.value.error)) {
        throw new WebDriverError(method, path, res.status, json);
    }
    return json.value;
}
