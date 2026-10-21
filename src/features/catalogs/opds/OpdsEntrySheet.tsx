import { useEffect, useMemo, useState } from "react";
import { BookOpen, Download, ExternalLink, Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import { sanitizeHtmlForDisplay } from "../../../core/lib/sanitize";
import { openExternalUrl } from "../../../core/lib/open-external-url";
import { OpdsService, describeOpdsError } from "../../../core/services/OpdsService";
import { getLibraryTitleSet, normalizeLibraryTitle, useLibraryStore, useUIStore } from "../../../core/store";
import type { OpdsAcquisition, OpdsCredentials, OpdsEntry } from "../../../core/types";
import { Modal, ModalBody, ModalFooter, ModalHeader, TheoremBookCover } from "../../../ui";
import { cn } from "../../../core/lib/utils";
import { useCatalogDownload } from "./useCatalogDownload";
import {
    WEBSITE_REASON_LABEL,
    acquisitionLabel,
    entryAction,
    entryAuthor,
    languageName,
    priceLabel,
} from "./opds-ui-utils";

export interface OpdsEntrySheetProps {
    entry: OpdsEntry | null;
    auth?: OpdsCredentials;
    onClose: () => void;
    /** Open a related feed (an author's books, a subject) in the browser. Absent in Discover. */
    onOpenFeed?: (href: string, title: string) => void;
}

const chip = "border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-0.5 text-[11px] text-[color:var(--color-text-muted)]";

export function OpdsEntrySheet({ entry, auth, onClose, onOpenFeed }: OpdsEntrySheetProps) {
    const setRoute = useUIStore((state) => state.setRoute);
    const books = useLibraryStore((state) => state.books);
    const { download, isBusy } = useCatalogDownload(auth);

    const [full, setFull] = useState<OpdsEntry | null>(entry);
    const [loadingDetail, setLoadingDetail] = useState(false);
    const [detailError, setDetailError] = useState<string | null>(null);

    // A listing that only links to the book's own page: fetch that page for the downloads.
    useEffect(() => {
        setFull(entry);
        setDetailError(null);
        if (!entry || entryAction(entry).kind !== "partial") return;
        let cancelled = false;
        setLoadingDetail(true);
        OpdsService.loadDetail(entry, auth)
            .then((detail) => {
                if (!cancelled) setFull(detail);
            })
            .catch((error) => {
                if (!cancelled) setDetailError(describeOpdsError(error));
            })
            .finally(() => {
                if (!cancelled) setLoadingDetail(false);
            });
        return () => {
            cancelled = true;
        };
    }, [entry, auth]);

    const shown = full ?? entry;
    const titleKey = normalizeLibraryTitle(shown?.title ?? "");
    const existingBook = useMemo(
        () => (shown && getLibraryTitleSet(books).has(titleKey) ? books.find((b) => normalizeLibraryTitle(b.title) === titleKey) : undefined),
        [books, shown, titleKey],
    );
    const summary = useMemo(() => (shown?.summary ? sanitizeHtmlForDisplay(shown.summary) : null), [shown?.summary]);

    if (!entry || !shown) return null;

    const action = entryAction(shown);
    const author = entryAuthor(shown);
    const direct = shown.acquisitions.filter((a) => a.downloadable && a.kind !== "sample");
    const samples = shown.acquisitions.filter((a) => a.kind === "sample" && a.downloadable);
    const others = shown.acquisitions.filter((a) => !a.downloadable && a.kind !== "sample");
    const busy = isBusy(shown.id);

    const getAcquisition = async (acquisition: OpdsAcquisition) => {
        // Reuse the shared flow, pointing it at the chosen file rather than the "best" one.
        const ok = await download({ ...shown, acquisitions: [acquisition], primary: 0 });
        if (ok) onClose();
    };

    const openWebsite = (url: string) => {
        openExternalUrl(url).catch(() => toast.error("Could not open the website."));
    };

    const metaChips = [
        shown.series ? `${shown.series.name}${shown.series.position !== undefined ? ` #${shown.series.position}` : ""}` : null,
        shown.publisher,
        languageName(shown.language),
        shown.published ? shown.published.slice(0, 4) : null,
    ].filter(Boolean) as string[];

    return (
        <Modal isOpen onClose={onClose} size="lg">
            <ModalHeader title={shown.title} onClose={onClose} />
            <ModalBody className="space-y-5">
                <div className="flex flex-col gap-5 sm:flex-row">
                    <div className="aspect-[2/3] w-28 shrink-0 overflow-hidden border border-[var(--color-border)] sm:w-32">
                        <TheoremBookCover title={shown.title} author={author || undefined} coverUrl={shown.cover || shown.thumbnail} />
                    </div>
                    <div className="min-w-0 space-y-2 py-0.5">
                        <h3 className="text-base leading-tight text-[color:var(--color-text-primary)]">{shown.title}</h3>
                        {shown.subtitle && <p className="text-xs text-[color:var(--color-text-secondary)]">{shown.subtitle}</p>}
                        {author && <p className="text-xs text-[color:var(--color-accent)]">{author}</p>}
                        {metaChips.length > 0 && (
                            <div className="flex flex-wrap gap-2 pt-1">
                                {metaChips.map((c) => (
                                    <span key={c} className={chip}>
                                        {c}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* Downloads */}
                <div className="space-y-2 border-t border-[var(--color-border)] pt-4" aria-live="polite">
                    {loadingDetail && (
                        <p className="flex items-center gap-2 text-xs text-[color:var(--color-text-muted)]">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Finding the download…
                        </p>
                    )}
                    {detailError && <p className="text-xs text-[color:var(--color-error)]">{detailError}</p>}

                    {direct.length > 0 && (
                        <ul className="space-y-1.5">
                            {direct.map((a) => {
                                const isPrimary = shown.primary !== undefined && shown.acquisitions[shown.primary] === a;
                                return (
                                    <li key={a.href}>
                                        <button
                                            type="button"
                                            disabled={busy || Boolean(existingBook)}
                                            onClick={() => void getAcquisition(a)}
                                            className={cn(
                                                "flex w-full items-center justify-between gap-3 border px-3 py-2 text-left text-xs transition-colors disabled:opacity-50",
                                                isPrimary
                                                    ? "border-[var(--color-accent)] text-[color:var(--color-text-primary)]"
                                                    : "border-[var(--color-border)] text-[color:var(--color-text-secondary)] hover:border-[var(--color-text-muted)]",
                                            )}
                                        >
                                            <span className="truncate">{acquisitionLabel(a)}</span>
                                            <Download className="h-3.5 w-3.5 shrink-0" />
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}

                    {samples.length > 0 && direct.length === 0 && (
                        <ul className="space-y-1.5">
                            {samples.map((a) => (
                                <li key={a.href}>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => void getAcquisition(a)}
                                        className="flex w-full items-center justify-between gap-3 border border-[var(--color-border)] px-3 py-2 text-left text-xs text-[color:var(--color-text-secondary)] hover:border-[var(--color-text-muted)]"
                                    >
                                        <span className="truncate">{acquisitionLabel(a)}</span>
                                        <Download className="h-3.5 w-3.5 shrink-0" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}

                    {others.length > 0 && direct.length === 0 && (
                        <div className="space-y-1.5">
                            {others.map((a) => (
                                <p key={a.href} className="flex items-center gap-2 text-xs text-[color:var(--color-text-secondary)]">
                                    {a.drm && <Lock className="h-3.5 w-3.5 shrink-0" />}
                                    <span>
                                        {acquisitionLabel(a)}
                                        {priceLabel(a) ? ` · ${priceLabel(a)}` : ""}
                                    </span>
                                </p>
                            ))}
                            {action.kind === "website" && (
                                <p className="text-xs text-[color:var(--color-text-muted)]">{WEBSITE_REASON_LABEL[action.reason]}</p>
                            )}
                        </div>
                    )}

                    {!loadingDetail && !detailError && direct.length === 0 && samples.length === 0 && others.length === 0 && (
                        <p className="text-xs text-[color:var(--color-text-muted)]">
                            {action.kind === "website" ? WEBSITE_REASON_LABEL[action.reason] : "This entry has no download."}
                        </p>
                    )}
                </div>

                {summary && (
                    <div className="space-y-1.5 border-t border-[var(--color-border)] pt-3.5">
                        <h4 className="text-[11px] text-[color:var(--color-text-muted)]">Synopsis</h4>
                        <div
                            className="max-h-52 select-text overflow-y-auto pr-1 text-xs leading-relaxed text-[color:var(--color-text-secondary)] [&_a]:text-[color:var(--color-accent)] [&_p]:mb-2"
                            dangerouslySetInnerHTML={summary}
                        />
                    </div>
                )}

                {onOpenFeed && ((shown.related?.length ?? 0) > 0 || (shown.categories?.length ?? 0) > 0) && (
                    <div className="space-y-2 border-t border-[var(--color-border)] pt-3.5">
                        {(shown.related?.length ?? 0) > 0 && (
                            <div className="flex flex-wrap gap-2">
                                {shown.related!.slice(0, 8).map((link) => (
                                    <button
                                        key={link.href}
                                        type="button"
                                        onClick={() => {
                                            onOpenFeed(link.href, link.title ?? "Related");
                                            onClose();
                                        }}
                                        className={cn(chip, "transition-colors hover:text-[color:var(--color-accent)]")}
                                    >
                                        {link.title ?? link.href}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </ModalBody>

            <ModalFooter>
                <button
                    type="button"
                    onClick={onClose}
                    className="border border-[var(--color-border)] px-4 py-2 text-xs text-[color:var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-muted)]"
                >
                    Close
                </button>

                {existingBook ? (
                    <button
                        type="button"
                        onClick={() => {
                            setRoute("reader", existingBook.id);
                            onClose();
                        }}
                        className="flex items-center gap-1.5 bg-[var(--color-text-primary)] px-4 py-2 text-xs text-[var(--color-background)] transition-opacity hover:opacity-90"
                    >
                        <BookOpen className="h-3.5 w-3.5" /> Read Now
                    </button>
                ) : action.kind === "website" ? (
                    action.url ? (
                        <button
                            type="button"
                            onClick={() => openWebsite(action.url!)}
                            className="flex items-center gap-1.5 bg-[var(--color-text-primary)] px-4 py-2 text-xs text-[var(--color-background)] transition-opacity hover:opacity-90"
                        >
                            <ExternalLink className="h-3.5 w-3.5" /> Open website
                        </button>
                    ) : null
                ) : action.kind === "none" ? null : (
                    <button
                        type="button"
                        disabled={busy || loadingDetail}
                        onClick={() => {
                            void download(shown).then((ok) => ok && onClose());
                        }}
                        className="flex items-center gap-1.5 bg-[var(--color-text-primary)] px-4 py-2 text-xs text-[var(--color-background)] transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                        {busy ? "Adding…" : "Add to Library"}
                    </button>
                )}
            </ModalFooter>
        </Modal>
    );
}
