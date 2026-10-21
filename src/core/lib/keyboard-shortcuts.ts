import { useEffect, useRef, useCallback } from "react";

export interface KeyboardShortcut {
    
    label: string;
    
    keys: string;
    
    category: string;
    
    handler: () => void;
    
    preventDefault?: boolean;
}

interface RegisteredShortcut extends KeyboardShortcut {
    id: number;
    owner: symbol;
}

interface ShortcutGroup {
    shortcuts: RegisteredShortcut[];
    
    route?: string;
}

let nextId = 0;
const shortcutsByGroup = new Map<string, ShortcutGroup>();

/**
 * Apple platforms (macOS, iPadOS with a keyboard) put app shortcuts on Command, everyone else on
 * Control. Evaluated per call so tests and hot-swapped keyboards behave.
 */
export function isApplePlatform(): boolean {
    if (typeof navigator === "undefined") return false;
    const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
    const platform = uaData?.platform || navigator.platform || "";
    return /mac|iphone|ipad|ipod/i.test(platform);
}

interface Combo {
    key: string;
    /** The platform's primary modifier: Command on Apple platforms, Control elsewhere. */
    mod: boolean;
    shift: boolean;
    alt: boolean;
    /** A literal Command/Meta key, for the rare shortcut that must not follow the platform. */
    meta: boolean;
}

/**
 * "Ctrl", "Control", "Mod" and "CmdOrCtrl" all mean the primary modifier, so one declaration
 * (`Ctrl+1`) is Ctrl+1 on Windows/Linux and ⌘1 on a Mac. "Meta"/"Cmd" stay literal.
 */
function parseCombo(keys: string): Combo {
    const parts = keys.toLowerCase().split("+").map((p) => p.trim());
    const key = parts[parts.length - 1];
    return {
        key,
        mod: parts.some((p) => p === "ctrl" || p === "control" || p === "mod" || p === "cmdorctrl"),
        shift: parts.includes("shift"),
        alt: parts.includes("alt") || parts.includes("option"),
        meta: parts.includes("meta") || parts.includes("cmd"),
    };
}

function matchesCombo(event: KeyboardEvent, combo: Combo): boolean {
    const eventKey = event.key.toLowerCase();
    const comboKey = combo.key;

    if (eventKey !== comboKey && event.code !== undefined) {
        const codeKey = event.code.toLowerCase().replace("key", "").replace("digit", "");
        if (codeKey !== comboKey) return false;
    }

    const apple = isApplePlatform();
    // Required modifiers, resolved to the physical keys for this platform.
    const wantCtrl = combo.mod && !apple;
    const wantMeta = combo.meta || (combo.mod && apple);

    if (event.ctrlKey !== wantCtrl) return false;
    if (event.metaKey !== wantMeta) return false;
    if (event.shiftKey !== combo.shift) return false;
    if (event.altKey !== combo.alt) return false;

    return true;
}

export function registerShortcuts(
    groupId: string,
    shortcuts: KeyboardShortcut[],
    route?: string,
): () => void {
    const owner = Symbol(groupId);
    const group: ShortcutGroup = {
        shortcuts: shortcuts.map((s) => ({
            ...s,
            id: nextId++,
            owner,
        })),
        route,
    };
    shortcutsByGroup.set(groupId, group);

    return () => {
        shortcutsByGroup.delete(groupId);
    };
}

export function getAllShortcuts(): KeyboardShortcut[] {
    const result: KeyboardShortcut[] = [];
    for (const group of shortcutsByGroup.values()) {
        for (const s of group.shortcuts) {
            result.push({
                label: s.label,
                keys: s.keys,
                category: s.category,
                handler: s.handler,
                preventDefault: s.preventDefault,
            });
        }
    }
    return result;
}

const DISPLAY_KEY_MAP: Record<string, string> = {
    shift: "Shift",
    alt: "Alt",
    option: "Alt",
    escape: "Esc",
    arrowleft: "←",
    arrowright: "→",
    arrowup: "↑",
    arrowdown: "↓",
    " ": "Space",
};

const APPLE_KEY_MAP: Record<string, string> = {
    ctrl: "⌘",
    control: "⌘",
    mod: "⌘",
    cmdorctrl: "⌘",
    meta: "⌘",
    cmd: "⌘",
    shift: "⇧",
    alt: "⌥",
    option: "⌥",
};

const OTHER_KEY_MAP: Record<string, string> = {
    ctrl: "Ctrl",
    control: "Ctrl",
    mod: "Ctrl",
    cmdorctrl: "Ctrl",
    meta: "Win",
    cmd: "Win",
};

/** Human label for a shortcut: "⌘ + 1" on a Mac, "Ctrl + 1" elsewhere. */
export function formatShortcutKeys(keys: string): string {
    const apple = isApplePlatform();
    return keys
        .split("+")
        .map((p) => p.trim())
        .map((p) => {
            const lower = p.toLowerCase();
            const mapped = (apple ? APPLE_KEY_MAP[lower] : OTHER_KEY_MAP[lower]) ?? DISPLAY_KEY_MAP[lower];
            if (mapped) return mapped;
            return p.length === 1 ? p.toUpperCase() : p;
        })
        .join(" + ");
}

export function useKeyboardShortcuts(activeRoute?: string, enabled = true): void {
    const activeRouteRef = useRef(activeRoute);
    activeRouteRef.current = activeRoute;

    const handleKeyDown = useCallback(
        (event: KeyboardEvent) => {
            if (!enabled) return;

            const target = event.target as HTMLElement | null;
            if (
                target
                && (target.tagName === "INPUT"
                    || target.tagName === "TEXTAREA"
                    || target.tagName === "SELECT"
                    || target.isContentEditable)
            ) {
                return;
            }

            if (event.key === "Escape") {
                return;
            }

            for (const group of shortcutsByGroup.values()) {
                if (group.route && group.route !== activeRouteRef.current) {
                    continue;
                }

                for (const shortcut of group.shortcuts) {
                    const combo = parseCombo(shortcut.keys);
                    if (matchesCombo(event, combo)) {
                        event.preventDefault();
                        shortcut.handler();
                        return;
                    }
                }
            }
        },
        [enabled],
    );

    useEffect(() => {
        if (!enabled) return;

        window.addEventListener("keydown", handleKeyDown, { capture: true });
        return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
    }, [enabled, handleKeyDown]);
}
