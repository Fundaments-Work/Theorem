import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
    AlertCircle,
    Download,
    ExternalLink,
    Headphones,
    Loader2,
    Trash2,
} from "lucide-react";
import { isTauriMobile } from "../../core/lib/env";
import { ConfirmDialog } from "../../ui";

interface TtsAssetStatus {
    name: string;
    installed: boolean;
    size_bytes: number;
}

interface TtsModelStatus {
    installed: boolean;
    voices: string[];
    assets: TtsAssetStatus[];
    missing_count: number;
    installed_bytes: number;
    dir: string;
    platform_supported: boolean;
}

interface TtsEngine {
    name: string;
    label: string;
    isDefault: boolean;
}

const COMPANION_APP_URL =
    "https://github.com/sapienskid/supertonic-android/releases/tag/v3.2.7-theorem.1";

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }
    if (bytes >= 1024 * 1024) {
        return `${Math.round(bytes / (1024 * 1024))} MB`;
    }
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
    return (
        <section className="bg-[var(--color-surface)]">
            <div className="border-b border-[var(--color-border-subtle)] px-5 py-3">
                <h2 className="font-sans text-[12px] font-semibold text-[color:var(--color-text-primary)]">{title}</h2>
                {description && (
                    <p className="mt-1 font-sans text-[11px] text-[color:var(--color-text-secondary)]">{description}</p>
                )}
            </div>
            <div className="px-5 py-4">{children}</div>
        </section>
    );
}

function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
    return (
        <div className="grid gap-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="w-full sm:flex-1 sm:pr-4">
                <span className="font-sans text-[12px] font-semibold text-[color:var(--color-text-primary)]">{label}</span>
                {description && (
                    <p className="mt-1 font-sans text-[11px] text-[color:var(--color-text-secondary)]">{description}</p>
                )}
            </div>
            <div className="w-full sm:w-auto sm:flex-shrink-0">{children}</div>
        </div>
    );
}

function DesktopNeuralVoice() {
    const [status, setStatus] = useState<TtsModelStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [downloading, setDownloading] = useState<{ name: string; percent: number } | null>(null);
    const [error, setError] = useState("");
    const [confirmRemove, setConfirmRemove] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const s = await invoke<TtsModelStatus>("tts_model_status");
            setStatus(s);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    useEffect(() => {
        const unlisten = listen<{ name: string; percent: number }>("tts-download-progress", (event) => {
            setDownloading((current) =>
                current && current.name === event.payload.name
                    ? { ...current, percent: event.payload.percent }
                    : current,
            );
        });
        return () => { void unlisten.then((fn) => fn()); };
    }, []);

    const downloadAll = useCallback(async () => {
        if (!status) return;
        setError("");
        const missing = status.assets.filter((a) => !a.installed);
        for (const asset of missing) {
            setDownloading({ name: asset.name, percent: 0 });
            try {
                await invoke("tts_model_download_asset", { name: asset.name });
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                setDownloading(null);
                await refresh();
                return;
            }
        }
        setDownloading(null);
        await refresh();
    }, [status, refresh]);

    const remove = useCallback(async () => {
        setConfirmRemove(false);
        setError("");
        try {
            await invoke("tts_model_remove");
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        await refresh();
    }, [refresh]);

    if (loading) {
        return (
            <Section title="Neural Voice" description="Offline neural text-to-speech for immersion reading">
                <div className="flex items-center gap-2 py-2 text-[color:var(--color-text-muted)]">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span className="text-[11px]">Checking installation…</span>
                </div>
            </Section>
        );
    }

    if (status && !status.platform_supported) {
        return (
            <Section title="Neural Voice" description="Offline neural text-to-speech for immersion reading">
                <p className="py-2 text-[11px] text-[color:var(--color-text-muted)]">
                    Neural voice is not available on this platform. Use a system text-to-speech voice instead.
                </p>
            </Section>
        );
    }

    const missingBytes = status
        ? status.assets.filter((a) => !a.installed).reduce((sum, a) => sum + a.size_bytes, 0)
        : 0;

    return (
        <Section
            title="Neural Voice"
            description="High-quality offline text-to-speech (Supertonic). Downloaded on demand — nothing ships inside the app."
        >
            {status?.installed ? (
                <>
                    <SettingRow
                        label="Installed"
                        description={`${formatBytes(status.installed_bytes)} at ${status.dir}`}
                    >
                        <button
                            onClick={() => setConfirmRemove(true)}
                            className="ui-btn-danger inline-flex items-center gap-1.5 text-[11px]"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            Remove
                        </button>
                    </SettingRow>
                    <p className="text-[11px] text-[color:var(--color-text-muted)]">
                        Immersion reading now uses the neural voice. Pick a voice and speed from the reader's
                        playback bar.
                    </p>
                </>
            ) : (
                <SettingRow
                    label="Download neural voice"
                    description={`≈${formatBytes(missingBytes)} one-time download (${status?.missing_count ?? 0} files). Playback falls back to your system voice until installed.`}
                >
                    <button
                        onClick={() => void downloadAll()}
                        disabled={downloading !== null}
                        className="ui-btn-primary inline-flex items-center gap-1.5 text-[11px] whitespace-nowrap"
                    >
                        {downloading ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                            <Download className="w-3.5 h-3.5" />
                        )}
                        {downloading ? `Downloading ${downloading.percent}%` : "Download"}
                    </button>
                </SettingRow>
            )}

            {downloading && (
                <div className="mt-3">
                    <div className="flex items-center justify-between text-[10px] text-[color:var(--color-text-muted)] mb-1">
                        <span className="truncate font-mono">{downloading.name}</span>
                        <span className="font-mono">{downloading.percent}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-[var(--color-surface-muted)] overflow-hidden">
                        <div
                            className="h-full rounded-full bg-[var(--color-accent)]"
                            style={{ width: `${downloading.percent}%` }}
                        />
                    </div>
                </div>
            )}

            {error && (
                <div className="mt-3 flex items-start gap-1.5 text-[11px] text-[color:var(--color-error)]">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
                    <span>{error}</span>
                </div>
            )}

            <ConfirmDialog
                isOpen={confirmRemove}
                title="Remove Neural Voice"
                message="This deletes the neural voice models and cached audio. You can download them again later."
                confirmLabel="Remove"
                variant="danger"
                onConfirm={() => void remove()}
                onCancel={() => setConfirmRemove(false)}
            />
        </Section>
    );
}

