/**
 * Markdown in articles is rendered by `pulldown-cmark` in Rust
 * (`rss_parser.rs`): feeds are converted at parse time, and articles stored
 * before that are converted once after load (`convertStoredMarkdownArticles`
 * in `rssStore.ts`). There is no Markdown parser in JS; the browser build,
 * which cannot reach Rust, shows such text as escaped plain paragraphs.
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./env";
import { isWasmCoreReady, wasmMarkdownToHtml } from "./theorem-core";

export function looksLikeMarkdown(text: string): boolean {
    if (!text || text.length < 3) return false;
    return /^#{1,6}\s/m.test(text)
        || /^\s*[-*+]\s/m.test(text)
        || /\*\*[^*]+\*\*/.test(text)
        || /\[.+?\]\(.+?\)/.test(text)
        || /^>\s/m.test(text)
        || /`{3}[\s\S]*?`{3}/.test(text)
        || /^\s*\d+[.)]\s/m.test(text)
        || /~~.+?~~/.test(text);
}

/** Markdown-looking text with no markup yet: needs a Rust render. */
export function needsMarkdownRender(text: string | undefined): text is string {
    return !!text && looksLikeMarkdown(text) && !/<[a-zA-Z][^>]*>/.test(text);
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** Escaped paragraphs (blank-line separated) with line breaks kept. */
export function plainTextToHtml(text: string): string {
    return text
        .replace(/\r\n?/g, "\n")
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter(Boolean)
        .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
        .join("\n");
}

/** Render Markdown through Rust (Tauri) or theorem-core WASM (browser); fallback to plain paragraphs. */
export async function renderMarkdownBatch(items: string[]): Promise<string[]> {
    if (items.length === 0) return [];
    if (isTauri()) {
        try {
            return await invoke<string[]>("render_markdown_batch", { items });
        } catch {
            // fall through
        }
    }
    if (isWasmCoreReady()) {
        return items.map((item) => wasmMarkdownToHtml(item));
    }
    return items.map(plainTextToHtml);
}
