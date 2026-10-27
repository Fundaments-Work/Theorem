// Runs inside the page (injected per call). Finds elements the way a user or a
// screen reader would: by ARIA role + accessible name, by label, by visible
// text. It reads only the standard DOM/ARIA surface, so tests written against
// it survive a change of UI framework.
//
// Entry: __a11y(op, query) where op is "find" | "findAll" | "outline" | "text".
/* eslint-disable */
function __a11y(op, query, withinElement) {
    const IMPLICIT = (el) => {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute("type") || "").toLowerCase();
        switch (tag) {
            case "button": case "summary": return "button";
            case "a": return el.hasAttribute("href") ? "link" : null;
            case "textarea": return "textbox";
            case "select": return el.multiple ? "listbox" : "combobox";
            case "option": return "option";
            case "dialog": return "dialog";
            case "nav": return "navigation";
            case "main": return "main";
            case "aside": return "complementary";
            case "ul": case "ol": return "list";
            case "li": return "listitem";
            case "img": return el.getAttribute("alt") === "" ? "presentation" : "img";
            case "progress": return "progressbar";
            case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "heading";
            case "input":
                if (["button", "submit", "reset", "image"].includes(type)) return "button";
                if (type === "checkbox") return "checkbox";
                if (type === "radio") return "radio";
                if (type === "range") return "slider";
                if (type === "search") return "searchbox";
                if (type === "number") return "spinbutton";
                if (type === "hidden" || type === "file") return null;
                return "textbox";
        }
        return null;
    };
    const roleOf = (el) => {
        const explicit = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
        return explicit || IMPLICIT(el);
    };
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const textOf = (el) => {
        // Visible text, skipping aria-hidden subtrees.
        let out = "";
        for (const node of el.childNodes) {
            if (node.nodeType === 3) out += node.textContent;
            else if (node.nodeType === 1) {
                if (node.getAttribute("aria-hidden") === "true") continue;
                const tag = node.tagName.toLowerCase();
                if (tag === "script" || tag === "style") continue;
                if (tag === "img") out += " " + (node.getAttribute("alt") || "") + " ";
                else out += " " + (node.getAttribute("aria-label") || textOf(node)) + " ";
            }
        }
        return out;
    };
    const NAME_FROM_CONTENT = new Set(["button", "link", "heading", "menuitem", "menuitemcheckbox", "menuitemradio",
        "tab", "option", "checkbox", "radio", "switch", "listitem", "cell", "gridcell", "row", "treeitem", "tooltip", "label"]);
    const nameOf = (el) => {
        const labelledby = el.getAttribute("aria-labelledby");
        if (labelledby) {
            const t = labelledby.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => textOf(n)).join(" ");
            if (clean(t)) return clean(t);
        }
        const aria = el.getAttribute("aria-label");
        if (clean(aria)) return clean(aria);
        const tag = el.tagName.toLowerCase();
        if (["input", "textarea", "select"].includes(tag)) {
            if (el.id) {
                const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                if (lab && clean(textOf(lab))) return clean(textOf(lab));
            }
            const wrap = el.closest("label");
            if (wrap && clean(textOf(wrap))) return clean(textOf(wrap));
            if (["button", "submit"].includes(el.type) && el.value) return clean(el.value);
            if (clean(el.getAttribute("placeholder"))) return clean(el.getAttribute("placeholder"));
        }
        if (tag === "img") return clean(el.getAttribute("alt"));
        const role = roleOf(el);
        if (!role || NAME_FROM_CONTENT.has(role)) {
            const t = clean(textOf(el));
            if (t) return t;
        }
        return clean(el.getAttribute("title"));
    };
    const visible = (el) => {
        if (!el.isConnected) return false;
        if (el.closest("[aria-hidden='true'], [inert]")) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== "hidden" && cs.display !== "none";
    };
    const matches = (value, pattern) => {
        if (pattern === undefined || pattern === null) return true;
        if (typeof pattern === "string") return clean(value) === clean(pattern);
        return new RegExp(pattern.source, pattern.flags).test(clean(value));
    };
    const scopeOf = (q) => {
        const scope = withinElement || q.within;
        if (scope && typeof scope.querySelectorAll === "function") return scope;
        return document;
    };
    const candidates = (q) => {
        const scope = scopeOf(q);
        const all = Array.from(scope.querySelectorAll("*"));
        const out = [];
        for (const el of all) {
            if (!q.includeHidden && !visible(el)) continue;
            if (q.role) {
                const roles = Array.isArray(q.role) ? q.role : [q.role];
                if (!roles.includes(roleOf(el))) continue;
                if (!matches(nameOf(el), q.name)) continue;
            } else if (q.label !== undefined) {
                if (!["input", "textarea", "select"].includes(el.tagName.toLowerCase()) && !el.getAttribute("role")) continue;
                if (!matches(nameOf(el), q.label)) continue;
            } else if (q.text !== undefined) {
                if (!matches(textOf(el), q.text)) continue;
                // Keep the innermost element carrying the text.
                if (Array.from(el.children).some((c) => matches(textOf(c), q.text))) continue;
            } else continue;
            if (q.checked !== undefined) {
                const c = el.getAttribute("aria-checked") ?? el.getAttribute("aria-pressed") ?? el.getAttribute("aria-selected") ?? (el.checked ? "true" : "false");
                if (String(c) !== String(q.checked)) continue;
            }
            out.push(el);
        }
        return out;
    };
    if (op === "find") return candidates(query)[query.index || 0] || null;
    if (op === "findAll") return candidates(query);
    if (op === "names") return candidates(query).map((el) => nameOf(el));
    if (op === "outline") {
        const lines = [];
        for (const el of document.querySelectorAll("*")) {
            const role = roleOf(el);
            if (!role || ["presentation", "none", "generic", "list", "listitem"].includes(role)) continue;
            if (!visible(el)) continue;
            const name = nameOf(el).slice(0, 80);
            const state = ["aria-checked", "aria-pressed", "aria-selected", "aria-expanded", "disabled"]
                .filter((a) => el.hasAttribute(a)).map((a) => `${a.replace("aria-", "")}=${el.getAttribute(a) || "true"}`).join(" ");
            lines.push(`${role} "${name}"${state ? " [" + state + "]" : ""}`);
        }
        return lines.join("\n");
    }
    if (op === "text") return clean(document.body.innerText);
    if (op === "nameOf") return nameOf(query);
    throw new Error("unknown op " + op);
}
