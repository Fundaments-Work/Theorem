import { useUIStore } from "../../core/store";
import { PageLoader } from "./PageLoader";

export function GlobalLoader() {
    const isLoading = useUIStore((s) => s.isLoading);
    const message = useUIStore((s) => s.loadingMessage);

    if (!isLoading) {
        return null;
    }

    return <PageLoader message={message} className="fixed inset-0 z-[var(--z-sticky)]" />;
}
