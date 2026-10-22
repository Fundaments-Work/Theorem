/**
 * Start an asynchronous subscription (a Tauri event listener, a window
 * handler) from a React effect and return the effect's cleanup.
 *
 * If the cleanup runs before the subscription resolves (StrictMode, a quick
 * unmount), the subscription is undone as soon as it arrives instead of being
 * leaked. A failure to subscribe is reported with `label`.
 */
export function subscribeUntilCleanup(
    label: string,
    subscribe: () => Promise<() => void>,
): () => void {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    void Promise.resolve()
        .then(subscribe)
        .then(
            (stop) => {
                if (cancelled) stop();
                else unsubscribe = stop;
            },
            (error: unknown) => {
                console.error(`[App] ${label} could not be set up:`, error);
            },
        );

    return () => {
        cancelled = true;
        const stop = unsubscribe;
        unsubscribe = null;
        stop?.();
    };
}