function AndroidEnginePicker() {
    const [engines, setEngines] = useState<TtsEngine[]>([]);
    const [currentEngine, setCurrentEngine] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const result = await invoke<{ enginesJson: string; currentEngine: string }>("tts_get_engines");
                if (cancelled) return;
                setEngines(JSON.parse(result.enginesJson || "[]"));
                setCurrentEngine(result.currentEngine || "");
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : String(e));
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const selectEngine = useCallback(async (engine: string) => {
        setBusy(true);
        setError("");
        try {
            await invoke("tts_set_engine", { engine });
            setCurrentEngine(engine);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, []);

    return (
        <Section
            title="Text-to-Speech Engine"
            description="Neural voice on Android comes from a companion TTS engine app you install once — Theorem then reads through it."
        >
            <SettingRow
                label="Voice engine"
                description={
                    engines.find((e) => e.name === currentEngine)?.label || currentEngine || "System default"
                }
            >
                <select
                    value={currentEngine}
                    disabled={busy || engines.length === 0}
                    onChange={(e) => void selectEngine(e.target.value)}
                    className="ui-input text-[11px] max-w-[220px]"
                >
                    {engines.length === 0 && <option value="">No engines found</option>}
                    {engines.map((engine) => (
                        <option key={engine.name} value={engine.name}>
                            {engine.label}{engine.isDefault ? " (default)" : ""}
                        </option>
                    ))}
                </select>
            </SettingRow>

            <SettingRow
                label="Theorem Neural Voice"
                description="Recommended: install our free companion engine app for fast, natural offline narration."
            >
                <button
                    onClick={() => {
                        void import("@tauri-apps/plugin-opener").then(
                            ({ openUrl }) => openUrl(COMPANION_APP_URL),
                            () => { /* opener unavailable */ },
                        );
                    }}
                    className="ui-btn-primary inline-flex items-center gap-1.5 text-[11px] whitespace-nowrap"
                >
                    <Headphones className="w-3.5 h-3.5" />
                    Get the app
                    <ExternalLink className="w-3 h-3" />
                </button>
            </SettingRow>

            {busy && (
                <div className="flex items-center gap-2 text-[11px] text-[color:var(--color-text-muted)]">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Switching engine…
                </div>
            )}

            {error && (
                <div className="mt-2 flex items-start gap-1.5 text-[11px] text-[color:var(--color-error)]">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
                    <span>{error}</span>
                </div>
            )}
        </Section>
    );
}

export function NeuralVoiceSection() {
    if (!isTauriMobile()) {
        return <DesktopNeuralVoice />;
    }
    return <AndroidEnginePicker />;
}

export default NeuralVoiceSection;
