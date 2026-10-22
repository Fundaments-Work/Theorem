import { useState } from "react";
import { FileText } from "lucide-react";
import { toast } from "sonner";
import { isTauri } from "../../core/lib/env";
import { exportLogs } from "../../core/lib/log-export";

/**
 * Settings → About: saves the app's log files (plus version and platform,
 * nothing else) as a zip to attach to a bug report.
 */
export function ExportLogsButton() {
    const [busy, setBusy] = useState(false);
    if (!isTauri()) return null;

    const handleClick = async () => {
        setBusy(true);
        try {
            const result = await exportLogs();
            if (result.ok) {
                toast.success(result.message ?? "Logs exported");
            } else if (result.message !== "Save cancelled") {
                toast.error(result.message ?? "Could not export logs");
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <button
            type="button"
            onClick={() => void handleClick()}
            disabled={busy}
            title="Save the app's log files to attach to a bug report. They hold no books or notes."
            className="flex items-center gap-2 p-3 w-full border border-[var(--color-border)] text-[12px] text-[color:var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors disabled:opacity-50"
        >
            <FileText className="w-4 h-4" />
            <span>{busy ? "Exporting logs..." : "Export Logs"}</span>
        </button>
    );
}
