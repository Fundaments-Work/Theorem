/* tslint:disable */
/* eslint-disable */

export function wasm_fuzzy_rank(candidates_json: string, query: string): string;

export function wasm_markdown_to_html(markdown: string): string;

export function wasm_normalize_speech_text(text: string, lang?: string | null): string;

export function wasm_number_to_words(n: bigint): string;

/**
 * Expand an OPDS/OpenSearch search URL template with a query.
 */
export function wasm_opds_expand_search(template: string, query: string): string;

/**
 * Parse an OPDS document fetched by the browser. Returns the `Outcome` as JSON, the same shape
 * the desktop app gets from its native loader, so the UI has one code path.
 */
export function wasm_opds_parse(body: Uint8Array, content_type: string, base_url: string): string;

export function wasm_ordinal_to_words(n: bigint): string;

export function wasm_safe_vault_filename(title: string): string;

export function wasm_year_to_words(year: number): string | undefined;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly wasm_fuzzy_rank: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasm_markdown_to_html: (a: number, b: number, c: number) => void;
    readonly wasm_normalize_speech_text: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasm_number_to_words: (a: number, b: bigint) => void;
    readonly wasm_opds_expand_search: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasm_opds_parse: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly wasm_ordinal_to_words: (a: number, b: bigint) => void;
    readonly wasm_safe_vault_filename: (a: number, b: number, c: number) => void;
    readonly wasm_year_to_words: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
