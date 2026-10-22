
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
    Smartphone,
    QrCode,
    Wifi,
    WifiOff,
    Trash2,
    Copy,
    Check,
    Loader2,
    Monitor,
    Link2,
    ArrowDownUp,
    ScanLine,
    Signal,
    Lock,
} from "lucide-react";
import { cn } from "../../core/lib/utils";
import { isMobile, isTauri } from "../../core/lib/env";
import { Modal, ModalBody, ModalHeader, ConfirmDialog } from "../../ui";
import {
    generatePairingQr,
    submitPairingCode,
    getDeviceIdentity,
    getPairedDevices,
    unpairDevice,
    respondPairingRequest,
    closePairingQr,
    setDeviceName,
    probePairedDevice,
} from "../../core/lib/device-sync";
import { PairingRequestDialog, type PairingRequest } from "./PairingRequestDialog";
import { SyncConflictList, useSyncConflicts } from "./SyncConflicts";
import {
    runDeviceSync,
    ensureResponderSyncReady,
} from "../../core/lib/sync-orchestrator";
import { useUIStore, useSettingsStore } from "../../core/store";
import type {
    PairedDevice,
    DeviceIdentityInfo,
    PairingQrData,
} from "../../core/types";

function Section({
    title,
    description,
    icon,
    children,
}: {
    title: string;
    description?: string;
    icon: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <div className="space-y-4">
            <div className="flex items-start gap-3">
                <div className="p-2 bg-[var(--color-surface-muted)] text-[color:var(--color-text-muted)]">
                    {icon}
                </div>
                <div>
                    <h2 className="text-[color:var(--color-text-primary)]">
                        {title}
                    </h2>
                    {description && (
                        <p className="text-xs text-[color:var(--color-text-muted)] mt-0.5">
                            {description}
                        </p>
                    )}
                </div>
            </div>
            <div className="space-y-4">{children}</div>
        </div>
    );
}

function Card({
    label,
    children,
    className,
}: {
    label?: string;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <div
            className={cn(
                "border border-[var(--color-border)] bg-[var(--color-surface)]",
                className,
            )}
        >
            {label && (
                <div className="px-4 py-2.5 border-b border-[var(--color-border)]">
                    <p className="text-[11px] text-[color:var(--color-text-muted)]">
                        {label}
                    </p>
                </div>
            )}
            {children}
        </div>
    );
}

function StatusBadge({ status }: { status: string }) {
    const styles: Record<string, string> = {
        idle: "bg-[color:color-mix(in_srgb,var(--color-text-muted)_15%,transparent)] text-[color:var(--color-text-muted)]",
        hosting:
            "bg-[color:color-mix(in_srgb,var(--color-success)_15%,transparent)] text-[color:var(--color-success)]",
        syncing:
            "bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-[color:var(--color-accent)]",
        synced:
            "bg-[color:color-mix(in_srgb,var(--color-success)_15%,transparent)] text-[color:var(--color-success)]",
        error:
            "bg-[color:color-mix(in_srgb,var(--color-error)_15%,transparent)] text-[color:var(--color-error)]",
        pairing:
            "bg-[color:color-mix(in_srgb,var(--color-warning)_15%,transparent)] text-[color:var(--color-warning)]",
        connecting:
            "bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-[color:var(--color-accent)]",
    };

    return (
        <span
            className={cn(
                "inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px]",
                styles[status] || styles.idle,
            )}
        >
            {status === "syncing" && (
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
            )}
            {status === "hosting" && <Signal className="w-2.5 h-2.5" />}
            {status === "synced" && <Check className="w-2.5 h-2.5" />}
            {status}
        </span>
    );
}

function ReceiverDot({ active }: { active: boolean }) {
    return (
        <span
            className={cn(
                "inline-block w-2 h-2 shrink-0",
                active
                    ? "bg-[var(--color-success)]"
                    : "bg-[var(--color-text-muted)] opacity-40",
            )}
            style={{ borderRadius: "50%" }}
            title={active ? "Receiver active" : "Receiver inactive"}
        />
    );
}

/** How often the Device Sync page checks which paired devices are there. */
const PRESENCE_CHECK_MS = 20_000;

