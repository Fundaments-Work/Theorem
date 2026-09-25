/**
 * Theorem Core WebAssembly / Native computational bridge.
 *
 * Provides shared pure-computation utilities:
 * - Markdown rendering via pulldown-cmark
 * - Nucleo-powered SIMD fuzzy ranking
 * - Speech text normalization
 * - Vault / PKM filename and frontmatter generation
 */

import init, {
    initSync,
    wasm_fuzzy_rank,
    wasm_markdown_to_html,
    wasm_normalize_speech_text,
    wasm_safe_vault_filename,
    wasm_number_to_words,
} from "../wasm/theorem_core.js";

export interface FuzzyRankCandidate {
    id: string;
    title: string;
    author?: string;
}

export interface FuzzyRankResult {
    id: string;
    score: number;
    titleIndices: number[];
    authorIndices: number[];
}

let wasmReady = false;
let wasmInitPromise: Promise<boolean> | null = null;

/**
 * Initialize theorem-core WebAssembly module in the web client or test runner.
 */
export async function initTheoremCoreWasm(
    input?: RequestInfo | URL | Response | BufferSource
): Promise<boolean> {
    if (wasmReady) return true;
    if (wasmInitPromise) return wasmInitPromise;

    wasmInitPromise = (async () => {
        try {
            const wasmInput = input || (globalThis as any).__THEOREM_WASM_BYTES__;
            if (wasmInput) {
                if (wasmInput instanceof ArrayBuffer || ArrayBuffer.isView(wasmInput)) {
                    initSync({ module: wasmInput as BufferSource });
                } else {
                    await init(wasmInput as any);
                }
                wasmReady = true;
                return true;
            }

            // In Node.js / test environment (Vitest):
            const globalProcess = (globalThis as Record<string, any>).process;
            if (globalProcess?.versions?.node) {
                try {
                    const req = new Function("return typeof require !== 'undefined' ? require : null")();
                    if (req) {
                        const fs = req("node:fs");
                        const path = req("node:path");
                        let filePath: string;
                        try {
                            const { fileURLToPath } = req("node:url");
                            filePath = fileURLToPath(new URL("../wasm/theorem_core_bg.wasm", import.meta.url));
                        } catch {
                            filePath = path.resolve(globalProcess.cwd(), "src/core/wasm/theorem_core_bg.wasm");
                        }
                        if (!fs.existsSync(filePath)) {
                            filePath = path.resolve(globalProcess.cwd(), "src/core/wasm/theorem_core_bg.wasm");
                        }
                        const bytes = fs.readFileSync(filePath);
                        initSync({ module: bytes });
                        wasmReady = true;
                        return true;
                    }
                } catch {
                    // Fall back to browser path
                }
            }

            // In browser / web worker environment:
            if (typeof window !== "undefined" || typeof self !== "undefined") {
                const wasmUrl = new URL("../wasm/theorem_core_bg.wasm", import.meta.url);
                try {
                    await init(wasmUrl);
                    wasmReady = true;
                    return true;
                } catch {
                    // Try absolute /wasm/ public path fallback
                    const fallbackUrl = "/wasm/theorem_core_bg.wasm";
                    await init(fallbackUrl);
                    wasmReady = true;
                    return true;
                }
            }

            return false;
        } catch (e) {
            console.warn("[theorem-core] WebAssembly initialization fallback to JS:", e);
            return false;
        }
    })();

    return wasmInitPromise;
}

/**
 * Returns true if theorem-core WASM is instantiated and ready.
 */
export function isWasmCoreReady(): boolean {
    return wasmReady;
}

/**
 * Rank search candidates using SIMD-accelerated Smith-Waterman matching (nucleo-matcher).
 */
export function wasmFuzzyRank(candidates: FuzzyRankCandidate[], query: string): FuzzyRankResult[] {
    if (!wasmReady || candidates.length === 0 || !query.trim()) {
        return [];
    }
    try {
        const json = JSON.stringify(candidates);
        const resStr = wasm_fuzzy_rank(json, query);
        return JSON.parse(resStr) as FuzzyRankResult[];
    } catch {
        return [];
    }
}

/**
 * Safe markdown-to-HTML rendering using pulldown-cmark in WebAssembly.
 */
export function wasmMarkdownToHtml(markdown: string): string {
    if (!wasmReady) {
        return markdown;
    }
    try {
        return wasm_markdown_to_html(markdown);
    } catch {
        return markdown;
    }
}

/**
 * Normalizes speech text deterministically (numbers, dates, currency, ordinals).
 */
export function normalizeSpeechText(text: string, lang = "en"): string {
    if (wasmReady) {
        try {
            return wasm_normalize_speech_text(text, lang);
        } catch {
            // fall back
        }
    }
    return text.trim();
}

/**
 * Sanitizes a title into a safe note filename for PKM vaults (Obsidian, Logseq).
 */
export function safeVaultFilename(title: string): string {
    if (wasmReady) {
        try {
            return wasm_safe_vault_filename(title);
        } catch {
            // fall back
        }
    }
    const sanitized = title.replace(/[:/\\<>\"|?*]/g, "-").trim().replace(/^[.\-\s]+|[.\-\s]+$/g, "");
    return sanitized.length > 0 ? sanitized : "Untitled Note";
}

/**
 * Converts a number to words via WASM text normalizer if ready.
 */
export function numberToWords(n: bigint): string {
    if (wasmReady) {
        try {
            return wasm_number_to_words(n);
        } catch {
            // fall back
        }
    }
    return n.toString();
}

/**
 * Builds YAML frontmatter string for markdown notes.
 */
export function buildFrontmatter(title: string, author?: string, tags: string[] = []): string {
    let out = "---\n";
    out += `title: "${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`;
    if (author) {
        out += `author: "${author.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`;
    }
    if (tags.length > 0) {
        out += "tags:\n";
        for (const tag of tags) {
            out += `  - "${tag.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`;
        }
    }
    out += "---\n";
    return out;
}

// Auto-initialize WASM client eagerly in browser environment
const envProcess = (globalThis as Record<string, any>).process;
if (typeof window !== "undefined" && !envProcess?.versions?.node && !wasmReady) {
    initTheoremCoreWasm().catch(() => {});
}
