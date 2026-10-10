class MemoryStorage implements Storage {
    private readonly data = new Map<string, string>();

    get length(): number {
        return this.data.size;
    }

    clear(): void {
        this.data.clear();
    }

    getItem(key: string): string | null {
        return this.data.has(key) ? this.data.get(key)! : null;
    }

    key(index: number): string | null {
        const keys = Array.from(this.data.keys());
        return keys[index] ?? null;
    }

    removeItem(key: string): void {
        this.data.delete(String(key));
    }

    setItem(key: string, value: string): void {
        this.data.set(String(key), String(value));
    }
}

if (!globalThis.localStorage || typeof globalThis.localStorage.setItem !== "function") {
    Object.defineProperty(globalThis, "localStorage", {
        value: new MemoryStorage(),
        configurable: true,
    });
}

if (!globalThis.sessionStorage || typeof globalThis.sessionStorage.setItem !== "function") {
    Object.defineProperty(globalThis, "sessionStorage", {
        value: new MemoryStorage(),
        configurable: true,
    });
}

if (typeof window !== "undefined" && !window.matchMedia) {
    window.matchMedia = (query: string): MediaQueryList => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
    });
}

if (typeof window !== "undefined" && !window.requestAnimationFrame) {
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
        return window.setTimeout(() => callback(performance.now()), 16);
    };
}

if (typeof window !== "undefined" && !window.cancelAnimationFrame) {
    window.cancelAnimationFrame = (handle: number) => {
        window.clearTimeout(handle);
    };
}

if (typeof globalThis.ResizeObserver === "undefined") {
    /**
     * jsdom implements neither ResizeObserver nor layout, so container-based
     * views (Library, Shelves, Discover, OPDS) cannot observe themselves here.
     * A no-op stub is enough: they only ever use it to recompute column counts,
     * and the initial state is already a sane column count.
     */
    class NoopResizeObserver {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    }
    globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
}

try {
    const fs = require("node:fs");
    const path = require("node:path");
    const wasmPath = path.resolve(__dirname, "../src/core/wasm/theorem_core_bg.wasm");
    if (fs.existsSync(wasmPath)) {
        (globalThis as any).__THEOREM_WASM_BYTES__ = fs.readFileSync(wasmPath);
    }
} catch {
    // Ignore in non-node test runners
}

