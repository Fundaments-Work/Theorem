
import { useRef, useState, useEffect, memo, lazy, Suspense, type ChangeEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PageHeader } from "../../ui";
import { cn, formatFileSize } from "../../core/lib/utils";
import { isMobile, isTauri, isTauriDesktop } from "../../core/lib/env";
import { getAllShortcuts, formatShortcutKeys } from "../../core/lib/keyboard-shortcuts";
import {
    showOpenDirectoryDialog,
    showSaveFileDialog,
} from "../../core/lib/dialogs";
import { ConfirmDialog, AlertDialog } from "../../ui";
import { syncVaultMarkdownSnapshot } from "../../core/lib/vault-sync";
import { exportUnifiedSyncBundle, estimateSyncBundleSizeBytes } from "../../core/lib/sync-bundle";

import {
    useVocabularyStore,
    useLibraryStore,
    useRssStore,
    useSettingsStore,
    useUIStore,
} from "../../core/store";
import { clearAllApplicationStorage, getRssStorageStats } from "../../core/lib/storage-manager";
const DeviceSyncSection = lazy(() => import("./DeviceSync").then(m => ({ default: m.DeviceSyncSection })));
const NeuralVoiceSection = lazy(() => import("./NeuralVoiceSection").then(m => ({ default: m.NeuralVoiceSection })));
import { DictionaryDownloadModal } from "./DictionaryDownloadModal";
import {
    Database,
    RotateCcw,
    Trash2,
    AlertTriangle,
    ChevronRight,
    FolderOpen,
    BookOpen,
    Languages,
    Rss,
    Download,
    Globe,
    WifiOff,
    Sun,
    Target,
    AlertCircle,
    Keyboard,
    RefreshCw,
    Terminal,
} from "lucide-react";

type SettingsTab = "general" | "dictionary" | "integrations" | "storage" | "shortcuts" | "about";
const SETTINGS_TAB_SESSION_KEY = "theorem-settings:active-tab";
const SETTINGS_FOCUS_SECTION_SESSION_KEY = "theorem-settings:focus-section";

type PersistableStore = {
    persist?: {
        clearStorage?: () => void | Promise<void>;
    };
};

interface SectionProps {
    title: string;
    description?: string;
    icon: React.ReactNode;
    children: React.ReactNode;
}

function Section({ title, description, icon, children }: SectionProps) {
    return (
        <section className="bg-[var(--color-surface)]">
            <div className="border-b border-[var(--color-border-subtle)] px-5 py-3">
                {icon && <span className="sr-only">{icon}</span>}
                <h2 className="font-sans text-[12px] font-semibold text-[color:var(--color-text-primary)]">
                    {title}
                </h2>
                {description && (
                    <p className="mt-1 font-sans text-[11px] text-[color:var(--color-text-secondary)]">
                        {description}
                    </p>
                )}
            </div>
            <div className="px-5 py-4">{children}</div>
        </section>
    );
}

interface SettingRowProps {
    label: string;
    description?: string;
    htmlFor?: string;
    children: React.ReactNode;
}

function SettingRow({ label, description, htmlFor, children }: SettingRowProps) {
    return (
        <div className="grid gap-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="w-full sm:flex-1 sm:pr-4">
                <label htmlFor={htmlFor} className="font-sans text-[12px] font-semibold text-[color:var(--color-text-primary)]">
                    {label}
                </label>
                {description && (
                    <p className="mt-1 font-sans text-[11px] text-[color:var(--color-text-secondary)]">
                        {description}
                    </p>
                )}
            </div>
            <div className="w-full sm:w-auto sm:flex-shrink-0">{children}</div>
        </div>
    );
}

function normalizeHighlightsExportName(value: string): string {
    return value.replace(/\.md$/i, "").trim();
}

function Toggle({
    checked,
    onChange,
}: {
    checked: boolean;
    onChange: (checked: boolean) => void;
}) {
    return (
        <div className="inline-flex border border-[var(--color-border)] bg-[var(--color-surface)]">
            <button
                onClick={() => onChange(true)}
                className={cn(
                    "px-3 py-2 font-sans text-[11px] font-medium",
                    checked
                        ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)]"
                        : "text-[color:var(--color-text-secondary)]"
                )}
            >
                On
            </button>
            <button
                onClick={() => onChange(false)}
                className={cn(
                    "border-l border-[var(--color-border)] px-3 py-2 font-sans text-[11px] font-medium",
                    !checked
                        ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)]"
                        : "text-[color:var(--color-text-secondary)]"
                )}
            >
                Off
            </button>
        </div>
    );
}

function ButtonSelect<T extends string>({
    options,
    value,
    onChange,
}: {
    options: { value: T; label: string }[];
    value: T;
    onChange: (value: T) => void;
}) {
    return (
        <div className="flex flex-wrap items-center gap-2">
            {options.map((opt) => (
                <button
                    key={opt.value}
                    onClick={() => onChange(opt.value)}
                    className={cn(
                        "border border-[var(--color-border)] px-3 py-2 font-sans text-[11px] font-medium transition-colors",
                        value === opt.value
                            ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)]"
                            : "bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
                    )}
                >
                    {opt.label}
                </button>
            ))}
        </div>
    );
}

