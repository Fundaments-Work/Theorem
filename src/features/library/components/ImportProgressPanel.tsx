import { useState } from "react";
import { useImportStore, type ImportStage } from "../../../core/store";
import { resumeNativeImport, stopNativeImport, discardNativeImport } from "../../../core/lib/native-import-jobs";

const labels: Record<ImportStage, string> = {
    copying: "Copying", checking: "Checking", preparing: "Preparing archive", metadata: "Extracting metadata", saving: "Saving",
};
export function formatImportBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value.toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`;
}

export default function ImportProgressPanel() {
    const snapshot = useImportStore((state) => state.snapshot);
    const error = useImportStore((state) => state.error);
    const [dismissedId, setDismissedId] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const [operationError, setOperationError] = useState<string | null>(null);
    if (!error && !operationError && (!snapshot?.id || (!snapshot.active && !snapshot.resumable && (!snapshot.errors.length || dismissedId === snapshot.id)))) return null;
    const current = snapshot?.current;
    const total = current?.totalBytes;
    const measured = typeof total === "number" && total > 0 && Number.isFinite(total);
    const completed = measured ? Math.min(total, Math.max(0, current?.completedBytes ?? 0)) : 0;
    const label = current?.stage ? labels[current.stage] : snapshot?.resumable ? "Import interrupted" : "Import";
    const act = async (operation: () => Promise<void>) => {
        setPending(true);
        setOperationError(null);
        try { await operation(); } catch (failure) { setOperationError(String(failure)); }
        finally { setPending(false); }
    };
    return <section role="region" aria-label="Import progress" className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 sm:px-6">
        {(error || operationError) && <p role="alert" className="text-sm text-[color:var(--color-text-primary)]">{error || operationError}</p>}
        {snapshot?.id && <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
                <p role="status" className="min-w-0 flex-1 truncate">{label}{current?.name ? `: ${current.name}` : ""}</p>
                <span>{snapshot?.completed} / {snapshot?.total} files</span>
                {!!snapshot?.errors.length && <span role="alert">{snapshot.errors.length} import errors</span>}
                {snapshot?.active && <button type="button" disabled={pending} onClick={() => { void act(stopNativeImport); }} className="text-[color:var(--color-accent)] disabled:opacity-50">Stop import</button>}
                {snapshot?.resumable && <button type="button" disabled={pending} onClick={() => { void act(resumeNativeImport); }} className="text-[color:var(--color-accent)] disabled:opacity-50">Resume import</button>}
                {snapshot?.resumable && <button type="button" disabled={pending} onClick={() => { void act(discardNativeImport); }} className="text-[color:var(--color-accent)] disabled:opacity-50">Discard pending import</button>}
                {!snapshot?.active && !snapshot?.resumable && <button type="button" onClick={() => setDismissedId(snapshot?.id ?? null)} className="text-[color:var(--color-accent)]">Dismiss</button>}
            </div>
            {snapshot?.active && <progress aria-label={`${label} progress`} {...(measured ? { value: completed, max: total } : {})} className="mt-2 h-1 w-full accent-[var(--color-accent)]" />}
            <details className="mt-1 max-h-[30vh] overflow-y-auto overscroll-contain text-xs text-[color:var(--color-text-secondary)] [content-visibility:auto]">
                <summary className="cursor-pointer">Import details</summary>
                {snapshot?.active && (current?.stage === "copying" || current?.stage === "checking"
                    ? <p>{formatImportBytes(current.completedBytes)}{measured ? ` of ${formatImportBytes(total)}` : " processed; total unknown"}</p>
                    : <p>Progress for this stage is indeterminate.</p>)}
                <p>{snapshot?.imported} saved, {snapshot?.duplicates} already in Library. A file is complete after its metadata is saved.</p>
                {snapshot?.resumable && <p>Resume restarts the interrupted file and skips books already saved.</p>}
                {snapshot?.errors.map((failure, index) => <p key={`${failure.source}-${index}`} role="alert">{failure.source}: {failure.message}</p>)}
            </details>
        </>}
    </section>;
}
