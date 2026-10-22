/** The part of `sync-orchestrator` that starting auto sync needs. */
export interface AutoSyncModule {
    ensureResponderSyncReady(): Promise<unknown>;
    subscribeZustandToIrohDocs(): () => void;
    startAutoSync(): Promise<unknown>;
    stopAutoSync(): void;
}

function report(step: string, error: unknown): void {
    console.error(`[Sync] ${step} failed during startup:`, error);
}

/**
 * Start auto sync `delayMs` after the call and return the effect cleanup.
 *
 * The cleanup can run at any point, including while one of the steps is
 * still awaiting: whatever has started by then (or starts afterwards) is
 * stopped, so no auto-sync interval outlives the effect. The sync module is
 * passed as a loader so it stays out of the startup bundle.
 */
export function bootstrapAutoSync(
    loadSync: () => Promise<AutoSyncModule>,
    autoSyncEnabled: boolean,
    delayMs: number,
): () => void {
    let cancelled = false;
    let sync: AutoSyncModule | null = null;
    let bridgeCleanup: (() => void) | null = null;
    let startRequested = false;

    const stopStarted = () => {
        const cleanupBridge = bridgeCleanup;
        bridgeCleanup = null;
        cleanupBridge?.();
        if (startRequested && sync) {
            startRequested = false;
            sync.stopAutoSync();
        }
    };

    const bootstrap = async () => {
        try {
            sync = await loadSync();
        } catch (error) {
            report("Loading the sync module", error);
            return;
        }
        if (cancelled) return;

        if (!autoSyncEnabled) {
            sync.stopAutoSync();
            return;
        }

        try {
            await sync.ensureResponderSyncReady();
        } catch (error) {
            report("Preparing the sync responder", error);
        }
        if (cancelled) return;

        try {
            bridgeCleanup = sync.subscribeZustandToIrohDocs();
        } catch (error) {
            report("Subscribing stores to sync", error);
        }

        // Marked before the await: a cleanup that lands while it is in flight
        // must still stop the interval it arms.
        startRequested = true;
        try {
            await sync.startAutoSync();
        } catch (error) {
            report("Starting auto sync", error);
        }
        if (cancelled) stopStarted();
    };

    const timer = setTimeout(() => {
        void bootstrap();
    }, delayMs);

    return () => {
        cancelled = true;
        clearTimeout(timer);
        stopStarted();
    };
}
