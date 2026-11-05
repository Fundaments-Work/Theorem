import { useState } from "react";
import { FileText } from "lucide-react";
import { toast } from "sonner";
import { isTauri } from "../../core/lib/env";
import { exportLogs } from "../../core/lib/log-export";
import { HELP_ACTION_CLASS } from "./help-action-styles";

/**
 * Settings → Help & Diagnostics: saves the app's log files (plus version and platform,
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
            className={HELP_ACTION_CLASS}
        >
            <FileText className="w-4 h-4" />
            <span>{busy ? "Exporting logs..." : "Export Logs"}</span>
        </button>
    );
}