const StorageTab = memo(function StorageTab({ onClearData, onExportData }: { onClearData: () => void; onExportData: () => void }) {
    const books = useLibraryStore((s) => s.books);
    const annotations = useLibraryStore((s) => s.annotations);
    const installedDictionaries = useVocabularyStore((s) => s.installedDictionaries);
    const [rssStats, setRssStats] = useState<{ articleCount: number; totalSize: number }>({ articleCount: 0, totalSize: 0 });

    useEffect(() => {
        getRssStorageStats().then(setRssStats);
    }, []);

    const downloadedBooks = books.filter((b) => !b.syncedWithoutFile);
    const syncOnlyCount = books.length - downloadedBooks.length;
    const totalStorage = downloadedBooks.reduce((acc, b) => acc + b.fileSize, 0);
    const offlineDictionarySize = installedDictionaries.reduce((acc, d) => acc + d.sizeBytes, 0);

    return (
        <div className="space-y-8">
            <Section
                title="Storage Usage"
                description="Manage your data and storage"
                icon={<Database className="w-5 h-5" />}
            >
                <div className="space-y-4">
                    <div className="flex items-center justify-between p-4 bg-[var(--color-surface-muted)]">
                        <div className="flex items-center gap-3">
                            <BookOpen className="w-5 h-5 text-[color:var(--color-text-muted)]" />
                            <div>
                                <p className="font-medium text-sm text-[color:var(--color-text-primary)]">Books</p>
                                <p className="text-xs text-[color:var(--color-text-muted)]">
                                    {downloadedBooks.length} {downloadedBooks.length === 1 ? "book" : "books"}
                                    {syncOnlyCount > 0 && <> • {syncOnlyCount} sync-only</>}
                                </p>
                                {syncOnlyCount > 0 && (
                                    <p className="text-xs text-[color:var(--color-text-muted)] mt-0.5">
                                        {syncOnlyCount} {syncOnlyCount === 1 ? "book is" : "books are"} synced from another device but not downloaded yet
                                    </p>
                                )}
                            </div>
                        </div>
                        <span className="text-sm font-medium text-[color:var(--color-text-primary)]">
                            {formatFileSize(totalStorage)}
                        </span>
                    </div>

                    <div className="flex items-center justify-between p-4 bg-[var(--color-surface-muted)]">
                        <div className="flex items-center gap-3">
                            <FolderOpen className="w-5 h-5 text-[color:var(--color-text-muted)]" />
                            <div>
                                <p className="font-medium text-sm text-[color:var(--color-text-primary)]">Highlights & Notes</p>
                                <p className="text-xs text-[color:var(--color-text-muted)]">
                                    {annotations.length} {annotations.length === 1 ? "annotation" : "annotations"}
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center justify-between p-4 bg-[var(--color-surface-muted)]">
                        <div className="flex items-center gap-3">
                            <Rss className="w-5 h-5 text-[color:var(--color-text-muted)]" />
                            <div>
                                <p className="font-medium text-sm text-[color:var(--color-text-primary)]">RSS Articles</p>
                                <p className="text-xs text-[color:var(--color-text-muted)]">
                                    {rssStats.articleCount} {rssStats.articleCount === 1 ? "article" : "articles"} cached
                                </p>
                            </div>
                        </div>
                        <span className="text-sm font-medium text-[color:var(--color-text-primary)]">
                            {formatFileSize(rssStats.totalSize)}
                        </span>
                    </div>

                    <div className="flex items-center justify-between p-4 bg-[var(--color-surface-muted)]">
                        <div className="flex items-center gap-3">
                            <Languages className="w-5 h-5 text-[color:var(--color-text-muted)]" />
                            <div>
                                <p className="font-medium text-sm text-[color:var(--color-text-primary)]">Offline Dictionaries</p>
                                <p className="text-xs text-[color:var(--color-text-muted)]">
                                    {installedDictionaries.length > 0
                                        ? `${installedDictionaries.length} installed`
                                        : "None installed"}
                                </p>
                            </div>
                        </div>
                        <span className="text-sm font-medium text-[color:var(--color-text-primary)]">
                            {formatFileSize(offlineDictionarySize)}
                        </span>
                    </div>
                </div>
            </Section>

            <Section
                title="Data Management"
                description="Clear app data or create a backup file"
                icon={<Trash2 className="w-5 h-5" />}
            >
                <div className="space-y-3">
                    <button
                        onClick={onClearData}
                        className={cn(
                            "w-full flex items-center gap-3 p-4",
                            "border border-[var(--color-error)]/20",
                            "text-[color:var(--color-error)] hover:bg-[var(--color-error)]/5",
                            "transition-colors text-left"
                        )}
                    >
                        <AlertTriangle className="w-5 h-5" />
                        <div className="flex-1">
                            <p className="font-medium text-sm">Clear All Data</p>
                            <p className="text-xs opacity-80">
                                Delete all books, highlights, vocabulary, and settings. This cannot be undone.
                            </p>
                        </div>
                        <ChevronRight className="w-4 h-4" />
                    </button>

                    <button
                        onClick={onExportData}
                        className={cn(
                            "w-full flex items-center gap-3 p-4",
                            "border border-[var(--color-border)]",
                            "text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)]",
                            "transition-colors text-left"
                        )}
                    >
                        <Download className="w-5 h-5" />
                        <div className="flex-1">
                            <p className="font-medium text-sm">Create Backup File</p>
                            <p className="text-xs text-[color:var(--color-text-muted)]">
                                Save a full backup bundle with books, highlights, vocabulary, RSS, and dictionaries
                            </p>
                        </div>
                        <ChevronRight className="w-4 h-4" />
                    </button>
                </div>
            </Section>
        </div>
    );
});

