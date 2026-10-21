let isInitialized = false;

export async function initSentry(
    dsn?: string,
    environment: string = "production",
): Promise<void> {
    if (isInitialized) return;

    const resolvedDsn = dsn ?? (typeof (globalThis as any).process?.env?.SENTRY_DSN === "string" ? (globalThis as any).process.env.SENTRY_DSN : undefined);

    if (!resolvedDsn) {
        return;
    }

    // Named imports let the bundler drop Replay and the rest of the namespace.
    const { init, browserTracingIntegration } = await import("@sentry/react");

    init({
        dsn: resolvedDsn,
        environment,
        integrations: [
            browserTracingIntegration(),
        ],
        tracesSampleRate: environment === "production" ? 0.1 : 1.0,
        beforeSend(event) {
            if (event.breadcrumbs) {
                for (const crumb of event.breadcrumbs) {
                    if (crumb.data && "filePath" in crumb.data) {
                        delete crumb.data.filePath;
                    }
                }
            }
            return event;
        },
    });

    isInitialized = true;
}
