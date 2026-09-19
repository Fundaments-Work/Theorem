import { useState } from "react";
import { BookOpen, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useLibraryStore, useUIStore, getLibraryTitleSet, normalizeLibraryTitle } from "../../../core/store";
import { DiscoverService } from "../../../core/services/DiscoverService";
import type { OpdsEntry } from "../../../core/types";
import { Modal, ModalBody, ModalFooter, ModalHeader, TheoremBookCover } from "../../../ui";

export interface DiscoverDetailModalProps {
    entry: OpdsEntry | null;
    onClose: () => void;
}

export function DiscoverDetailModal({ entry, onClose }: DiscoverDetailModalProps) {
    const setRoute = useUIStore((state) => state.setRoute);
    const [isDownloading, setIsDownloading] = useState(false);

    const books = useLibraryStore((state) => state.books);
    const existingBook = getLibraryTitleSet(books).has(normalizeLibraryTitle(entry?.title ?? ""))
        ? books.find((b) => normalizeLibraryTitle(b.title) === normalizeLibraryTitle(entry?.title ?? ""))
        : undefined;

    if (!entry) return null;

    const handleDownload = async () => {
        setIsDownloading(true);
        const toastId = toast.loading(`Adding "${entry.title}" to Library…`);
        try {
            await DiscoverService.downloadBook(entry, (msg) => {
                toast.loading(msg, { id: toastId });
            });
            toast.success(`"${entry.title}" is in your Library`, {
                id: toastId,
            });
        } catch (err: any) {
            toast.error(err.message || "Failed to download book", { id: toastId });
        } finally {
            setIsDownloading(false);
        }
    };

    const handleReadNow = () => {
        if (existingBook) {
            setRoute("reader", existingBook.id);
            onClose();
        }
    };

    return (
        <Modal isOpen={!!entry} onClose={onClose}>
            <ModalHeader title={entry.title} onClose={onClose} />
            <ModalBody className="space-y-5">
                <div className="flex flex-col sm:flex-row gap-5">
                    {/* Cover Preview */}
                    <div className="aspect-[2/3] w-28 sm:w-32 shrink-0 rounded-lg overflow-hidden border border-[var(--color-border)] shadow-md">
                        <TheoremBookCover
                            title={entry.title}
                            author={entry.author}
                            coverUrl={entry.coverUrl || entry.thumbnailUrl}
                        />
                    </div>

                    {/* Metadata Details */}
                    <div className="flex flex-col justify-between py-0.5 space-y-2 min-w-0">
                        <div>
                            <h3 className="text-base font-bold text-[color:var(--color-text-primary)] leading-tight">
                                {entry.title}
                            </h3>
                            <p className="text-xs font-semibold text-[color:var(--color-accent)] mt-1">
                                {entry.author || "Public Domain"}
                            </p>
                        </div>

                        <div className="flex flex-wrap gap-2 text-[11px] text-[color:var(--color-text-muted)] pt-2">
                            {entry.publisher && (
                                <span className="px-2 py-0.5 rounded bg-[var(--color-surface-muted)] border border-[var(--color-border)]">
                                    {entry.publisher}
                                </span>
                            )}
                            {entry.language && (
                                <span className="px-2 py-0.5 rounded bg-[var(--color-surface-muted)] border border-[var(--color-border)] uppercase">
                                    {entry.language}
                                </span>
                            )}
                            <span className="px-2 py-0.5 rounded bg-[var(--color-surface-muted)] border border-[var(--color-border)] uppercase">
                                {entry.downloadFormat || "EPUB"}
                            </span>
                        </div>
                    </div>
                </div>

                {/* Synopsis / Description */}
                {entry.summary && (
                    <div className="border-t border-[var(--color-border)] pt-3.5 space-y-1.5">
                        <h4 className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-text-muted)]">
                            Synopsis
                        </h4>
                        <p className="text-xs text-[color:var(--color-text-secondary)] leading-relaxed max-h-52 overflow-y-auto pr-1 select-text">
                            {entry.summary}
                        </p>
                    </div>
                )}
            </ModalBody>

            <ModalFooter>
                <button
                    onClick={onClose}
                    className="px-4 py-2 border border-[var(--color-border)] text-xs font-semibold text-[color:var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)] rounded transition-colors"
                >
                    Close
                </button>

                {existingBook ? (
                    <button
                        onClick={handleReadNow}
                        className="px-4 py-2 bg-[var(--color-text-primary)] text-[var(--color-background)] text-xs font-bold rounded hover:opacity-90 transition-opacity flex items-center gap-1.5"
                    >
                        <BookOpen className="h-3.5 w-3.5" />
                        <span>Read Now</span>
                    </button>
                ) : (
                    <button
                        onClick={handleDownload}
                        disabled={isDownloading}
                        className="px-4 py-2 bg-[var(--color-text-primary)] text-[var(--color-background)] text-xs font-bold rounded hover:opacity-90 transition-opacity flex items-center gap-1.5 disabled:opacity-50"
                    >
                        {isDownloading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Download className="h-3.5 w-3.5" />
                        )}
                        <span>{isDownloading ? "Downloading…" : "Add to Library"}</span>
                    </button>
                )}
            </ModalFooter>
        </Modal>
    );
}
