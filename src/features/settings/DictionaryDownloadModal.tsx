import { useEffect, useRef, useState } from "react";
import { Download, Check, AlertCircle, X } from "lucide-react";
import { Modal, ModalHeader, ModalBody } from "../../ui";
import { cn } from "../../core/lib/utils";
import { isTauri } from "../../core/lib/env";
import { useVocabularyStore } from "../../core/store";

interface DictEntry {
    id: string;
    name: string;
    language: string;
    format: "mdx" | "stardict";
    url: string;
    sizeApprox: string;
    badge?: string;
}

const AVAILABLE_DICTS: DictEntry[] = [
    {
        id: "en-wiktionary-mdx",
        name: "English Wiktionary (MDict .mdx)",
        language: "en",
        format: "mdx",
        url: "https://github.com/fundaments-work/wiktionary-stardict/releases/download/en-latest/dict-en-en.mdx",
        sizeApprox: "~154 MB (1.35M words)",
        badge: "Recommended",
    },
    {
        id: "en-wiktionary-stardict",
        name: "English Wiktionary (StarDict .zip)",
        language: "en",
        format: "stardict",
        url: "https://github.com/fundaments-work/wiktionary-stardict/releases/download/en-latest/dict-en-en.zip",
        sizeApprox: "~127 MB (1.35M words)",
    },
];