export const SettingsPage = memo(function SettingsPage() {
    const settings = useSettingsStore((state) => state.settings);
    const updateSettings = useSettingsStore((state) => state.updateSettings);
    const updateVocabularySettings = useSettingsStore((state) => state.updateVocabularySettings);
    const updateTtsSettings = useSettingsStore((state) => state.updateTtsSettings);
    const resetSettings = useSettingsStore((state) => state.resetSettings);
    const stats = useSettingsStore((state) => state.stats);
    const updateStats = useSettingsStore((state) => state.updateStats);
    const highlightsExportName = normalizeHighlightsExportName(settings.vault.highlightsFileName);
    const isMobilePlatform = isMobile();
    const isLinuxDesktop = isTauriDesktop() && navigator.userAgent.includes("Linux");
    const setVaultSyncStatus = useUIStore((state) => state.setVaultSyncStatus);
    const vaultSyncStatus = useUIStore((state) => state.vaultSyncStatus);
    const vaultSyncMessage = useUIStore((state) => state.vaultSyncMessage);
    const vaultSyncAt = useUIStore((state) => state.vaultSyncAt);
    const importStarDict = useVocabularyStore((state) => state.importStarDict);
    const removeDictionary = useVocabularyStore((state) => state.removeDictionary);
    const installedDictionaries = useVocabularyStore((state) => state.installedDictionaries);
    const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
        if (typeof window === "undefined") {
            return "general";
        }
        const persisted = window.sessionStorage.getItem(SETTINGS_TAB_SESSION_KEY);
        if (
            persisted === "general" ||
            persisted === "dictionary" ||
            persisted === "integrations" ||
            persisted === "storage" ||
            persisted === "shortcuts" ||
            persisted === "about"
        ) {
            return persisted;
        }
        return "general";
    });

    const [visitedTabs, setVisitedTabs] = useState<Set<SettingsTab>>(
        () => new Set([activeTab]),
    );
    useEffect(() => {
        setVisitedTabs((prev) => (prev.has(activeTab) ? prev : new Set([...prev, activeTab])));
    }, [activeTab]);

    const dictionaryFileInputRef = useRef<HTMLInputElement>(null);
    const [showDictDownloadModal, setShowDictDownloadModal] = useState(false);
    const [dictionaryRemovedName, setDictionaryRemovedName] = useState<string | null>(null);
    const [showResetConfirm, setShowResetConfirm] = useState(false);
    const [showClearDataConfirm, setShowClearDataConfirm] = useState(false);
    const [removeDictionaryInfo, setRemoveDictionaryInfo] = useState<{ id: string; name: string } | null>(null);
    const [alertInfo, setAlertInfo] = useState<{ title: string; message: string } | null>(null);
    const [updateChecking, setUpdateChecking] = useState(false);
    const [updateInfo, setUpdateInfo] = useState<{ version: string; body: string } | null>(null);
    const [cliStatus, setCliStatus] = useState<{ installed: boolean; linkPath: string; isAppImage: boolean } | null>(null);
    const [cliBusy, setCliBusy] = useState(false);
    const cliEnabled = settings.cli?.enabled ?? false;
    // Compile-time stamp of the binary (build.rs) — makes a stale release
    // build (UI embedded at compile time) visible at a glance.
    const [buildInfo, setBuildInfo] = useState<{ buildDate: string; gitHash: string } | null>(null);

    useEffect(() => {
        if (!isTauri()) return;
        invoke<{ build_date: string; git_hash: string }>("app_build_info")
            .then((info) => setBuildInfo({ buildDate: info.build_date, gitHash: info.git_hash }))
            .catch(() => { /* non-Tauri or older binary without the stamp */ });
    }, []);

    useEffect(() => {
        if (!dictionaryRemovedName) return;
        const timer = setTimeout(() => setDictionaryRemovedName(null), 3000);
        return () => clearTimeout(timer);
    }, [dictionaryRemovedName]);

    const refreshCliStatus = async () => {
        try {
            setCliStatus(await invoke<{ installed: boolean; linkPath: string; isAppImage: boolean }>("cli_setup_status"));
        } catch {
            setCliStatus(null);
        }
    };

    useEffect(() => {
        if (!isLinuxDesktop) return;
        void refreshCliStatus();
    }, [isLinuxDesktop]);

    const handleToggleCli = async (enabled: boolean) => {
        setCliBusy(true);
        try {
            if (enabled) {
                await invoke<string>("setup_linux_cli_symlink");
            } else {
                await invoke("remove_linux_cli_symlink");
            }
            updateSettings({ cli: { enabled } });
            void refreshCliStatus();
        } catch (error) {
            setAlertInfo({
                title: enabled ? "CLI Setup Failed" : "CLI Removal Failed",
                message: String(error),
            });
        } finally {
            setCliBusy(false);
        }
    };

    const handleRepairCli = async () => {
        setCliBusy(true);
        try {
            await invoke<string>("setup_linux_cli_symlink");
            void refreshCliStatus();
        } catch (error) {
            setAlertInfo({
                title: "CLI Repair Failed",
                message: String(error),
            });
        } finally {
            setCliBusy(false);
        }
    };

    const deviceSyncSectionRef = useRef<HTMLDivElement | null>(null);
    const markdownExportSectionRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }
        window.sessionStorage.setItem(SETTINGS_TAB_SESSION_KEY, activeTab);
    }, [activeTab]);

    useEffect(() => {
        if (!isTauri()) return;
        let unlisten: (() => void) | undefined;

        (async () => {
            const { listen } = await import("@tauri-apps/api/event");
            unlisten = await listen<{ percent: number; downloaded: number; total: number }>(
                "dictionary-download-progress",
                (event) => {
                    useVocabularyStore.getState().setDownloadProgress(event.payload);
                },
            );
        })();

        return () => {
            unlisten?.();
        };
    }, []);

    useEffect(() => {
        if (typeof window === "undefined" || activeTab !== "integrations") {
            return;
        }

        const requestedFocus = window.sessionStorage.getItem(
            SETTINGS_FOCUS_SECTION_SESSION_KEY,
        );
        if (
            requestedFocus !== "device-sync" &&
            requestedFocus !== "markdown-export"
        ) {
            return;
        }

        const targetRef = requestedFocus === "device-sync"
            ? deviceSyncSectionRef
            : markdownExportSectionRef;

        window.sessionStorage.removeItem(SETTINGS_FOCUS_SECTION_SESSION_KEY);
        window.requestAnimationFrame(() => {
            targetRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
    }, [activeTab]);

    const handleClearData = () => {
        setShowClearDataConfirm(true);
    };

    const handleClearDataConfirm = async () => {
        setShowClearDataConfirm(false);
        try {
            await clearAllApplicationStorage();

            const storesToClear: PersistableStore[] = [
                useSettingsStore as unknown as PersistableStore,
                useLibraryStore as unknown as PersistableStore,
                useVocabularyStore as unknown as PersistableStore,
                useRssStore as unknown as PersistableStore,
            ];

            await Promise.allSettled(
                storesToClear.map(async (store) => {
                    try {
                        await store.persist?.clearStorage?.();
                    } catch (error) {
                    }
                }),
            );

            window.location.reload();
        } catch (error) {
        }
    };

    const handleCheckForUpdates = async () => {
        if (!isTauriDesktop()) {
            setAlertInfo({ title: "Not Available", message: "Updates can only be checked from the desktop app." });
            return;
        }
        setUpdateChecking(true);
        setUpdateInfo(null);
        try {
            const { check } = await import("@tauri-apps/plugin-updater");
            const update = await check();
            if (update) {
                setUpdateInfo({ version: update.version, body: update.body || "" });
            } else {
                setAlertInfo({ title: "Up to Date", message: `Theorem ${__APP_VERSION__} is the latest version.` });
            }
        } catch (e) {
            setAlertInfo({ title: "Update Check Failed", message: String(e) });
        } finally {
            setUpdateChecking(false);
        }
    };

    const handleInstallUpdate = async () => {
        if (!isTauriDesktop() || !updateInfo) return;
        try {
            const { check } = await import("@tauri-apps/plugin-updater");
            const update = await check();
            if (update) {
                await update.downloadAndInstall(() => {});
                setAlertInfo({ title: "Update Installed", message: "Please restart Theorem to apply the update." });
                setUpdateInfo(null);
            }
        } catch (e) {
            setAlertInfo({ title: "Update Failed", message: String(e) });
        }
    };

    const updateVaultSettings = (updates: Partial<typeof settings.vault>) => {
        const nextVault = {
            ...settings.vault,
            ...updates,
        };
        const hasVaultPath = nextVault.vaultPath.trim().length > 0;

        if (!("enabled" in updates)) {
            nextVault.enabled = hasVaultPath;
        }
        if (!hasVaultPath) {
            nextVault.enabled = false;
        }
        nextVault.autoExportHighlights = true;

        updateSettings({
            vault: nextVault,
        });
    };

    const handlePickVaultDirectory = async () => {
        if (isMobilePlatform) {
            setAlertInfo({ title: "Not Available", message: "Folder selection is not supported on mobile. Configure the export folder on desktop." });
            return;
        }

        const selectedPath = await showOpenDirectoryDialog({
            title: "Choose Export Folder",
            defaultPath: settings.vault.vaultPath || undefined,
        });

        if (!selectedPath) {
            return;
        }

        updateVaultSettings({
            enabled: true,
            vaultPath: selectedPath,
        });
    };

    const handleDictionaryImport = async (event: ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (!files || files.length === 0) {
            return;
        }

        try {
            await importStarDict(files);
        } catch (error) {
            setAlertInfo({ title: "Import Error", message: error instanceof Error ? error.message : "Failed to import dictionary files." });
        } finally {
            event.target.value = "";
        }
    };

    const handleExportMarkdownNow = async () => {
        if (!settings.vault.vaultPath.trim()) {
            setVaultSyncStatus("idle", "Set an export folder first.");
            return;
        }

        setVaultSyncStatus("syncing", "STATUS: SYNCING_MARKDOWN_EXPORT");
        const normalizedVaultSettings = {
            ...settings.vault,
            enabled: settings.vault.vaultPath.trim().length > 0,
            autoExportHighlights: true,
        };
        const libraryState = useLibraryStore.getState();
        const vocabularyState = useVocabularyStore.getState();
        const rssState = useRssStore.getState();
        const result = await syncVaultMarkdownSnapshot({
            books: libraryState.books,
            annotations: libraryState.annotations,
            rssArticles: rssState.articles,
            vocabularyTerms: vocabularyState.vocabularyTerms,
            settings: normalizedVaultSettings,
        });

        if (result.status === "synced") {
            setVaultSyncStatus("synced", result.message, new Date().toISOString());
            return;
        }

        if (result.status === "error") {
            setVaultSyncStatus("error", result.message);
            return;
        }

        setVaultSyncStatus("idle", result.message);
    };

    const handleExportData = async () => {
        try {
            const { bundle, warnings } = await exportUnifiedSyncBundle();
            const bundleSize = estimateSyncBundleSizeBytes(bundle);
            const payload = JSON.stringify(bundle, null, 2);
            const defaultFileName = `theorem-sync-${new Date().toISOString().slice(0, 10)}.json`;

            const saveViaTauri = async () => {
                const outputPath = await showSaveFileDialog({
                    title: "Save Theorem Backup",
                    defaultPath: defaultFileName,
                    filters: [{ name: "JSON", extensions: ["json"] }],
                });

                if (!outputPath) return false;

                const { writeTextFile } = await import("@tauri-apps/plugin-fs");
                await writeTextFile(outputPath, payload);
                return true;
            };

            let saved = false;
            if (isTauriDesktop()) {
                try {
                    saved = await saveViaTauri();
                } catch {
                    
                }
            }

            if (!saved) {
                const blob = new Blob([payload], { type: "application/json" });
                const objectUrl = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = objectUrl;
                link.download = defaultFileName;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(objectUrl);
            }

            const warningSuffix = warnings.length > 0
                ? ` Warnings: ${warnings.length} missing binary item(s).`
                : "";
            setAlertInfo({ title: "Backup Saved", message: `Backup saved (${formatFileSize(bundleSize)}).${warningSuffix}` });
        } catch (error) {
            setAlertInfo({ title: "Backup Error", message: error instanceof Error ? error.message : "Failed to save backup." });
        }
    };

    const tabButtons = [
        { id: "general" as const, label: "General" },
        { id: "dictionary" as const, label: "Dictionary" },
        { id: "integrations" as const, label: "Devices & Export" },
        { id: "storage" as const, label: "Data & Storage" },
        { id: "shortcuts" as const, label: "Shortcuts" },
        { id: "about" as const, label: "About" },
    ];

    return (
        <>
        <div className="mx-auto w-full max-w-[var(--layout-content-max-width)] px-4 py-6 pb-0 sm:px-6 lg:px-8 lg:py-8 animate-fade-in">
            
            <PageHeader
                title="Settings"
                description="Customize your reading experience"
            />

            <div className="mb-8 space-y-3">
                <div className="sm:hidden -mx-1 px-1">
                    <div className="flex gap-2 overflow-x-auto pb-1">
                        {tabButtons.map((tab) => (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={cn(
                                    "flex min-w-[10rem] items-center justify-center border border-[var(--color-border)] px-3 py-2.5 font-sans text-[11px] font-medium transition-colors",
                                    activeTab === tab.id
                                        ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)]"
                                        : "bg-[var(--color-surface)] text-[color:var(--color-text-secondary)]"
                                )}
                            >
                                <span className="truncate">{tab.label}</span>
                            </button>
                        ))}
                    </div>
                </div>

                <div className="hidden sm:flex items-center gap-1 w-fit flex-wrap">
                    {tabButtons.map((tab) => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={cn(
                                "flex items-center border border-[var(--color-border)] px-4 py-2 font-sans text-[11px] font-medium transition-colors",
                                activeTab === tab.id
                                    ? "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)]"
                                    : "bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
                            )}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>
            </div>

            {(activeTab === "general" || visitedTabs.has("general")) && <div className={activeTab === "general" ? "space-y-8" : "hidden"}>
                    <Section
                        title="Reading Goals"
                        description="Set your daily and yearly reading targets"
                        icon={<Target className="w-5 h-5" />}
                    >
                        <SettingRow
                            label="Daily Reading Goal"
                            description="Minutes to read each day"
                            htmlFor="daily-goal"
                        >
                            <div className="flex items-center gap-2">
                                <input
                                    id="daily-goal"
                                    type="number"
                                    value={stats.dailyGoal}
                                    onChange={(e) => updateStats({ dailyGoal: Math.max(1, Math.min(180, parseInt(e.target.value) || 0)) })}
                                    min={1}
                                    max={180}
                                    className={cn(
                                        "w-20 px-3 py-1.5 text-sm",
                                        "bg-[var(--color-surface-muted)] text-[color:var(--color-text-primary)]",
                                        "border-none focus:ring-2 focus:ring-[var(--color-accent)]",
                                        "text-center"
                                    )}
                                />
                                <span className="text-sm text-[color:var(--color-text-secondary)]">min/day</span>
                            </div>
                        </SettingRow>

                        <SettingRow
                            label="Yearly Book Goal"
                            description="Books to complete this year"
                            htmlFor="yearly-book-goal"
                        >
                            <div className="flex items-center gap-2">
                                <input
                                    id="yearly-book-goal"
                                    type="number"
                                    value={stats.yearlyBookGoal}
                                    onChange={(e) => updateStats({ yearlyBookGoal: Math.max(1, Math.min(100, parseInt(e.target.value) || 0)) })}
                                    min={1}
                                    max={100}
                                    className={cn(
                                        "w-20 px-3 py-1.5 text-sm",
                                        "bg-[var(--color-surface-muted)] text-[color:var(--color-text-primary)]",
                                        "border-none focus:ring-2 focus:ring-[var(--color-accent)]",
                                        "text-center"
                                    )}
                                />
                                <span className="text-sm text-[color:var(--color-text-secondary)]">books/year</span>
                            </div>
                        </SettingRow>

                        <div className="mt-4 pt-4 border-t border-[var(--color-border)] space-y-4">
                            <SettingRow
                                label="Goal Notifications"
                                description="Notify when you meet or fall short of your daily goal"
                            >
                                <Toggle
                                    checked={settings.goalNotifications}
                                    onChange={(checked) => updateSettings({ goalNotifications: checked })}
                                />
                            </SettingRow>

                            <SettingRow
                                label="Daily Reminder Time"
                                description="Time for a reminder if you're behind your goal"
                                htmlFor="reminder-time"
                            >
                                <input
                                    id="reminder-time"
                                    type="time"
                                    value={settings.dailyReminderTime}
                                    onChange={(e) => updateSettings({ dailyReminderTime: e.target.value })}
                                    className={cn(
                                        "w-32 px-3 py-1.5 text-sm",
                                        "bg-[var(--color-surface-muted)] text-[color:var(--color-text-primary)]",
                                        "border-none focus:ring-2 focus:ring-[var(--color-accent)]",
                                        "text-center"
                                    )}
                                />
                            </SettingRow>

                            <SettingRow
                                label="Sync Notifications"
                                description="Notify when sync completes or fails"
                            >
                                <Toggle
                                    checked={settings.syncNotifications}
                                    onChange={(checked) => updateSettings({ syncNotifications: checked })}
                                />
                            </SettingRow>
                        </div>
                    </Section>

                    <Section
                        title="Customization"
                        description="Customize the look, feel, and reading preferences"
                        icon={<Sun className="w-5 h-5" />}
                    >
                        <SettingRow
                            label="Theme"
                            description="Choose your app theme"
                        >
                            <ButtonSelect
                                options={[
                                    { value: "system", label: "System" },
                                    { value: "light", label: "Light" },
                                    { value: "dark", label: "Dark" },
                                ]}
                                value={settings.theme}
                                onChange={(v) => updateSettings({ theme: v as typeof settings.theme })}
                            />
                        </SettingRow>

                        <SettingRow
                            label="Accent Color"
                            description="Pick a color for interactive elements"
                        >
                            <div className="flex flex-col gap-2">
                                <div className="flex items-center gap-1.5">
                                    {["#2d6a6e", "#5b5b5b", "#9e5a4a", "#3d6b4a", "#6b4a7a", "#4a6b9e", "#1c1c1c", "#9e6b4a"].map((color) => (
                                        <button
                                            key={color}
                                            onClick={() => updateSettings({ accentColor: color })}
                                            className="w-5 h-5 border transition-colors duration-100"
                                            style={{
                                                backgroundColor: color,
                                                borderColor: settings.accentColor === color ? "var(--color-accent-contrast)" : "var(--color-border)",
                                                outline: settings.accentColor === color ? "2px solid var(--color-accent)" : "none",
                                                outlineOffset: "1px",
                                            }}
                                            aria-label={`Set accent to ${color}`}
                                        />
                                    ))}
                                </div>
                                <div className="flex items-center gap-2">
                                    <label className="sr-only" htmlFor="accent-hex">Custom color hex</label>
                                    <div className="flex items-center border border-[var(--color-border)] bg-[var(--color-surface)]">
                                        <span className="pl-2 text-[11px] text-[color:var(--color-text-muted)]">#</span>
                                        <input
                                            id="accent-hex"
                                            type="text"
                                            value={settings.accentColor.replace("#", "")}
                                            onChange={(e) => {
                                                const raw = e.target.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
                                                if (raw.length === 6) {
                                                    updateSettings({ accentColor: "#" + raw.toLowerCase() });
                                                }
                                            }}
                                            maxLength={6}
                                            placeholder="2d6a6e"
                                            className="w-20 border-none bg-transparent px-2 py-1 text-[11px] font-mono text-[color:var(--color-text-primary)] outline-none"
                                        />
                                    </div>
                                </div>
                            </div>
                        </SettingRow>

                        <SettingRow
                            label="Sidebar Collapsed"
                            description="Start with the sidebar collapsed"
                        >
                            <Toggle
                                checked={settings.sidebarCollapsed}
                                onChange={(checked) => updateSettings({ sidebarCollapsed: checked })}
                            />
                        </SettingRow>


                        <SettingRow
                            label="Daily Highlight"
                            description="Show a random past highlight on the Library page"
                        >
                            <Toggle
                                checked={settings.showDailyHighlight}
                                onChange={(checked) => updateSettings({ showDailyHighlight: checked })}
                            />
                        </SettingRow>

                        <SettingRow
                            label="Speed Read"
                            description="Enable RSVP speed reading mode in the reader"
                        >
                            <Toggle
                                checked={settings.speedReadEnabled}
                                 onChange={(checked) => updateSettings({ speedReadEnabled: checked })}
                            />
                        </SettingRow>

                        <SettingRow
                            label="Text-to-Speech"
                            description={isTauri() ? "Read aloud using your device's built-in voice" : "Not available in web browser"}
                        >
                            {isTauri() ? (
                                <Toggle
                                    checked={settings.tts.enabled}
                                    onChange={(checked) => updateTtsSettings({ enabled: checked })}
                                />
                            ) : (
                                <span className="text-[11px] font-medium text-[color:var(--color-text-muted)]">Off</span>
                            )}
                        </SettingRow>

                        <SettingRow
                            label="Vocabulary Lookup"
                            description="Save words you look up while reading"
                        >
                            <Toggle
                                checked={settings.vocabulary.vocabularyEnabled}
                                onChange={(checked) => updateVocabularySettings({ vocabularyEnabled: checked })}
                            />
                        </SettingRow>
                    </Section>

                    {isTauri() && settings.tts.enabled && (
                        <Suspense fallback={null}>
                            <NeuralVoiceSection />
                        </Suspense>
                    )}

                    <div className="flex items-center justify-end mb-8">
                        <button
                            onClick={() => setShowResetConfirm(true)}
                            className="ui-btn-danger"
                        >
                            <RotateCcw className="w-4 h-4" />
                            Reset to Defaults
                        </button>
                    </div>
                </div>}

            {(activeTab === "dictionary" || visitedTabs.has("dictionary")) && <div className={activeTab === "dictionary" ? "space-y-8" : "hidden"}>
                    <Section
                        title="Dictionary"
                        description="Install and manage offline dictionaries"
                        icon={<Globe className="w-5 h-5" />}
                    >
                        <SettingRow
                            label="Show Pronunciation"
                            description="Display phonetic pronunciation when available"
                        >
                            <Toggle
                                checked={settings.vocabulary.showPronunciation}
                                onChange={(checked) => updateVocabularySettings({ showPronunciation: checked })}
                            />
                        </SettingRow>
                    </Section>

                    <Section
                        title="Installed Dictionaries"
                        description="Offline dictionary files for word lookup"
                        icon={<WifiOff className="w-5 h-5" />}
                    >
                        <SettingRow
                            label="Import Dictionary"
                            description="Add offline dictionary files"
                        >
                            <div className="flex flex-wrap items-center gap-2">
                                <input
                                    ref={dictionaryFileInputRef}
                                    type="file"
                                    multiple
                                    onChange={handleDictionaryImport}
                                    className="hidden"
                                    accept=".ifo,.idx,.index,.dict,.dict.dz,.dz,.syn"
                                />
                                <button
                                    onClick={() => dictionaryFileInputRef.current?.click()}
                                    className="ui-btn-primary text-[11px] whitespace-nowrap"
                                >
                                    <Download className="w-4 h-4" /> Import Files
                                </button>
                                <button
                                    onClick={() => setShowDictDownloadModal(true)}
                                    className="ui-btn text-[11px] whitespace-nowrap"
                                >
                                    <Download className="w-4 h-4" /> Download Dictionary
                                </button>
                                <span className="text-xs text-[color:var(--color-text-muted)]">
                                    {installedDictionaries.length} installed
                                </span>
                            </div>
                        </SettingRow>

                        {installedDictionaries.length === 0 && (
                            <p className="text-sm text-[color:var(--color-text-muted)]">
                                No offline dictionaries installed yet.
                            </p>
                        )}

                        {dictionaryRemovedName && (
                            <div className="px-3 py-2 mb-3 text-sm text-[color:var(--color-success,#22c55e)] bg-[color:color-mix(in_srgb,var(--color-success,#22c55e)_8%,transparent)] border border-[color:color-mix(in_srgb,var(--color-success,#22c55e)_24%,transparent)]">
                                Removed "{dictionaryRemovedName}"
                            </div>
                        )}
                        {installedDictionaries.map((dictionary) => (
                            <SettingRow
                                key={dictionary.id}
                                label={dictionary.name}
                                description={`${dictionary.language.toUpperCase()} • ${dictionary.format === "mdx" || dictionary.name.toLowerCase().includes("mdx") ? "MDict (.mdx)" : "StarDict"} • ${formatFileSize(dictionary.sizeBytes)}`}
                            >
                                <button
                                    onClick={() => setRemoveDictionaryInfo({ id: dictionary.id, name: dictionary.name })}
                                    className="ui-btn-danger"
                                >
                                    Remove
                                </button>
                            </SettingRow>
                        ))}

                        <SettingRow
                            label="Offline Mode Guard"
                            description="When offline mode is enabled without dictionaries, lookups will show setup guidance"
                        >
                            <span className="text-sm text-[color:var(--color-text-muted)] px-3 py-1.5 bg-[var(--color-surface-muted)]">
                                Enabled
                            </span>
                        </SettingRow>
                    </Section>
                </div>}

            {(activeTab === "integrations" || visitedTabs.has("integrations")) && <div className={activeTab === "integrations" ? "space-y-8" : "hidden"}>
                    <div ref={deviceSyncSectionRef}>
                        <Suspense fallback={null}>
                            <DeviceSyncSection />
                        </Suspense>
                    </div>

                    {isLinuxDesktop && (
                        <Section
                            title="Terminal CLI"
                            description="Expose Theorem's native engines (dictionary, search, library, article extraction, sync) to your terminal, scripts, and AI agents via the `theorem` command. Includes an interactive TUI (`theorem tui`)."
                            icon={<Terminal className="w-5 h-5" />}
                        >
                            <SettingRow
                                label="Enable CLI"
                                description={
                                    cliEnabled
                                        ? `Active at ${cliStatus?.linkPath ?? "~/.local/bin/theorem"} — run 'theorem help' in any terminal${cliStatus?.isAppImage ? " (AppImage mode: the symlink tracks the AppImage file)" : ""}`
                                        : "Symlink the executable into ~/.local/bin so `theorem` is on your $PATH (no sudo required). Re-checked automatically at every startup."
                                }
                            >
                                <Toggle
                                    checked={cliEnabled}
                                    onChange={(checked) => {
                                        void handleToggleCli(checked);
                                    }}
                                />
                            </SettingRow>

                            {cliEnabled && cliStatus && !cliStatus.installed && (
                                <SettingRow
                                    label="Symlink Missing"
                                    description={`The symlink at ${cliStatus.linkPath} is gone — it can be recreated now, or automatically at the next app start.`}
                                >
                                    <button
                                        onClick={() => {
                                            void handleRepairCli();
                                        }}
                                        disabled={cliBusy}
                                        className={cn("ui-btn", cliBusy && "pointer-events-none opacity-50")}
                                    >
                                        Repair now
                                    </button>
                                </SettingRow>
                            )}
                        </Section>
                    )}

                    <div ref={markdownExportSectionRef}>
                        <Section
                            title="Markdown Export"
                            description="Export highlights and vocabulary as markdown files"
                            icon={<BookOpen className="w-5 h-5" />}
                        >
                            <SettingRow
                                label="Export Folder"
                                description={
                                    isMobilePlatform
                                        ? "Folder selection is unavailable on mobile. Configure on desktop."
                                        : "Choose a folder for your exported markdown files"
                                }
                            >
                                <div className="flex flex-wrap items-center gap-2">
                                    <input
                                        type="text"
                                        value={settings.vault.vaultPath}
                                        onChange={(e) => updateVaultSettings({
                                            vaultPath: e.target.value,
                                        })}
                                        placeholder="/Users/you/Documents/MarkdownExport"
                                        className={cn(
                                            "ui-input",
                                            "min-w-[20rem] sm:w-[28rem]"
                                        )}
                                    />
                                    <button
                                        onClick={() => {
                                            void handlePickVaultDirectory();
                                        }}
                                        disabled={isMobilePlatform}
                                        className={cn("ui-btn", isMobilePlatform && "pointer-events-none opacity-50")}
                                    >
                                        Pick folder
                                    </button>
                                    {settings.vault.vaultPath.trim() && (
                                        <button
                                            onClick={() => updateVaultSettings({
                                                vaultPath: "",
                                                enabled: false,
                                            })}
                                            className="ui-btn"
                                        >
                                            Clear
                                        </button>
                                    )}
                                </div>
                            </SettingRow>

                            <SettingRow
                                label="Export Markdown Now"
                                description="Write latest highlights, RSS highlights, and vocabulary markdown files now"
                            >
                                <button
                                    onClick={() => {
                                        void handleExportMarkdownNow();
                                    }}
                                    disabled={vaultSyncStatus === "syncing"}
                                    className={cn(
                                        "ui-btn",
                                        vaultSyncStatus === "syncing" && "pointer-events-none opacity-60",
                                    )}
                                >
                                    {vaultSyncStatus === "syncing" ? "Exporting..." : "Export now"}
                                </button>
                            </SettingRow>

                            <SettingRow
                                label="Export Status"
                                description="Latest markdown export status"
                            >
                                <div className="border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 font-sans text-[11px] font-medium text-[color:var(--color-text-primary)]">
                                    {vaultSyncStatus === "synced" && "Export complete"}
                                    {vaultSyncStatus === "syncing" && "Exporting..."}
                                    {vaultSyncStatus === "error" && "Export error"}
                                    {vaultSyncStatus === "idle" && "Ready"}
                                    {vaultSyncMessage ? ` | ${vaultSyncMessage}` : ""}
                                    {vaultSyncAt ? ` | ${new Date(vaultSyncAt).toLocaleTimeString()}` : ""}
                                </div>
                            </SettingRow>

                            <details className="border border-[var(--color-border)] bg-[var(--color-surface-muted)]">
                                <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-[color:var(--color-text-primary)]">
                                    File names
                                </summary>
                                <div className="space-y-3 border-t border-[var(--color-border)] p-3">
                                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                                        <div>
                                            <p className="font-sans text-[12px] font-semibold text-[color:var(--color-text-primary)]">
                                                Highlights folder
                                            </p>
                                        </div>
                                        <input
                                            type="text"
                                            value={highlightsExportName}
                                            onChange={(e) => (
                                                updateVaultSettings({
                                                    highlightsFileName: normalizeHighlightsExportName(e.target.value),
                                                })
                                            )}
                                            placeholder="theorem-highlights"
                                            className={cn("ui-input", "min-w-[16rem]")}
                                        />
                                    </div>
                                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                                        <div>
                                            <p className="font-sans text-[12px] font-semibold text-[color:var(--color-text-primary)]">
                                                Vocabulary file
                                            </p>
                                        </div>
                                        <input
                                            type="text"
                                            value={settings.vault.vocabularyFileName}
                                            onChange={(e) => updateVaultSettings({ vocabularyFileName: e.target.value })}
                                            placeholder="theorem-vocabulary.md"
                                            className={cn("ui-input", "min-w-[16rem]")}
                                        />
                                    </div>
                                </div>
                            </details>
                        </Section>
                    </div>
                </div>}

            {(activeTab === "storage" || visitedTabs.has("storage")) && <div className={activeTab === "storage" ? "" : "hidden"}>
                <StorageTab onClearData={handleClearData} onExportData={handleExportData} />
            </div>}

            {(activeTab === "shortcuts" || visitedTabs.has("shortcuts")) && <div className={activeTab === "shortcuts" ? "space-y-8" : "hidden"}>
                    <Section
                        title="Keyboard Shortcuts"
                        description="Available shortcuts throughout the app"
                        icon={<Keyboard className="w-5 h-5" />}
                    >
                        <div className="space-y-6">
                            {(() => {
                                const all = getAllShortcuts();
                                const categories = [...new Set(all.map(s => s.category))];
                                return categories.map(cat => (
                                    <div key={cat}>
                                        <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-[color:var(--color-text-muted)] mb-2">{cat}</h3>
                                        <div className="space-y-1">
                                            {all.filter(s => s.category === cat).map(s => (
                                                <div key={s.label} className="flex items-center justify-between py-1.5 px-3 bg-[var(--color-surface-muted)] text-xs">
                                                    <span className="text-[color:var(--color-text-primary)]">{s.label}</span>
                                                    <kbd className="px-2 py-0.5 text-[10px] font-mono bg-[var(--color-surface)] border border-[var(--color-border)] text-[color:var(--color-accent)]">{formatShortcutKeys(s.keys)}</kbd>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ));
                            })()}
                        </div>
                    </Section>
                </div>}

            {(activeTab === "about" || visitedTabs.has("about")) && <div className={activeTab === "about" ? "space-y-8" : "hidden"}>
                    <Section
                        title="Theorem"
                        description="Local-first reader for PDFs, EPUBs, and RSS"
                        icon={<BookOpen className="w-5 h-5" />}
                    >
                        <div className="space-y-4">
                            <div className="grid gap-2">
                                <div className="flex items-center justify-between py-1.5 border-b border-[var(--color-border-subtle)]">
                                    <span className="text-[12px] text-[color:var(--color-text-secondary)]">Version</span>
                                    <span className="text-[12px] font-medium text-[color:var(--color-text-primary)]">{__APP_VERSION__}</span>
                                </div>
                                {buildInfo && (
                                    <div className="flex items-center justify-between py-1.5 border-b border-[var(--color-border-subtle)]">
                                        <span className="text-[12px] text-[color:var(--color-text-secondary)]">Build</span>
                                        <span className="text-[12px] font-medium text-[color:var(--color-text-primary)]" title="Source commit this binary was built from">
                                            {buildInfo.gitHash} · {buildInfo.buildDate}
                                        </span>
                                    </div>
                                )}
                                <div className="flex items-center justify-between py-1.5 border-b border-[var(--color-border-subtle)]">
                                    <span className="text-[12px] text-[color:var(--color-text-secondary)]">License</span>
                                    <span className="text-[12px] font-medium text-[color:var(--color-text-primary)]">MIT</span>
                                </div>
                                <div className="flex items-center justify-between py-1.5 border-b border-[var(--color-border-subtle)]">
                                    <span className="text-[12px] text-[color:var(--color-text-secondary)]">Author</span>
                                    <span className="text-[12px] font-medium text-[color:var(--color-text-primary)]">Fundamentals</span>
                                </div>
                                <div className="flex items-center justify-between py-1.5">
                                    <span className="text-[12px] text-[color:var(--color-text-secondary)]">Stack</span>
                                    <span className="text-[12px] font-medium text-[color:var(--color-text-primary)]">React 19 + Tauri 2 + Rust</span>
                                </div>
                            </div>
                        </div>
                    </Section>

                    <Section
                        title="Links"
                        description="Project resources"
                        icon={<Globe className="w-5 h-5" />}
                    >
                        <div className="space-y-2">
                            <a
                                 href="https://github.com/fundaments-work/Theorem"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-2 p-3 border border-[var(--color-border)] text-[12px] text-[var(--color-accent)] hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-accent)] transition-colors"
                            >
                                <BookOpen className="w-4 h-4" />
                                 <span>GitHub Repository</span>
                             </a>
                             {updateInfo ? (
                                 <div className="space-y-2">
                                     <div className="p-3 border border-[var(--color-accent)]/20 bg-[var(--color-accent)]/5">
                                         <p className="text-[12px] font-medium">Update Available: v{updateInfo.version}</p>
                                         {updateInfo.body ? (
                                             <p className="text-[11px] text-[color:var(--color-text-secondary)] mt-1">{updateInfo.body}</p>
                                         ) : null}
                                     </div>
                                     <button
                                         onClick={handleInstallUpdate}
                                         className="flex items-center gap-2 p-3 w-full border border-[var(--color-accent)] text-[12px] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/5 transition-colors"
                                     >
                                         <Download className="w-4 h-4" />
                                         <span>Install Update & Restart</span>
                                     </button>
                                 </div>
                             ) : (
                                 <button
                                     onClick={handleCheckForUpdates}
                                     disabled={updateChecking}
                                     className="flex items-center gap-2 p-3 w-full border border-[var(--color-border)] text-[12px] text-[color:var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors disabled:opacity-50"
                                 >
                                     <RefreshCw className={updateChecking ? "w-4 h-4 animate-spin" : "w-4 h-4"} />
                                     <span>{updateChecking ? "Checking..." : "Check for Updates"}</span>
                                 </button>
                             )}
                            <a
                                href="https://github.com/fundaments-work/theorem/releases/latest"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-2 p-3 border border-[var(--color-border)] text-[12px] text-[var(--color-accent)] hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-accent)] transition-colors"
                            >
                                <Download className="w-4 h-4" />
                                <span>Download Latest Release</span>
                            </a>
                            <a
                                href="https://github.com/fundaments-work/theorem/issues"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-2 p-3 border border-[var(--color-border)] text-[12px] text-[var(--color-accent)] hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-accent)] transition-colors"
                            >
                                <AlertCircle className="w-4 h-4" />
                                <span>Report an Issue</span>
                            </a>
                        </div>
                    </Section>
                </div>}
        </div>

        <DictionaryDownloadModal
            isOpen={showDictDownloadModal}
            onClose={() => setShowDictDownloadModal(false)}
        />

        <ConfirmDialog
            isOpen={showResetConfirm}
            title="Reset Settings"
            message="Reset all settings to default?"
            confirmLabel="Reset"
            cancelLabel="Cancel"
            variant="danger"
            onConfirm={() => {
                resetSettings();
                setShowResetConfirm(false);
            }}
            onCancel={() => setShowResetConfirm(false)}
        />

        <ConfirmDialog
            isOpen={showClearDataConfirm}
            title="Clear All Data"
            message="This will permanently delete all your books, highlights, notes, vocabulary, shelves, and settings. This action cannot be undone."
            confirmLabel="Clear Everything"
            cancelLabel="Cancel"
            variant="danger"
            onConfirm={handleClearDataConfirm}
            onCancel={() => setShowClearDataConfirm(false)}
        />

        <ConfirmDialog
            isOpen={!!removeDictionaryInfo}
            title="Remove Dictionary"
            message={removeDictionaryInfo ? `Remove "${removeDictionaryInfo.name}"? Offline word lookups from this dictionary will stop working.` : ""}
            confirmLabel="Remove"
            cancelLabel="Cancel"
            variant="danger"
            onConfirm={async () => {
                if (removeDictionaryInfo) {
                    await removeDictionary(removeDictionaryInfo.id);
                    setDictionaryRemovedName(removeDictionaryInfo.name);
                    setRemoveDictionaryInfo(null);
                }
            }}
            onCancel={() => setRemoveDictionaryInfo(null)}
        />

        {alertInfo && (
            <AlertDialog
                isOpen={!!alertInfo}
                title={alertInfo.title}
                message={alertInfo.message}
                okLabel="OK"
                onClose={() => setAlertInfo(null)}
            />
        )}
        </>
    );
});
