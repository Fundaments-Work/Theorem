/**
 * Theorem Core Web Worker (`core-worker.ts`).
 *
 * Offloads compute-heavy operations from the main UI thread:
 * 1. WebAssembly SIMD fuzzy search (nucleo-matcher)
 * 2. WebAssembly Markdown rendering (pulldown-cmark)
 * 3. High-throughput EPUB unzipping with zero-copy transferable ArrayBuffers
 *
 * Keeps the main thread locked at 60-120fps during fast searching and page flipping.
 */

import init, {
    wasm_fuzzy_rank,
    wasm_markdown_to_html,
} from "../wasm/theorem_core.js";
import { unzipSync, strFromU8 } from "fflate";

let wasmReady = false;
const activeEntriesMap = new Map<string, Uint8Array>();

async function ensureWasm(wasmUrl?: string): Promise<boolean> {
    if (wasmReady) return true;
    try {
        const url = wasmUrl || new URL("../wasm/theorem_core_bg.wasm", import.meta.url);
        await init(url);
        wasmReady = true;
        return true;
    } catch {
        try {
            await init("/wasm/theorem_core_bg.wasm");
            wasmReady = true;
            return true;
        } catch {
            return false;
        }
    }
}

// Auto-init wasm in worker
ensureWasm().catch(() => {});

self.onmessage = async (event: MessageEvent) => {
    const { id, type, payload } = event.data;

    try {
        switch (type) {
            case "INIT_WASM": {
                const ok = await ensureWasm(payload?.wasmUrl);
                self.postMessage({ id, type: "SUCCESS", data: ok });
                break;
            }

            case "FUZZY_SEARCH": {
                const { candidates, query } = payload;
                if (!query || !candidates || candidates.length === 0) {
                    self.postMessage({ id, type: "SUCCESS", data: [] });
                    return;
                }
                const ready = await ensureWasm();
                if (!ready) {
                    self.postMessage({ id, type: "ERROR", error: "WASM not ready" });
                    return;
                }
                const json = JSON.stringify(candidates);
                const resStr = wasm_fuzzy_rank(json, query);
                const results = JSON.parse(resStr);
                self.postMessage({ id, type: "SUCCESS", data: results });
                break;
            }

            case "MARKDOWN_BATCH": {
                const { items } = payload;
                const ready = await ensureWasm();
                if (!ready) {
                    self.postMessage({ id, type: "ERROR", error: "WASM not ready" });
                    return;
                }
                const rendered = (items as string[]).map((item) => wasm_markdown_to_html(item));
                self.postMessage({ id, type: "SUCCESS", data: rendered });
                break;
            }

            case "INIT_EPUB": {
                const { buffer } = payload;
                if (!(buffer instanceof ArrayBuffer)) {
                    throw new Error("INIT_EPUB requires an ArrayBuffer");
                }
                activeEntriesMap.clear();

                const files = unzipSync(new Uint8Array(buffer));
                const metadata: { filename: string; uncompressedSize: number }[] = [];

                for (const [filename, data] of Object.entries(files)) {
                    activeEntriesMap.set(filename, data);
                    // Also register without leading slash
                    if (filename.startsWith("/")) {
                        activeEntriesMap.set(filename.slice(1), data);
                    }
                    metadata.push({
                        filename,
                        uncompressedSize: data.byteLength,
                    });
                }

                self.postMessage({ id, type: "SUCCESS", data: { entries: metadata } });
                break;
            }

            case "READ_EPUB_ENTRY": {
                const { filename, asText } = payload;
                const entry =
                    activeEntriesMap.get(filename) ||
                    activeEntriesMap.get(filename.replace(/^\//, "")) ||
                    activeEntriesMap.get(`/${filename}`);

                if (!entry) {
                    self.postMessage({ id, type: "SUCCESS", data: null });
                    return;
                }

                if (asText) {
                    const text = strFromU8(entry);
                    self.postMessage({ id, type: "SUCCESS", data: text });
                } else {
                    const arrayBuffer: ArrayBuffer = entry.slice().buffer;
                    // Transfer ArrayBuffer without memory copying
                    (self as any).postMessage({ id, type: "SUCCESS", data: arrayBuffer }, [arrayBuffer]);
                }
                break;
            }

            default:
                throw new Error(`Unknown worker message type: ${type}`);
        }
    } catch (err: any) {
        self.postMessage({
            id,
            type: "ERROR",
            error: err?.message || String(err),
        });
    }
};
