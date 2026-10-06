import { useState, useEffect, useMemo } from "react";
import { Modal, ModalBody, ModalFooter } from "../../../../ui";
import { useLibraryStore } from "../../../../core/store";
import { cn } from "../../../../core/lib/utils";
import { isMobile } from "../../../../core/lib/env";
import { Layers, Hash, ArrowUpDown, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface AssignSeriesModalProps {
    isOpen: boolean;
    onClose: () => void;
    bookIds: string[];
    initialSeriesName?: string;
    shelfId?: string;
}

interface BookVolumeEntry {
    bookId: string;
    title: string;
    author?: string;
    seriesIndex: string;
}

export function AssignSeriesModal({
    isOpen,
    onClose,
    bookIds,
    initialSeriesName,
    shelfId,
}: AssignSeriesModalProps) {
    const books = useLibraryStore((s) => s.books);
    const updateBookMetadata = useLibraryStore((s) => s.updateBookMetadata);
    const updateCollection = useLibraryStore((s) => s.updateCollection);
    const mobile = isMobile();

    // Collect all existing series in the library for suggestions
    const existingSeriesList = useMemo(() => {
        const set = new Set<string>();
        for (const b of books) {
            if (b.series?.trim()) {
                set.add(b.series.trim());
            }
        }
        return Array.from(set).sort((a, b) => a.localeCompare(b));
    }, [books]);

    const targetBooks = useMemo(() => {
        const idSet = new Set(bookIds);
        return books.filter((b) => idSet.has(b.id));
    }, [books, bookIds]);

    const [seriesName, setSeriesName] = useState("");
    const [entries, setEntries] = useState<BookVolumeEntry[]>([]);

    useEffect(() => {
        if (!isOpen) return;

        // Determine initial series name
        if (initialSeriesName) {
            setSeriesName(initialSeriesName);
        } else {
            const commonSeries = targetBooks.find((b) => b.series?.trim())?.series?.trim() || "";
            setSeriesName(commonSeries);
        }

        // Initialize book entries
        const mapped: BookVolumeEntry[] = targetBooks.map((b, idx) => ({
            bookId: b.id,
            title: b.title,
            author: b.author,
            seriesIndex: b.seriesIndex !== undefined ? String(b.seriesIndex) : String(idx + 1),
        }));
        setEntries(mapped);
    }, [isOpen, targetBooks, initialSeriesName]);

    const handleAutoNumber = () => {
        setEntries((prev) =>
            prev.map((entry, idx) => ({
                ...entry,
                seriesIndex: String(idx + 1),
            }))
        );
    };

    const handleVolumeChange = (bookId: string, value: string) => {
        setEntries((prev) =>
            prev.map((e) => (e.bookId === bookId ? { ...e, seriesIndex: value } : e))
        );
    };

    const handleClearSeries = () => {
        for (const entry of entries) {
            updateBookMetadata(entry.bookId, {
                series: undefined,
                seriesIndex: undefined,
            });
        }
        toast.success(`Removed series from ${entries.length} ${entries.length === 1 ? "book" : "books"}`);
        onClose();
    };

    const handleSave = (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = seriesName.trim();
        if (!trimmed) {
            toast.error("Please enter a series name or click remove series.");
            return;
        }

        for (const entry of entries) {
            const parsed = entry.seriesIndex.trim() ? parseFloat(entry.seriesIndex.trim()) : undefined;
            updateBookMetadata(entry.bookId, {
                series: trimmed,
                seriesIndex: !isNaN(Number(parsed)) ? parsed : undefined,
            });
        }

        if (shelfId) {
            updateCollection(shelfId, { groupBySeries: true });
        }

        toast.success(`Assigned ${entries.length} ${entries.length === 1 ? "book" : "books"} to "${trimmed}"`);
        onClose();
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            size="lg"
            className={cn(
                // Phones: keep a gutter so the panel isn't flush to the screen edges
                // and the controls never sit under a system gesture area.
                // Desktop keeps the centred 36rem dialog.
                mobile ? "w-[calc(100%-1.5rem)] max-w-full" : undefined,
            )}
        >
            {/* `flex h-full min-h-0 flex-col` lets ModalBody actually scroll inside
                the dialog's max-height clamp. Without it the form is a block box, so
                the body grows to full content height and the footer gets clipped. */}
            <form onSubmit={handleSave} className="flex h-full min-h-0 flex-col">
                <ModalBody className="pb-[calc(var(--spacing-lg)+env(safe-area-inset-bottom))] sm:pb-5">
                    <div className="space-y-6">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 flex items-center justify-center bg-[var(--color-accent)]/10 text-[color:var(--color-accent)] border border-[var(--color-accent)]/20 shrink-0">
                                <Layers className="w-5 h-5" />
                            </div>
                            <div>
                                <h2 className="text-base font-bold text-[color:var(--color-text-primary)]">
                                    Set Book Series
                                </h2>
                                <p className="text-xs text-[color:var(--color-text-muted)]">
                                    Organize {entries.length} {entries.length === 1 ? "book" : "books"} into a sequential series.
                                </p>
                            </div>
                        </div>

                        <div>
                            <label
                                htmlFor="series-name-input"
                                className="block text-xs font-bold uppercase tracking-wider text-[color:var(--color-text-secondary)] mb-1.5"
                            >
                                Series Name
                            </label>
                            <input
                                id="series-name-input"
                                type="text"
                                list="existing-series-list"
                                value={seriesName}
                                onChange={(e) => setSeriesName(e.target.value)}
                                placeholder="e.g. Dune, The Dark Tower, Foundation"
                                className="ui-input w-full font-medium"
                                autoFocus={!mobile}
                            />
                            <datalist id="existing-series-list">
                                {existingSeriesList.map((s) => (
                                    <option key={s} value={s} />
                                ))}
                            </datalist>
                        </div>

                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-text-secondary)] flex items-center gap-1.5">
                                    <Hash className="w-3.5 h-3.5 text-[color:var(--color-accent)]" />
                                    Volumes & Reading Order
                                </span>
                                <button
                                    type="button"
                                    onClick={handleAutoNumber}
                                    className="ui-btn px-2 py-1 text-[11px] font-bold border flex items-center gap-1 hover:bg-[var(--color-surface-muted)]"
                                    title="Auto-number volumes sequentially 1..N"
                                >
                                    <ArrowUpDown className="w-3 h-3" />
                                    Auto-number (1..N)
                                </button>
                            </div>

                            <div className="max-h-[38vh] sm:max-h-[280px] overflow-y-auto overscroll-contain border border-[var(--color-border)] divide-y divide-[var(--color-border)] bg-[var(--color-surface-muted)]/30">
                                {entries.map((entry) => (
                                    <div
                                        key={entry.bookId}
                                        className="flex items-center justify-between p-2.5 gap-3 hover:bg-[var(--color-surface-muted)]/60 transition-colors"
                                    >
                                        <div className="min-w-0 flex-1">
                                            <p className="text-xs font-semibold text-[color:var(--color-text-primary)] truncate">
                                                {entry.title}
                                            </p>
                                            {entry.author && (
                                                <p className="text-[11px] text-[color:var(--color-text-muted)] truncate">
                                                    {entry.author}
                                                </p>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                            <label
                                                htmlFor={`vol-${entry.bookId}`}
                                                className="text-[10px] uppercase font-bold text-[color:var(--color-text-muted)]"
                                            >
                                                Vol.
                                            </label>
                                            <input
                                                id={`vol-${entry.bookId}`}
                                                type="number"
                                                step="any"
                                                min="0"
                                                value={entry.seriesIndex}
                                                onChange={(e) => handleVolumeChange(entry.bookId, e.target.value)}
                                                className="ui-input w-16 text-center text-xs py-1 h-8 font-mono"
                                                placeholder="Vol #"
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </ModalBody>
                <ModalFooter className="pb-[calc(var(--spacing-md)+env(safe-area-inset-bottom))] sm:pb-4">
                    {/* Phones: full-width stacked actions so no control is squeezed
                        below a tappable size. Desktop keeps the single-row layout. */}
                    <div className="flex flex-col-reverse gap-2 w-full sm:flex-row sm:items-center sm:justify-between">
                        <button
                            type="button"
                            onClick={handleClearSeries}
                            className="ui-btn px-3 py-2.5 text-xs font-bold border w-full sm:w-auto border-[var(--color-error)]/30 text-[color:var(--color-error)] hover:bg-[var(--color-error)]/10 flex items-center justify-center gap-1.5 touch-manipulation"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            Remove from Series
                        </button>
                        <div className="flex items-center gap-2 w-full sm:w-auto">
                            <button
                                type="button"
                                onClick={onClose}
                                className="ui-btn-ghost text-xs flex-1 sm:flex-none touch-manipulation"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={!seriesName.trim()}
                                className={cn(
                                    "ui-btn-primary text-xs flex-1 sm:flex-none touch-manipulation",
                                    "disabled:opacity-50 disabled:cursor-not-allowed"
                                )}
                            >
                                Save Series
                            </button>
                        </div>
                    </div>
                </ModalFooter>
            </form>
        </Modal>
    );
}
