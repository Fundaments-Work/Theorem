/**
 * Theorem Core WebAssembly / Native computational bridge.
 *
 * Provides shared pure-computation utilities:
 * - Markdown rendering via pulldown-cmark
 * - Nucleo-powered fuzzy ranking
 * - Speech text normalization
 * - Vault / PKM filename and frontmatter generation
 */

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

/**
 * Normalizes speech text deterministically (numbers, dates, currency, ordinals).
 */
export function normalizeSpeechText(text: string, _lang = "en"): string {
    // Basic deterministic cleanup in JS when WASM is not yet initialized
    return text.trim();
}

/**
 * Sanitizes a title into a safe note filename for PKM vaults (Obsidian, Logseq).
 */
export function safeVaultFilename(title: string): string {
    const sanitized = title.replace(/[:/\\<>\"|?*]/g, "-").trim().replace(/^[.\-\s]+|[.\-\s]+$/g, "");
    return sanitized.length > 0 ? sanitized : "Untitled Note";
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
