/**
 * Thumbnail cache for the PDF page grid: one render at a time, newest request
 * first (the tiles the user is looking at), cancelled when a tile scrolls
 * away, and a bounded LRU of object URLs (evicted URLs are revoked).
 */

export type RenderThumbnail = (pageNumber: number, signal: AbortSignal) => Promise<Blob | null>;

export interface ThumbnailStore {
    /** Cached URL, refreshing its LRU position. */
    get(pageNumber: number): string | undefined;
    /** Resolves with the URL, or `null` if cancelled/failed. Deduplicated per page. */
    request(pageNumber: number): Promise<string | null>;
    /** Drop a pending (not yet started) or running request. */
    cancel(pageNumber: number): void;
    dispose(): void;
}

interface Pending {
    page: number;
    controller: AbortController;
    promise: Promise<string | null>;
    resolve: (url: string | null) => void;
    started: boolean;
}

export function createThumbnailStore(
    render: RenderThumbnail,
    { maxEntries = 240, createUrl = (b: Blob) => URL.createObjectURL(b), revokeUrl = (u: string) => URL.revokeObjectURL(u) } = {},
): ThumbnailStore {
    const cache = new Map<number, string>();
    const pending = new Map<number, Pending>();
    /** Waiting page numbers; the most recent request runs next. */
    const stack: number[] = [];
    let running = false;
    let disposed = false;

    const remember = (page: number, url: string) => {
        cache.delete(page);
        cache.set(page, url);
        while (cache.size > maxEntries) {
            const [oldest, oldUrl] = cache.entries().next().value as [number, string];
            cache.delete(oldest);
            revokeUrl(oldUrl);
        }
    };

    const pump = async () => {
        if (running || disposed) return;
        const page = stack.pop();
        if (page === undefined) return;
        const job = pending.get(page);
        if (!job) { void pump(); return; }
        running = true;
        job.started = true;
        let url: string | null = null;
        try {
            const blob = await render(page, job.controller.signal);
            if (blob && !job.controller.signal.aborted && !disposed) {
                url = createUrl(blob);
                remember(page, url);
            }
        } catch {
            url = null;
        } finally {
            if (pending.get(page) === job) pending.delete(page);
            job.resolve(url);
            running = false;
            void pump();
        }
    };

    return {
        get(page) {
            const url = cache.get(page);
            if (url !== undefined) remember(page, url);
            return url;
        },
        request(page) {
            const cached = this.get(page);
            if (cached !== undefined) return Promise.resolve(cached);
            if (disposed) return Promise.resolve(null);
            const existing = pending.get(page);
            if (existing) {
                if (!existing.started) {
                    stack.splice(stack.indexOf(page), 1);
                    stack.push(page);
                }
                return existing.promise;
            }
            let resolve!: (url: string | null) => void;
            const promise = new Promise<string | null>((r) => { resolve = r; });
            pending.set(page, { page, controller: new AbortController(), promise, resolve, started: false });
            stack.push(page);
            void pump();
            return promise;
        },
        cancel(page) {
            const job = pending.get(page);
            if (!job) return;
            job.controller.abort();
            if (!job.started) {
                pending.delete(page);
                const at = stack.indexOf(page);
                if (at !== -1) stack.splice(at, 1);
                job.resolve(null);
            }
        },
        dispose() {
            disposed = true;
            for (const job of pending.values()) { job.controller.abort(); if (!job.started) job.resolve(null); }
            pending.clear();
            stack.length = 0;
            for (const url of cache.values()) revokeUrl(url);
            cache.clear();
        },
    };
}
