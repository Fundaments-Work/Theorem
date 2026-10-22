import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./shell";
import { GlobalLoader } from "./ui/loading";
import { initSentry } from "./core/lib/sentry";
import { readStartupDbHealth } from "./core/lib/db-health";
import { suspendPersistence } from "./core/lib/persist-storage";
import "./index.css";

void initSentry(import.meta.env.VITE_SENTRY_DSN as string | undefined, import.meta.env.MODE);

const DatabaseRecovery = lazy(() => import("./shell/DatabaseRecovery"));

const rootElement = document.getElementById("root");
if (!rootElement) {
    throw new Error("Root element not found");
}

const root = createRoot(rootElement);

// A damaged database or a failed migration (found by the startup guard in
// db_backup.rs) gets the recovery screen instead of the app, with store
// writes suspended so nothing is written over it.
void readStartupDbHealth().then((health) => {
    if (health) {
        suspendPersistence();
        root.render(
            <ErrorBoundary>
                <Suspense fallback={null}>
                    <DatabaseRecovery health={health} />
                </Suspense>
            </ErrorBoundary>
        );
        return;
    }
    root.render(
        <ErrorBoundary>
            <App />
            <GlobalLoader />
        </ErrorBoundary>
    );
});
