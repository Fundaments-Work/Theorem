/**
 * Bounded LRU of rendered-but-offscreen PDF pages (canvas + text layer +
 * pdf.js page resources). Releasing a page the moment it leaves the render
 * window makes scrolling back and forth repaint the same pages over and over
 * (the main cost of scroll jank); keeping everything would grow without
 * bound. Like pdf.js's own PDFPageViewBuffer, keep the most recent few, capped
 * by both count and total canvas pixels, and release the oldest first.
 */
export class RenderedPageCache<K> {
    private readonly entries = new Map<K, { pixels: number; release: () => void }>();
    private totalPixels = 0;

    constructor(private readonly maxEntries: number, private readonly maxPixels: number) {}

    get size(): number {
        return this.entries.size;
    }

    get pixels(): number {
        return this.totalPixels;
    }

    /** A page left the render window: keep it (most recent), evicting beyond the budget. */
    retain(key: K, pixels: number, release: () => void): void {
        this.reclaim(key);
        const safePixels = Number.isFinite(pixels) && pixels > 0 ? pixels : 0;
        this.entries.set(key, { pixels: safePixels, release });
        this.totalPixels += safePixels;
        this.evict();
    }

    /** The page is visible again: take it back without releasing. Returns whether it was cached. */
    reclaim(key: K): boolean {
        const entry = this.entries.get(key);
        if (!entry) return false;
        this.entries.delete(key);
        this.totalPixels -= entry.pixels;
        return true;
    }

    /** Remove and release now (unmount, document change). */
    drop(key: K): void {
        const entry = this.entries.get(key);
        if (!entry) return;
        this.entries.delete(key);
        this.totalPixels -= entry.pixels;
        runRelease(entry.release);
    }

    clear(): void {
        for (const key of [...this.entries.keys()]) this.drop(key);
    }

    private evict(): void {
        while (this.entries.size > this.maxEntries || (this.totalPixels > this.maxPixels && this.entries.size > 0)) {
            const oldest = this.entries.keys().next().value as K;
            this.drop(oldest);
        }
    }
}

function runRelease(release: () => void): void {
    try {
        release();
    } catch {
        // A failing release must not break eviction of the rest.
    }
}
