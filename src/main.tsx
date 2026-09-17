import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./shell";
import { GlobalLoader } from "./ui";
import { initSentry } from "./core/lib/sentry";
import "./index.css";

void initSentry(import.meta.env.VITE_SENTRY_DSN as string | undefined, import.meta.env.MODE);

const rootElement = document.getElementById("root");
if (!rootElement) {
    throw new Error("Root element not found");
}

const root = createRoot(rootElement);
root.render(
    <ErrorBoundary>
        <App />
        <GlobalLoader />
    </ErrorBoundary>
);
