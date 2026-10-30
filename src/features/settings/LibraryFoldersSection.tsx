import { memo, useState, useCallback, useMemo, useRef } from "react";
import { Folder, FolderPlus, RefreshCw, Trash2, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { useLibraryStore } from "../../core/store";
import { buildSourceFolderIndex } from "../../core/lib/source-folders";
import { importFolder, describeFolderImport, type FolderImportProgress } from "../../core/lib/folder-import";
import { scanBookFolder } from "../../core/lib/import";
import { pickLibraryFolderMobile, scanLibraryFolderMobileDetailed } from "../../core/lib/mobile-folder-scan";
import { showOpenDirectoryDialog } from "../../core/lib/dialogs";
import { isMobile, isTauri } from "../../core/lib/env";
import { cn } from "../../core/lib/utils";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "../../ui";
import { FolderImportModal } from "../library/components/modals/FolderImportModal";
import { FolderImportStatus } from "../library/components/FolderImportStatus";
import type { Book } from "../../core/types";

const ROW_BUTTON = cn(
    "w-full flex items-center gap-3 p-4 text-left",
    "border border-[var(--color-border)]",
    "text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)]",
    "transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
);

export const LibraryFoldersSection = memo(function LibraryFoldersSection() {
    const books = useLibraryStore((s) => s.books);
    const removeBooks = useLibraryStore((s) => s.removeBooks);
    const updateBooks = useLibraryStore((s) => s.updateBooks);

    const sourceFolderIndex = useMemo(() => buildSourceFolderIndex(books), [books]);

    const [isScanning, setIsScanning] = useState(false);
    const [scanningRoot, setScanningRoot] = useState<string | null>(null);
    const [folderImportProgress, setFolderImportProgress] = useState<FolderImportProgress | null>(null);
    const [stoppingFolderImport, setStoppingFolderImport] = useState(false);
    const [pendingPickedFolder, setPendingPickedFolder] = useState<string | null>(null);
    const [folderToRemove, setFolderToRemove] = useState<{ root: string; name: string; count: number } | null>(null);
    const [removeFolderDeleteBooks, setRemoveFolderDeleteBooks] = useState(false);

    const abortControllerRef = useRef<AbortController | null>(null);

    const runImport = useCallback(async (root: string, preserve: boolean) => {
        setIsScanning(true);
        setScanningRoot(root);
        setStoppingFolderImport(false);
        abortControllerRef.current = new AbortController();

        const scan = async (folderRoot: string, signal?: AbortSignal) => {
            if (isMobile()) {
                return scanLibraryFolderMobileDetailed(folderRoot);
            }
            return scanBookFolder(folderRoot, signal);
        };

        try {
            const result = await importFolder(
                root,
                preserve,
                {
                    scan,
                    getBooks: () => useLibraryStore.getState().books,
                    addBooks: (batch) => useLibraryStore.getState().addBooks(batch),
                    updateBooks: (updates) => useLibraryStore.getState().updateBooks(updates),
                    onProgress: setFolderImportProgress,
                },
                abortControllerRef.current.signal,
            );
            const summary = describeFolderImport(result);
            if (summary) {
                toast(summary.title, { description: summary.message });
            } else if (!result.cancelled) {
                toast.success(
                    `Folder scan complete: ${result.imported} imported, ${result.alreadyInLibrary} up to date`
                );
            }
        } catch (error) {
            toast.error("Folder scan failed", {
                description: error instanceof Error ? error.message : String(error),
            });
        } finally {
            setIsScanning(false);
            setScanningRoot(null);
            setFolderImportProgress(null);
            setStoppingFolderImport(false);
            abortControllerRef.current = null;
        }
    }, []);

    const handleAddFolder = useCallback(async () => {
        if (!isTauri()) {
            toast.info("Folder scanning requires the desktop or mobile app.");
            return;
        }

        try {
            if (isMobile()) {
                const picked = await pickLibraryFolderMobile();
                if (picked) {
                    setPendingPickedFolder(picked);
                }
            } else {
                const picked = await showOpenDirectoryDialog();
                if (picked) {
                    setPendingPickedFolder(picked);
                }
            }
        } catch (err) {
            toast.error("Could not select folder", {
                description: err instanceof Error ? err.message : String(err),
            });
        }
    }, []);

    const handleConfirmRemoveFolder = useCallback((root: string, deleteBooks: boolean) => {
        const folderName = folderToRemove?.name || root;
        if (deleteBooks) {
            const bookIdsToDelete: string[] = [];
            for (const book of books) {
                if (book.sourceFolders?.some((sf) => sf.root === root)) {
                    bookIdsToDelete.push(book.id);
                }
            }
            if (bookIdsToDelete.length > 0) {
                removeBooks(bookIdsToDelete);
            }
            toast.success(`Removed "${folderName}" and ${bookIdsToDelete.length} ${bookIdsToDelete.length === 1 ? "book" : "books"}`);
        } else {
            const updates: [string, Partial<Book>][] = [];
            for (const book of books) {
                if (book.sourceFolders?.some((sf) => sf.root === root)) {
                    const nextFolders = book.sourceFolders.filter((sf) => sf.root !== root);
                    updates.push([book.id, { sourceFolders: nextFolders }]);
                }
            }
            if (updates.length > 0) {
                updateBooks(updates);
            }
            toast.success(`Removed "${folderName}" from library folders`);
        }
        setFolderToRemove(null);
    }, [books, folderToRemove, removeBooks, updateBooks]);

    const folderEntries = useMemo(() => {
        return Array.from(sourceFolderIndex.entries()).map(([root, { name, folders }]) => {
            const displayName =
                name && name !== root
                    ? name
                    : root.replace(/\\/g, "/").split("/").filter(Boolean).pop() || root;
            const bookCount = folders.get("")?.size ?? 0;
            return { root, name: displayName, bookCount };
        });
    }, [sourceFolderIndex]);

    return (
        <div className="space-y-3">
            {folderImportProgress && (
                <div className="p-3 bg-[var(--color-surface-muted)] border border-[var(--color-border)] rounded-sm">
                    <FolderImportStatus
                        progress={folderImportProgress}
                        stopping={stoppingFolderImport}
                        onStop={() => {
                            setStoppingFolderImport(true);
                            abortControllerRef.current?.abort();
                        }}
                    />
                </div>
            )}

            {folderEntries.map(({ root, name, bookCount }) => {
                const isThisFolderScanning = isScanning && scanningRoot === root;
                return (
                    <div
                        key={root}
                        className="flex items-center justify-between p-4 bg-[var(--color-surface)] border border-[var(--color-border)] gap-3"
                    >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                            <Folder className="w-5 h-5 text-[color:var(--color-accent)] shrink-0" />
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <p className="text-sm font-medium text-[color:var(--color-text-primary)] truncate">
                                        {name}
                                    </p>
                                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--color-surface-muted)] text-[color:var(--color-text-secondary)] shrink-0">
                                        {bookCount} {bookCount === 1 ? "book" : "books"}
                                    </span>
                                </div>
                                <p
                                    className="text-xs text-[color:var(--color-text-muted)] truncate mt-0.5"
                                    title={root}
                                >
                                    {root}
                                </p>
                            </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                            <button
                                type="button"
                                onClick={() => void runImport(root, true)}
                                disabled={isScanning}
                                className="ui-btn px-2.5 py-1 text-xs flex items-center gap-1.5 border transition-colors cursor-pointer disabled:opacity-50"
                                title={`Rescan ${name} for new or changed books`}
                                aria-label={`Rescan ${name}`}
                            >
                                <RefreshCw className={cn("w-3.5 h-3.5", isThisFolderScanning && "animate-spin")} />
                                <span>Rescan</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setRemoveFolderDeleteBooks(false);
                                    setFolderToRemove({ root, name, count: bookCount });
                                }}
                                disabled={isScanning}
                                className="p-1.5 text-[color:var(--color-text-muted)] hover:text-red-500 rounded transition-colors cursor-pointer disabled:opacity-50"
                                title={`Remove ${name} folder`}
                                aria-label={`Remove ${name} folder`}
                            >
                                <Trash2 className="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                );
            })}

            {isTauri() ? (
                <button
                    type="button"
                    onClick={handleAddFolder}
                    disabled={isScanning}
                    className={ROW_BUTTON}
                >
                    <FolderPlus className="w-5 h-5 text-[color:var(--color-text-muted)] shrink-0" aria-hidden="true" />
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-sans text-[color:var(--color-text-primary)]">
                            {folderEntries.length === 0 ? "Add Library Folder…" : "Add Another Folder…"}
                        </p>
                        <p className="text-xs text-[color:var(--color-text-muted)] mt-0.5">
                            {folderEntries.length === 0
                                ? "Choose a folder on your device to scan and add its books to Theorem"
                                : "Connect another folder from your device"}
                        </p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-[color:var(--color-text-muted)] shrink-0" aria-hidden="true" />
                </button>
            ) : (
                <div className="p-4 border border-[var(--color-border)] bg-[var(--color-surface-muted)] text-xs text-[color:var(--color-text-muted)]">
                    Folder connection is available in the Theorem desktop and mobile apps.
                </div>
            )}

            {pendingPickedFolder && (
                <FolderImportModal
                    isOpen={!!pendingPickedFolder}
                    onClose={() => setPendingPickedFolder(null)}
                    onContinue={(preserve) => {
                        const path = pendingPickedFolder;
                        setPendingPickedFolder(null);
                        void runImport(path, preserve);
                    }}
                />
            )}

            {folderToRemove && (
                <Modal isOpen={!!folderToRemove} onClose={() => setFolderToRemove(null)} size="sm" showCloseButton={true}>
                    <ModalHeader title="Remove Folder" onClose={() => setFolderToRemove(null)} showCloseButton={true} />
                    <ModalBody>
                        <p className="text-sm leading-relaxed text-[color:var(--color-text-primary)] font-medium">
                            Remove &ldquo;{folderToRemove.name}&rdquo; from your library?
                        </p>
                        <p className="text-xs text-[color:var(--color-text-muted)] mt-1 truncate" title={folderToRemove.root}>
                            {folderToRemove.root}
                        </p>
                        <p className="text-xs text-[color:var(--color-text-muted)] mt-3">
                            Your original book files on your device will never be deleted.
                        </p>
                        {folderToRemove.count > 0 && (
                            <label className="flex items-center gap-2 mt-4 text-xs text-[color:var(--color-text-primary)] cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={removeFolderDeleteBooks}
                                    onChange={(e) => setRemoveFolderDeleteBooks(e.target.checked)}
                                    className="rounded border-[var(--color-border)] text-[color:var(--color-accent)]"
                                />
                                <span>Also remove {folderToRemove.count} {folderToRemove.count === 1 ? "book" : "books"} from Theorem library</span>
                            </label>
                        )}
                    </ModalBody>
                    <ModalFooter>
                        <button
                            type="button"
                            onClick={() => setFolderToRemove(null)}
                            className="ui-btn-ghost"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                handleConfirmRemoveFolder(folderToRemove.root, removeFolderDeleteBooks);
                            }}
                            className="ui-btn-danger"
                        >
                            Remove Folder
                        </button>
                    </ModalFooter>
                </Modal>
            )}
        </div>
    );
});