interface DictionaryDownloadModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function DictionaryDownloadModal({ isOpen, onClose }: DictionaryDownloadModalProps) {
    const [error, setError] = useState<string | null>(null);
    const [justInstalled, setJustInstalled] = useState<Set<string>>(new Set());
    const [stage, setStage] = useState<string | null>(null);
    const installedDicts = useVocabularyStore((s) => s.installedDictionaries);
    const activeDownload = useVocabularyStore((s) => s.activeDownload);
    const setActiveDownload = useVocabularyStore((s) => s.setActiveDownload);
    const addInstalledDictionary = useVocabularyStore((s) => s.addInstalledDictionary);
    const abortRef = useRef<(() => void) | null>(null);
    const unlistenRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        if (!isOpen) {
            abortRef.current?.();
            abortRef.current = null;
            unlistenRef.current?.();
            unlistenRef.current = null;
            setStage(null);
            setActiveDownload(null);
        }
    }, [isOpen, setActiveDownload]);

    const handleCancel = () => {
        abortRef.current?.();
        abortRef.current = null;
        unlistenRef.current?.();
        unlistenRef.current = null;
        setStage(null);
        setActiveDownload(null);
    };

    const handleDownload = async (dict: DictEntry) => {
        if (!isTauri()) {
            setError("Dictionary download requires the desktop or mobile app.");
            return;
        }

        setStage("Downloading");
        setActiveDownload({ dictName: dict.name, progress: { percent: 0, downloaded: 0, total: 0 } });
        setError(null);

        try {
            const { invoke } = await import("@tauri-apps/api/core");
            const { listen } = await import("@tauri-apps/api/event");

            const unlisten = await listen<{ percent: number; downloaded: number; total: number }>(
                "dictionary-download-progress",
                (event) => {
                    setActiveDownload({
                        dictName: dict.name,
                        progress: {
                            percent: event.payload.percent,
                            downloaded: event.payload.downloaded,
                            total: event.payload.total,
                        },
                    });
                },
            );
            unlistenRef.current = unlisten;

            let aborted = false;
            abortRef.current = () => {
                aborted = true;
            };

            const result = await invoke<{
                id: string;
                name: string;
                language: string;
                sizeBytes: number;
            }>("download_and_extract_stardict", { url: dict.url });

            unlistenRef.current?.();
            unlistenRef.current = null;
            abortRef.current = null;

            if (aborted) {
                setActiveDownload(null);
                return;
            }

            setStage("Installing");
            addInstalledDictionary({
                id: result.id,
                name: result.name,
                language: result.language,
                format: dict.format,
                sizeBytes: result.sizeBytes,
                importedAt: new Date(),
            });
            setJustInstalled((prev) => new Set([...prev, dict.id]));
            setActiveDownload(null);
        } catch (err) {
            unlistenRef.current?.();
            unlistenRef.current = null;
            abortRef.current = null;
            const message = err instanceof Error ? err.message : (typeof err === "string" ? err : JSON.stringify(err));
            setError(message || "Download failed");
            setActiveDownload(null);
        } finally {
            setStage(null);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="md">
            <ModalHeader title="Download Dictionary" onClose={onClose} />
            <ModalBody>
                {error && (
                    <div className="flex items-start gap-2 p-3 mb-4 border border-[color:color-mix(in_srgb,var(--color-error)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--color-error)_8%,transparent)]">
                        <AlertCircle className="w-4 h-4 text-[color:var(--color-error)] shrink-0 mt-0.5" />
                        <p className="text-sm text-[color:var(--color-error)]">{error}</p>
                    </div>
                )}

                <p className="text-sm text-[color:var(--color-text-secondary)] mb-4">
                    One-click install of free dictionaries for offline word lookup.
                </p>

                <div className="space-y-3">
                    {AVAILABLE_DICTS.map((dict) => {
                        const isInstalled = justInstalled.has(dict.id)
                            || installedDicts.some(
                                (d) =>
                                    d.format === dict.format
                                    || (dict.format === "mdx" && d.name.toLowerCase().includes("mdx"))
                                    || (dict.format === "stardict" && (d.format === "stardict" || !d.format) && !d.name.toLowerCase().includes("mdx")),
                            );
                        const isDownloading = activeDownload?.dictName === dict.name;

                        return (
                            <div
                                key={dict.id}
                                className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 border border-[var(--color-border)] bg-[var(--color-surface)]"
                            >
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <p className="font-semibold text-sm text-[color:var(--color-text-primary)]">
                                            {dict.name}
                                        </p>
                                        {dict.badge && (
                                            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 border border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[color:var(--color-text-secondary)]">
                                                {dict.badge}
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-xs text-[color:var(--color-text-muted)] mt-1">
                                        {dict.language.toUpperCase()} — {dict.sizeApprox}
                                    </p>
                                </div>
                                {isDownloading && activeDownload ? (
                                    <div className="flex items-center gap-2 w-full sm:w-auto">
                                        <div className="flex-1 sm:w-36 flex flex-col gap-1">
                                            <div className="flex items-center justify-between text-xs text-[color:var(--color-text-muted)]">
                                                <span>{stage ?? "Downloading"}</span>
                                                <span>{activeDownload.progress.percent}%</span>
                                            </div>
                                            <div className="w-full h-2 bg-[var(--color-surface-muted)] overflow-hidden">
                                                <div
                                                    className="h-full bg-[var(--color-accent)] transition-all duration-150"
                                                    style={{ width: `${activeDownload.progress.percent}%` }}
                                                />
                                            </div>
                                        </div>
                                        <button
                                            onClick={handleCancel}
                                            className="p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-error)] hover:bg-[var(--color-surface-muted)] transition-colors touch-manipulation"
                                            title="Cancel download"
                                        >
                                            <X className="w-4 h-4" />
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        onClick={() => handleDownload(dict)}
                                        disabled={activeDownload !== null || isInstalled}
                                        className={cn(
                                            "inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold shrink-0 border transition-all duration-150 touch-manipulation whitespace-nowrap",
                                            "w-full sm:w-auto",
                                            isInstalled
                                                ? "border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[color:var(--color-text-muted)] cursor-default opacity-80"
                                                : "bg-[var(--color-accent)] text-[var(--color-accent-contrast)] border-transparent hover:bg-[var(--color-accent-hover)] active:scale-[0.98]",
                                            activeDownload !== null && !isDownloading && "opacity-50 cursor-not-allowed",
                                        )}
                                    >
                                        {isInstalled ? (
                                            <>
                                                <Check className="w-3.5 h-3.5 text-[color:var(--color-success)]" />
                                                Installed
                                            </>
                                        ) : (
                                            <>
                                                <Download className="w-3.5 h-3.5" />
                                                Install
                                            </>
                                        )}
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
            </ModalBody>
        </Modal>
    );
}
