let prewarmPromise: Promise<void> | null = null;

export function prewarmFoliateRuntime(): Promise<void> {
    if (!prewarmPromise) {
        prewarmPromise = import("../foliate-js-runtime/view.js")
            .then(() => undefined)
            .catch(() => {
                prewarmPromise = null;
            });
    }
    return prewarmPromise;
}
