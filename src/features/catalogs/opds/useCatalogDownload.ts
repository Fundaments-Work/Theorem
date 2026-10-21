import { useCallback, useState } from "react";
import { toast } from "sonner";
import { OpdsService, describeOpdsError } from "../../../core/services/OpdsService";
import { useUIStore } from "../../../core/store";
import type { OpdsCredentials, OpdsEntry } from "../../../core/types";
import { formatBytes } from "./opds-ui-utils";

/**
 * "Add to Library" for catalog entries, shared by the Discover and catalog cards and the detail
 * sheet so progress, errors and the success toast read the same everywhere.
 */
export function useCatalogDownload(auth?: OpdsCredentials) {
    const setRoute = useUIStore((state) => state.setRoute);
    const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());

    const download = useCallback(
        async (entry: OpdsEntry): Promise<boolean> => {
            if (busy.has(entry.id)) return false;
            setBusy((prev) => new Set(prev).add(entry.id));
            const toastId = toast.loading(`Adding "${entry.title}"…`);
            try {
                // Partial entries (downloads one click deeper) are resolved first.
                let full = entry;
                if (entry.primary === undefined && entry.detailHref) {
                    toast.loading("Finding the download…", { id: toastId });
                    full = await OpdsService.loadDetail(entry, auth);
                }
                const acquisition = full.primary !== undefined ? full.acquisitions[full.primary] : undefined;
                if (!acquisition) throw new Error("There is no direct download for this book.");
                await OpdsService.download(acquisition, {
                    auth,
                    onProgress: (received, total) => {
                        const label = total ? `${Math.round((received / total) * 100)}% of ${formatBytes(total)}` : formatBytes(received);
                        toast.loading(`Adding "${entry.title}" · ${label}`, { id: toastId });
                    },
                });
                toast.success(`"${entry.title}" is in your Library`, {
                    id: toastId,
                    action: { label: "Open Library", onClick: () => setRoute("library") },
                });
                return true;
            } catch (error) {
                toast.error(describeOpdsError(error), { id: toastId });
                return false;
            } finally {
                setBusy((prev) => {
                    const next = new Set(prev);
                    next.delete(entry.id);
                    return next;
                });
            }
        },
        [auth, busy, setRoute],
    );

    return { download, isBusy: (id: string) => busy.has(id) };
}

