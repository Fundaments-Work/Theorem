import { useState, useCallback } from "react";
import type { Annotation, Book } from "../../../core/types";
import { shareOnX, buildShareText } from "../../../core/lib/share";
import { ExternalLink, Image, AlertCircle } from "lucide-react";
import { ShareCardModal } from "../../share/ShareCardModal";

interface ShareMenuProps {
    annotation: Annotation;
    book: Pick<Book, "title" | "author"> | undefined;
    onClose: () => void;
}

export function ShareMenu({ annotation, book, onClose }: ShareMenuProps) {
    const [showStudio, setShowStudio] = useState(false);
    const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

    const handleShareOnX = useCallback(() => {
        const text = buildShareText(annotation, book);
        const popup = shareOnX(text);
        if (popup === null) {
            setToast({ type: "error", message: "Popup was blocked" });
        } else {
            onClose();
        }
    }, [annotation, book, onClose]);

    if (showStudio) {
        return (
            <ShareCardModal
                kind="annotation"
                annotation={annotation}
                book={book}
                onClose={onClose}
            />
        );
    }

    return (
        <>
            
            <div className="absolute right-0 top-full z-20 mt-1 w-48 border border-[var(--color-border)] bg-[var(--color-surface)] py-1">
                {toast && (
                    <div className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs text-[var(--color-error)] border-b border-[var(--color-border)]">
                        <AlertCircle className="w-3 h-3" />
                        {toast.message}
                    </div>
                )}
                <button
                    onClick={() => setShowStudio(true)}
                    className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left font-sans text-[11px] text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)]"
                >
                    <Image className="w-3.5 h-3.5" />
                    Share as Image
                </button>
                <button
                    onClick={handleShareOnX}
                    className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left font-sans text-[11px] text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-muted)]"
                >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Share on X
                </button>
            </div>
        </>
    );
}