export function DeviceSyncSection() {
    const [identity, setIdentity] = useState<DeviceIdentityInfo | null>(null);
    const [nodeInfo, setNodeInfo] = useState<{ nodeId: string } | null>(null);
    const [qrData, setQrData] = useState<PairingQrData | null>(null);
    const [pairedDevices, setPairedDevices] = useState<PairedDevice[]>([]);
    const [pairingCode, setPairingCode] = useState("");
    const [isIrohRunning, setIsIrohRunning] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [isPairing, setIsPairing] = useState(false);
    const [isQrModalOpen, setIsQrModalOpen] = useState(false);
    const [syncingDeviceId, setSyncingDeviceId] = useState<string | null>(null);
    const [syncProgress, setSyncProgress] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [copiedCode, setCopiedCode] = useState(false);
    const [unpairDeviceId, setUnpairDeviceId] = useState<string | null>(null);
    const [pairingRequest, setPairingRequest] = useState<PairingRequest | null>(null);
    const [codeToCompare, setCodeToCompare] = useState<string | null>(null);
    // Sync-mesh presence by iroh node id (docs-peer-online / -offline).
    const [peerOnline, setPeerOnline] = useState<Record<string, boolean>>({});
    const [nameDraft, setNameDraft] = useState<string | null>(null);
    const syncAbortRef = useRef(false);

    const syncStatus = useUIStore((state) => state.deviceSyncStatus);
    const syncMessage = useUIStore((state) => state.deviceSyncMessage);
    const setDeviceSyncStatus = useUIStore(
        (state) => state.setDeviceSyncStatus,
    );

    const deviceSyncSettings = useSettingsStore((state) => state.settings.deviceSync);
    const updateSettings = useSettingsStore((state) => state.updateSettings);

    const available = isTauri();
    const mobilePlatform = isMobile();

    useEffect(() => {
        if (!available) return;

        (async () => {
            try {
                const id = await getDeviceIdentity();
                setIdentity(id);

                const devices = await getPairedDevices();
                setPairedDevices(devices);
            } catch (e) {
            }
        })();
    }, [available]);

    const hasPairedDevices = pairedDevices.length > 0;
    useEffect(() => {
        if (!available || !hasPairedDevices) {
            return;
        }

        let cancelled = false;
        const ensureReceiverReady = async () => {
            try {
                
                await ensureResponderSyncReady();
                if (!cancelled) {
                    setIsIrohRunning(true);
                    const identity = await getDeviceIdentity();
                    setNodeInfo({ nodeId: identity.publicKeyHex });
                }
            } catch (e) {
                if (!cancelled) {
                }
            }
        };

        void ensureReceiverReady();
        return () => {
            cancelled = true;
        };
    }, [available, hasPairedDevices]);

    // While this page is open, ask each paired device whether it is there
    // (presence events update the Online/Offline labels; the devices also
    // swap names, so a rename shows up here).
    const pairedIds = useMemo(() => pairedDevices.map((d) => d.deviceId).join("|"), [pairedDevices]);
    useEffect(() => {
        if (!available || !isIrohRunning || pairedIds === "") return;
        let cancelled = false;
        const probeAll = async () => {
            for (const deviceId of pairedIds.split("|")) {
                if (cancelled) return;
                await probePairedDevice(deviceId).catch(() => {});
            }
        };
        void probeAll();
        const timer = setInterval(() => void probeAll(), PRESENCE_CHECK_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [available, isIrohRunning, pairedIds]);

    const conflictList = useSyncConflicts(available);

    const handleSaveName = useCallback(async () => {
        const draft = nameDraft;
        setNameDraft(null);
        if (draft === null) return;
        try {
            const name = await setDeviceName(draft);
            setIdentity((current) => (current ? { ...current, deviceName: name } : current));
        } catch (e: any) {
            setError(e?.message || String(e));
        }
    }, [nameDraft]);

    useEffect(() => {
        if (successMessage) {
            const timer = setTimeout(() => setSuccessMessage(null), 4000);
            return () => clearTimeout(timer);
        }
    }, [successMessage]);

    // Every QR code carries a fresh one-time secret, so it is generated each
    // time it is shown and withdrawn when it is closed.
    const handleGenerateQr = useCallback(async () => {
        setError(null);
        setIsLoading(true);
        try {
            const data = await generatePairingQr();
            setQrData(data);
            setIsQrModalOpen(true);
            setIsIrohRunning(true);
            setDeviceSyncStatus("hosting");
        } catch (e: any) {
            setError(e?.message || String(e));
        } finally {
            setIsLoading(false);
        }
    }, [setDeviceSyncStatus]);

    const handleCloseQr = useCallback(() => {
        setIsQrModalOpen(false);
        setQrData(null);
        void closePairingQr().catch(() => {});
    }, []);

    // Leaving the page withdraws a QR code still on screen.
    useEffect(() => () => {
        void closePairingQr().catch(() => {});
    }, []);

    useEffect(() => {
        if (!available) return;
        let cancelled = false;
        const unlisteners: (() => void)[] = [];
        import("@tauri-apps/api/event").then(async ({ listen }) => {
            const handlers = [
                listen<PairingRequest>("pairing-confirm-request", (event) => {
                    // The secret is used up; the QR code has done its job.
                    setIsQrModalOpen(false);
                    setQrData(null);
                    setPairingRequest(event.payload);
                }),
                listen<{ requestId: string }>("pairing-confirm-closed", (event) => {
                    setPairingRequest((current) =>
                        current?.requestId === event.payload.requestId ? null : current,
                    );
                }),
                listen<{ peer: string }>("docs-peer-online", (event) => {
                    setPeerOnline((prev) => ({ ...prev, [event.payload.peer]: true }));
                }),
                listen<{ peer: string }>("docs-peer-offline", (event) => {
                    setPeerOnline((prev) => ({ ...prev, [event.payload.peer]: false }));
                }),
                listen<{ peer: string; online: boolean }>("sync-peer-presence", (event) => {
                    setPeerOnline((prev) => ({ ...prev, [event.payload.peer]: event.payload.online }));
                }),
                // A rename on the other device, or a device removed (by the
                // user, or by the other device unpairing this one).
                listen("paired-devices-changed", () => {
                    void getPairedDevices().then(setPairedDevices).catch(() => {});
                }),
                listen<{ deviceName: string }>("sync-peer-removed", (event) => {
                    setError(`${event.payload.deviceName || "A paired device"} removed this device. Pair them again to sync.`);
                }),
                listen<{ device_id: string; device_name: string }>("pairing-completed", (event) => {
                    setDeviceSyncStatus("synced", "Device paired!");
                    setSuccessMessage(`Paired with ${event.payload.device_name || event.payload.device_id}`);
                    void getPairedDevices().then(setPairedDevices).catch(() => {});
                }),
            ];
            for (const handler of handlers) {
                const unlisten = await handler;
                if (cancelled) unlisten();
                else unlisteners.push(unlisten);
            }
        }).catch(() => {});
        return () => {
            cancelled = true;
            unlisteners.forEach((unlisten) => unlisten());
        };
    }, [available, setDeviceSyncStatus]);

    const handlePairingAnswer = useCallback((accept: boolean) => {
        const request = pairingRequest;
        setPairingRequest(null);
        if (!request) return;
        void respondPairingRequest(request.requestId, accept).catch((e: any) => {
            setError(e?.message || String(e));
        });
        if (!accept) setDeviceSyncStatus("idle", "Pairing declined");
    }, [pairingRequest, setDeviceSyncStatus]);

    const submitPairingCodeValue = useCallback(
        async (code: string) => {
            const trimmedCode = code.trim();
            if (!trimmedCode) return;
            setError(null);
            setIsPairing(true);
            setDeviceSyncStatus("pairing", "Connecting to device...");

            let pairUnlisten: (() => void) | null = null;
            try {
                const { listen } = await import("@tauri-apps/api/event");
                pairUnlisten = await listen<{ step: string; message: string; code?: string }>(
                    "pairing-progress",
                    (event) => {
                        setDeviceSyncStatus("pairing", event.payload.message);
                        if (event.payload.step === "confirm" && event.payload.code) {
                            setCodeToCompare(event.payload.code);
                        }
                    },
                );
            } catch {}

            try {
                const device = await submitPairingCode(trimmedCode);
                pairUnlisten?.();
                setPairedDevices((prev) => {
                    const filtered = prev.filter(d => d.deviceId !== device.deviceId);
                    return [...filtered, device];
                });
                setPairingCode("");
                setSuccessMessage(
                    `Paired with ${device.deviceName || device.deviceId}`,
                );
                setDeviceSyncStatus("synced", "Device paired!");
            } catch (e: any) {
                pairUnlisten?.();
                setError(e?.message || String(e));
                setDeviceSyncStatus("error", e?.message || String(e));
            } finally {
                setIsPairing(false);
                setCodeToCompare(null);
            }
        },
        [setDeviceSyncStatus],
    );

    const handleSubmitPairingCode = useCallback(async () => {
        if (!pairingCode.trim()) return;
        await submitPairingCodeValue(pairingCode);
    }, [pairingCode, submitPairingCodeValue]);

    const handleScanPairingQr = useCallback(async () => {
        if (!available || !mobilePlatform) {
            setError("QR scanning is only available in the mobile app.");
            return;
        }

        setError(null);
        setIsPairing(true);
        try {
            const {
                checkPermissions,
                requestPermissions,
                scan,
                Format,
            } = await import("@tauri-apps/plugin-barcode-scanner");

            let permission = await checkPermissions();
            if (permission !== "granted") {
                permission = await requestPermissions();
            }
            if (permission !== "granted") {
                setError(
                    "Camera permission is required to scan pairing QR codes.",
                );
                return;
            }

            const result = await scan({
                windowed: false,
                formats: [Format.QRCode],
            });
            const scannedCode = result?.content?.trim();
            if (!scannedCode) {
                setError("No QR code data detected.");
                return;
            }

            setPairingCode(scannedCode);
            await submitPairingCodeValue(scannedCode);
        } catch (e: any) {
            const msg = e?.message || String(e);

            if (/cancel|closed|dismiss/i.test(msg)) {
                const { toast } = await import("sonner");
                toast("QR scan cancelled");
            } else {
                setError(msg);
            }
        } finally {
            setIsPairing(false);
        }
    }, [available, mobilePlatform, submitPairingCodeValue]);

    const handleUnpair = useCallback((deviceId: string) => {
        setUnpairDeviceId(deviceId);
    }, []);

    const handleUnpairConfirm = useCallback(async () => {
        if (!unpairDeviceId) return;
        const deviceId = unpairDeviceId;
        setUnpairDeviceId(null);
        try {
            const { cancelRunningSync } = await import("../../core/lib/sync-orchestrator");
            cancelRunningSync();
            useUIStore.getState().setDeviceSyncStatus("idle");
            await unpairDevice(deviceId);
            setPairedDevices((prev) =>
                prev.filter((d) => d.deviceId !== deviceId),
            );
            setSuccessMessage("Device unpaired");
        } catch (e: any) {
            setError(e?.message || String(e));
        }
    }, [unpairDeviceId]);

    const handleSyncNow = useCallback(
        async (deviceId: string) => {
            if (syncingDeviceId) return;
            setError(null);
            setSyncingDeviceId(deviceId);
            setSyncProgress("Starting...");
            syncAbortRef.current = false;

            try {
                const result = await runDeviceSync(deviceId, (msg) => {
                    if (!syncAbortRef.current) {
                        setSyncProgress(msg);
                    }
                }, true);

                if (result.success) {
                    setSuccessMessage(
                        result.domainsUpdated.length > 0
                            ? `Updated: ${result.domainsUpdated.join(", ")}`
                            : "Already in sync",
                    );
                    const devices = await getPairedDevices();
                    setPairedDevices(devices);
                } else if (result.error === "Sync cancelled") {
                    setSuccessMessage("Sync cancelled");
                } else {
                    setError(result.error || "Sync failed");
                }
            } catch (e: any) {
                const msg = e?.message || String(e);
                if (msg === "Sync cancelled") {
                    setSuccessMessage("Sync cancelled");
                } else {
                    setError(msg);
                }
            } finally {
                setSyncingDeviceId(null);
                setSyncProgress(null);
            }
        },
        [syncingDeviceId],
    );

    const handleCancelSync = useCallback(() => {
        syncAbortRef.current = true;
        setSyncProgress("Cancelling...");
        import("../../core/lib/sync-orchestrator").then(m => m.cancelRunningSync());
    }, []);

    const handleCopyCode = useCallback(() => {
        if (qrData?.pairingCode) {
            navigator.clipboard.writeText(qrData.pairingCode);
            setCopiedCode(true);
            setTimeout(() => setCopiedCode(false), 2000);
        }
    }, [qrData]);

    const qrSvgDataUri = useMemo(() => {
        if (!qrData?.qrSvg) {
            return "";
        }
        return `data:image/svg+xml;utf8,${encodeURIComponent(qrData.qrSvg)}`;
    }, [qrData?.qrSvg]);

    if (!available) {
        return (
            <Section
                title="Device Sync"
                description="Real app-data sync between your devices over LAN"
                icon={<Smartphone className="w-5 h-5" />}
            >
                <div className="p-6 bg-[var(--color-surface-muted)] text-center">
                    <WifiOff className="w-8 h-8 mx-auto mb-2 text-[color:var(--color-text-muted)]" />
                    <p className="text-sm text-[color:var(--color-text-muted)]">
                        Device sync is only available in the desktop/mobile app.
                    </p>
                </div>
            </Section>
        );
    }

    return (
        <Section
            title="Device Sync"
            description="Sync your library, annotations, and settings between devices on the same network"
            icon={<Smartphone className="w-5 h-5" />}
        >
            
            {error && (
                <div className="flex items-start gap-2.5 p-3 border border-[color:color-mix(in_srgb,var(--color-error)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--color-error)_8%,transparent)]">
                    <span className="text-sm text-[color:var(--color-error)] flex-1">
                        {error}
                    </span>
                    <button
                        onClick={() => setError(null)}
                        className="text-xs text-[color:var(--color-error)] underline underline-offset-2 shrink-0"
                    >
                        dismiss
                    </button>
                </div>
            )}
            {successMessage && (
                <div className="flex items-center gap-2 p-3 border border-[color:color-mix(in_srgb,var(--color-success)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--color-success)_8%,transparent)]">
                    <Check className="w-4 h-4 text-[color:var(--color-success)] shrink-0" />
                    <span className="text-sm text-[color:var(--color-success)]">
                        {successMessage}
                    </span>
                </div>
            )}

            {syncStatus !== "idle" && (
                <div className="flex items-center gap-3 p-3 bg-[var(--color-surface-muted)] border border-[var(--color-border)]">
                    <StatusBadge status={syncStatus} />
                    {syncMessage && (
                        <span className="text-xs text-[color:var(--color-text-muted)] truncate flex-1">
                            {syncMessage}
                        </span>
                    )}
                </div>
            )}

            <Card label="This Device">
                <div className="p-4 space-y-3">
                    
                    {identity && (
                        <div className="flex items-center gap-3">
                            <Monitor className="w-5 h-5 text-[color:var(--color-text-muted)] shrink-0" />
                            <div className="flex-1 min-w-0">
                                {nameDraft === null ? (
                                    <p className="text-sm text-[color:var(--color-text-primary)] truncate">
                                        {identity.deviceName || "This Device"}
                                    </p>
                                ) : (
                                    <input
                                        type="text"
                                        autoFocus
                                        aria-label="Device name"
                                        value={nameDraft}
                                        maxLength={64}
                                        onChange={(e) => setNameDraft(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") void handleSaveName();
                                            if (e.key === "Escape") setNameDraft(null);
                                        }}
                                        placeholder="Leave empty for the system name"
                                        className={cn(
                                            "w-full px-2 py-1.5 text-sm",
                                            "bg-[var(--color-surface-muted)] border border-[var(--color-border)]",
                                            "text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-muted)]",
                                            "focus:outline-none focus:border-[color:var(--color-accent)]",
                                        )}
                                    />
                                )}
                                <p className="text-[11px] text-[color:var(--color-text-muted)] font-mono truncate">
                                    {identity.deviceId}
                                </p>
                            </div>
                            <button
                                onClick={() => (nameDraft === null ? setNameDraft(identity.deviceName || "") : void handleSaveName())}
                                className={cn(
                                    "shrink-0 px-2 py-1.5 min-h-[2.25rem] text-xs",
                                    "text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-accent)]",
                                    "transition-colors",
                                )}
                            >
                                {nameDraft === null ? "Rename" : "Save"}
                            </button>
                        </div>
                    )}

                    <div className="flex items-center gap-3 pt-3 border-t border-[var(--color-border)]">
                        <ReceiverDot active={isIrohRunning} />
                        <div className="flex-1 min-w-0">
                            <p className="text-xs text-[color:var(--color-text-secondary)]">
                                {isIrohRunning ? (
                                    <>
                                        Receiver active
                                        {nodeInfo?.nodeId && (
                                            <span className="ml-1.5 font-mono text-[10px] text-[color:var(--color-accent)]">
                                                {nodeInfo.nodeId.slice(0, 12)}...
                                            </span>
                                        )}
                                    </>
                                ) : pairedDevices.length > 0 ? (
                                    "Receiver starting..."
                                ) : (
                                    "Pair a device to enable incoming sync"
                                )}
                            </p>
                        </div>
                        {isIrohRunning ? (
                            <Wifi className="w-4 h-4 text-[color:var(--color-accent)] shrink-0" />
                        ) : (
                            <WifiOff className="w-4 h-4 text-[color:var(--color-text-muted)] shrink-0 opacity-40" />
                        )}
                    </div>

                </div>
            </Card>

            {conflictList.conflicts.length > 0 && (
                <Card label={`Sync conflicts (${conflictList.conflicts.length})`}>
                    <SyncConflictList
                        conflicts={conflictList.conflicts}
                        onRestore={(c) => void conflictList.restore(c)}
                        onDismiss={(ids) => void conflictList.dismiss(ids)}
                    />
                </Card>
            )}

            <Card label="Sync Settings">
                <div className="p-4">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm text-[color:var(--color-text-primary)]">
                                Auto-sync
                            </p>
                            <p className="text-xs text-[color:var(--color-text-muted)] mt-0.5">
                                Periodically sync with paired devices in the background
                            </p>
                        </div>
                        <button
                            onClick={() => {
                                const newValue = !deviceSyncSettings.autoSyncEnabled;
                                updateSettings({
                                    deviceSync: {
                                        ...deviceSyncSettings,
                                        autoSyncEnabled: newValue,
                                    },
                                });
                            }}
                            className={cn(
                                "px-3 py-1.5 text-[11px] border transition-colors shrink-0",
                                deviceSyncSettings.autoSyncEnabled
                                    ? "ui-selected"
                                    : "text-[color:var(--color-text-secondary)] border-[var(--color-border)]",
                            )}
                        >
                            {deviceSyncSettings.autoSyncEnabled ? "On" : "Off"}
                        </button>
                    </div>
                </div>
            </Card>

            <Card label="Pair a Device">
                <div className="divide-y divide-[var(--color-border)]">
                    
                    <button
                        onClick={handleGenerateQr}
                        disabled={isLoading}
                        className={cn(
                            "w-full flex items-center gap-3 p-4 min-h-[3.5rem]",
                            "text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)]",
                            "transition-colors text-left",
                            isLoading && "opacity-50 cursor-not-allowed",
                        )}
                    >
                        <QrCode className="w-5 h-5 text-[color:var(--color-accent)] shrink-0" />
                        <div className="flex-1 min-w-0">
                            <p className="text-sm">Show Pairing QR</p>
                            <p className="text-xs text-[color:var(--color-text-muted)]">
                                Display a code for the other device to scan
                            </p>
                        </div>
                        {isLoading ? (
                            <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                        ) : (
                            <span className="text-[color:var(--color-text-muted)] text-xs shrink-0">&rsaquo;</span>
                        )}
                    </button>

                    {mobilePlatform && (
                        <button
                            onClick={() => {
                                void handleScanPairingQr();
                            }}
                            disabled={isPairing}
                            className={cn(
                                "w-full flex items-center gap-3 p-4 min-h-[3.5rem]",
                                "text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)]",
                                "transition-colors text-left",
                                isPairing && "opacity-50 cursor-not-allowed",
                            )}
                        >
                            <ScanLine className="w-5 h-5 text-[color:var(--color-accent)] shrink-0" />
                            <div className="flex-1 min-w-0">
                                <p className="text-sm">Scan QR Code</p>
                                <p className="text-xs text-[color:var(--color-text-muted)]">
                                    Use your camera to scan another device&apos;s code
                                </p>
                            </div>
                            {isPairing ? (
                                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                            ) : (
                                <span className="text-[color:var(--color-text-muted)] text-xs shrink-0">&rsaquo;</span>
                            )}
                        </button>
                    )}

                    {codeToCompare && (
                        <div className="p-4 space-y-2" role="status">
                            <p className="text-xs text-[color:var(--color-text-muted)]">
                                On the other device, accept the request if it shows:
                            </p>
                            <p
                                data-pairing-code
                                className="text-center font-mono text-3xl tracking-[0.3em] text-[color:var(--color-text-primary)]"
                            >
                                {codeToCompare}
                            </p>
                        </div>
                    )}

                    <div className="p-4 space-y-2">
                        <p className="text-xs text-[color:var(--color-text-muted)]">
                            Or enter a pairing code manually
                        </p>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={pairingCode}
                                onChange={(e) => setPairingCode(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        void handleSubmitPairingCode();
                                    }
                                }}
                                placeholder="Paste code from other device..."
                                className={cn(
                                    "flex-1 px-3 py-2.5 text-sm min-h-[2.75rem]",
                                    "bg-[var(--color-surface-muted)] border border-[var(--color-border)]",
                                    "text-[color:var(--color-text-primary)]",
                                    "placeholder:text-[color:var(--color-text-muted)]",
                                    "focus:outline-none focus:border-[var(--color-accent)]",
                                    "transition-colors",
                                )}
                            />
                            <button
                                onClick={handleSubmitPairingCode}
                                disabled={!pairingCode.trim() || isPairing}
                                className={cn(
                                    "inline-flex items-center justify-center gap-2 px-4 min-h-[2.75rem] min-w-[2.75rem]",
                                    "bg-[var(--color-accent)] text-[color:var(--color-accent-contrast)] text-sm",
                                    "hover:opacity-90 transition-opacity",
                                    "disabled:opacity-40 disabled:cursor-not-allowed",
                                )}
                            >
                                {isPairing ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                    <Link2 className="w-4 h-4" />
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </Card>

            {pairedDevices.length > 0 && (
                <Card label={`Paired Devices (${pairedDevices.length})`}>
                    <div className="divide-y divide-[var(--color-border)]">
                        {pairedDevices.map((device) => {
                            const isSyncing =
                                syncingDeviceId === device.deviceId;
                            return (
                                <div
                                    key={device.deviceId}
                                    className="p-4 space-y-3"
                                >
                                    
                                    <div className="flex items-center gap-3">
                                        <Smartphone className="w-5 h-5 text-[color:var(--color-text-muted)] shrink-0" />
                                        <div className="flex-1 min-w-0">
                                            <p className="flex items-center gap-2 text-sm text-[color:var(--color-text-primary)]">
                                                <span className="truncate">
                                                    {device.deviceName ||
                                                        device.deviceId}
                                                </span>
                                                {peerOnline[device.irohNodeId] !== undefined && (
                                                    <span
                                                        data-peer-presence
                                                        className={cn(
                                                            "shrink-0 text-[10px]",
                                                            peerOnline[device.irohNodeId]
                                                                ? "text-[color:var(--color-success)]"
                                                                : "text-[color:var(--color-text-muted)]",
                                                        )}
                                                    >
                                                        {peerOnline[device.irohNodeId] ? "Online" : "Offline"}
                                                    </span>
                                                )}
                                            </p>
                                            <p className="text-[11px] text-[color:var(--color-text-muted)]">
                                                {device.lastSyncAt
                                                    ? `Synced ${new Date(device.lastSyncAt).toLocaleDateString()} ${new Date(device.lastSyncAt).toLocaleTimeString()}`
                                                    : "Never synced"}
                                                {device.lastIp &&
                                                    device.lastPort > 0 && (
                                                        <>
                                                            {" "}
                                                            &middot;{" "}
                                                            {device.lastIp}:
                                                            {device.lastPort}
                                                        </>
                                                    )}
                                            </p>
                                        </div>
                                    </div>

                                    {isSyncing && syncProgress && (
                                        <div className="flex items-center gap-2 px-1">
                                            <Loader2 className="w-3 h-3 animate-spin text-[color:var(--color-accent)]" />
                                            <span className="text-xs text-[color:var(--color-accent)]">
                                                {syncProgress}
                                            </span>
                                        </div>
                                    )}

                                    <div className="flex flex-col sm:flex-row gap-2">
                                        <button
                                            onClick={() =>
                                                handleSyncNow(device.deviceId)
                                            }
                                            disabled={!!syncingDeviceId}
                                            className={cn(
                                                "inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[2.75rem]",
                                                "border border-[var(--color-border)]",
                                                "text-sm text-[color:var(--color-text-secondary)]",
                                                "hover:text-[color:var(--color-accent)] hover:border-[color:color-mix(in_srgb,var(--color-accent)_40%,var(--color-border))]",
                                                "transition-colors",
                                                "disabled:opacity-40 disabled:cursor-not-allowed",
                                                "sm:flex-1",
                                            )}
                                        >
                                            {isSyncing ? (
                                                <>
                                                    <Loader2 className="w-4 h-4 animate-spin" />
                                                    Syncing...
                                                </>
                                            ) : (
                                                <>
                                                    <ArrowDownUp className="w-4 h-4" />
                                                    Sync Now
                                                </>
                                            )}
                                        </button>
                                        {isSyncing && (
                                            <button
                                                onClick={handleCancelSync}
                                                className={cn(
                                                    "inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[2.75rem]",
                                                    "border border-[var(--color-border)]",
                                                    "text-sm text-[color:var(--color-text-secondary)]",
                                                    "hover:text-[color:var(--color-error)] hover:border-[color:color-mix(in_srgb,var(--color-error)_40%,var(--color-border))]",
                                                    "transition-colors",
                                                    "sm:w-auto",
                                                )}
                                            >
                                                Cancel
                                            </button>
                                        )}
                                        <button
                                            onClick={() =>
                                                handleUnpair(device.deviceId)
                                            }
                                            disabled={isSyncing}
                                            className={cn(
                                                "inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[2.75rem]",
                                                "border border-[var(--color-border)]",
                                                "text-sm text-[color:var(--color-text-secondary)]",
                                                "hover:text-[color:var(--color-error)] hover:border-[color:color-mix(in_srgb,var(--color-error)_40%,var(--color-border))]",
                                                "transition-colors",
                                                "disabled:opacity-40 disabled:cursor-not-allowed",
                                                "sm:w-auto",
                                            )}
                                        >
                                            <Trash2 className="w-4 h-4" />
                                            Unpair
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </Card>
            )}

            <div className="flex items-center gap-2.5 py-2">
                <Lock className="w-3.5 h-3.5 text-[color:var(--color-text-muted)] shrink-0 opacity-60" />
                <p className="text-[11px] text-[color:var(--color-text-muted)] leading-relaxed">
                    Sync is end-to-end encrypted between your devices, with no server. Only devices you approved can connect; pairing codes work once and expire after 10 minutes.
                </p>
            </div>

            <Modal
                isOpen={isQrModalOpen && !!qrData}
                onClose={handleCloseQr}
                size="sm"
            >
                <ModalHeader
                    title="Pair Device"
                    onClose={handleCloseQr}
                />
                <ModalBody className="space-y-4 overflow-x-hidden">
                    <div className="mx-auto w-full max-w-[18rem]">
                        <div className="aspect-square w-full overflow-hidden border border-[var(--color-border)] bg-white p-3">
                            {qrSvgDataUri && (
                                <img
                                    src={qrSvgDataUri}
                                    alt="Pairing QR code"
                                    className="h-full w-full object-contain"
                                />
                            )}
                        </div>
                    </div>
                    <p className="text-sm text-center text-[color:var(--color-text-muted)]">
                        Scan this QR code from the other device&apos;s Theorem
                        app. It works once, for 10 minutes, and you will be
                        asked to approve the device.
                    </p>
                    <button
                        onClick={handleCopyCode}
                        className={cn(
                            "w-full flex items-center justify-center gap-2 p-2.5 min-h-[2.75rem]",
                            "border border-[var(--color-border)]",
                            "text-sm text-[color:var(--color-text-primary)]",
                            "hover:bg-[var(--color-surface-muted)] transition-colors",
                        )}
                    >
                        {copiedCode ? (
                            <>
                                <Check className="w-3.5 h-3.5" />
                                Copied pairing code
                            </>
                        ) : (
                            <>
                                <Copy className="w-3.5 h-3.5" />
                                Copy pairing code (for manual entry)
                            </>
                        )}
                    </button>
                </ModalBody>
            </Modal>

            <PairingRequestDialog request={pairingRequest} onAnswer={handlePairingAnswer} />

            <ConfirmDialog
                isOpen={!!unpairDeviceId}
                title="Unpair Device"
                message="Are you sure you want to unpair this device? It will need to be paired again to sync."
                confirmLabel="Unpair"
                cancelLabel="Cancel"
                variant="danger"
                onConfirm={handleUnpairConfirm}
                onCancel={() => setUnpairDeviceId(null)}
            />
        </Section>
    );
}
