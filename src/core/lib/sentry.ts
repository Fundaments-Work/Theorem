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

    const Sentry = await import("@sentry/react");

    Sentry.init({
        dsn: resolvedDsn,
        environment,
        integrations: [
            Sentry.browserTracingIntegration(),
            Sentry.replayIntegration(),
        ],
        tracesSampleRate: environment === "production" ? 0.1 : 1.0,
        replaysSessionSampleRate: 0.1,
        replaysOnErrorSampleRate: 1.0,
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
