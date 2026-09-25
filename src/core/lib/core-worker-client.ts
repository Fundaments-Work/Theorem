/**
 * Client for Theorem Core Web Worker (`core-worker-client.ts`).
 *
 * Provides a promise-based API to offload search, markdown, and EPUB unzipping
 * onto a background Web Worker with zero-copy transferable ArrayBuffers.
 */

import {
    initTheoremCoreWasm,
    isWasmCoreReady,
    wasmFuzzyRank,
    wasmMarkdownToHtml,
    type FuzzyRankCandidate,
    type FuzzyRankResult,
} from "./theorem-core";

export interface CoreWorkerEntryMetadata {
    filename: string;
    uncompressedSize: number;
}

export class CoreWorkerClient {
    private worker: Worker | null = null;
    private requestId = 0;
    private pending = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
    private isWorkerFailed = false;

    constructor() {
        this.initWorker();
    }

    private initWorker(): void {
        if (typeof window === "undefined" && typeof self === "undefined") {
            return;
        }
        if (typeof Worker === "undefined") {
            return;
        }

        try {
            // Standard Vite module worker instantiation
            this.worker = new Worker(
                new URL("../workers/core-worker.ts", import.meta.url),
                { type: "module" }
            );

            this.worker.onmessage = (event: MessageEvent) => {
                const { id, type, data, error } = event.data;
                const deferred = this.pending.get(id);
                if (!deferred) return;
                this.pending.delete(id);

                if (type === "SUCCESS") {
                    deferred.resolve(data);
                } else {
                    deferred.reject(new Error(error || "Worker operation failed"));
                }
            };

            this.worker.onerror = (err) => {
                console.warn("[CoreWorkerClient] Worker error, falling back to main-thread processing:", err);
                this.isWorkerFailed = true;
            };
        } catch (e) {
            console.warn("[CoreWorkerClient] Could not instantiate Web Worker:", e);
            this.isWorkerFailed = true;
        }
    }

    public isWorkerAvailable(): boolean {
        return !!this.worker && !this.isWorkerFailed;
    }

    private send<T>(type: string, payload?: any, transfer: Transferable[] = []): Promise<T> {
        if (!this.worker || this.isWorkerFailed) {
            return Promise.reject(new Error("Worker not available"));
        }

        const id = ++this.requestId;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker!.postMessage({ id, type, payload }, transfer);
        });
    }

    /**
     * Executes fuzzy search in the worker using SIMD nucleo-matcher.
     * Falls back to main thread if worker is unavailable.
     */
    public async fuzzySearch(
        candidates: FuzzyRankCandidate[],
        query: string
    ): Promise<FuzzyRankResult[]> {
        if (this.isWorkerAvailable()) {
            try {
                return await this.send<FuzzyRankResult[]>("FUZZY_SEARCH", { candidates, query });
            } catch {
                // Fall back
            }
        }

        if (!isWasmCoreReady()) {
            await initTheoremCoreWasm();
        }
        return wasmFuzzyRank(candidates, query);
    }

    /**
     * Renders Markdown batch in the worker using pulldown-cmark.
     */
    public async renderMarkdownBatch(items: string[]): Promise<string[]> {
        if (this.isWorkerAvailable()) {
            try {
                return await this.send<string[]>("MARKDOWN_BATCH", { items });
            } catch {
                // Fall back
            }
        }

        if (!isWasmCoreReady()) {
            await initTheoremCoreWasm();
        }
        return items.map((item) => wasmMarkdownToHtml(item));
    }

    /**
     * Transfers an EPUB ArrayBuffer into the worker for background inflation.
     * Zero-copy transfer keeps the main thread unblocked.
     */
    public async initEpub(
        buffer: ArrayBuffer
    ): Promise<{ entries: CoreWorkerEntryMetadata[] }> {
        if (this.isWorkerAvailable()) {
            try {
                // Buffer is transferred into worker with 0ms copy overhead
                return await this.send<{ entries: CoreWorkerEntryMetadata[] }>(
                    "INIT_EPUB",
                    { buffer },
                    [buffer]
                );
            } catch (err) {
                console.warn("[CoreWorkerClient] initEpub worker failed, falling back to local:", err);
            }
        }

        // Main-thread fallback using vendor zip.js
        const { ZipReader, BlobReader, configure } = await import(
            "../../features/reader/foliate-js-runtime/vendor/zip.js"
        );
        configure({ useWebWorkers: false });
        const reader = new ZipReader(new BlobReader(new Blob([buffer])));
        const entries = await reader.getEntries();
        return {
            entries: (entries as any[]).map((e: any) => ({
                filename: e.filename,
                uncompressedSize: e.uncompressedSize || 0,
            })),
        };
    }

    /**
     * Reads a raw EPUB entry as an ArrayBuffer from the worker (zero-copy transfer back).
     */
    public async readEpubEntry(filename: string): Promise<ArrayBuffer | null> {
        if (this.isWorkerAvailable()) {
            try {
                return await this.send<ArrayBuffer | null>("READ_EPUB_ENTRY", {
                    filename,
                    asText: false,
                });
            } catch {
                return null;
            }
        }
        return null;
    }

    /**
     * Reads a text EPUB entry (e.g. XML chapter, CSS, OPF).
     */
    public async readEpubText(filename: string): Promise<string | null> {
        if (this.isWorkerAvailable()) {
            try {
                return await this.send<string | null>("READ_EPUB_ENTRY", {
                    filename,
                    asText: true,
                });
            } catch {
                return null;
            }
        }
        return null;
    }

    public terminate(): void {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        this.pending.clear();
    }
}

export const coreWorker = new CoreWorkerClient();

if (typeof window !== "undefined") {
    (window as any).__THEOREM_CORE_WORKER__ = coreWorker;
}
