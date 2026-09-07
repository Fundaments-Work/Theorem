import { useState, useCallback, useEffect, useRef } from "react";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "../../ui";
import { Download, Share2, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { downloadImage, shareImageNative, buildImageFilename, shareOnX, buildShareText } from "../../core/lib/share";
import { ShareCard, type CardFormat, type CardTheme, type BookInfo, type StatsData } from "./ShareCard";
import type { Annotation } from "../../core/types";

interface AnnotationShareProps {
    kind: "annotation";
    annotation: Annotation;
    book: BookInfo | undefined;
}

interface StatsShareProps {
    kind: "stats";
    statsData: StatsData;
}

type ShareCardModalProps = (AnnotationShareProps | StatsShareProps) & {
    onClose: () => void;
};

const CARD_W = 1080;

export function ShareCardModal(props: ShareCardModalProps) {
    const { kind, onClose } = props;
    const annotation = kind === "annotation" ? (props as AnnotationShareProps).annotation : undefined;
    const book = kind === "annotation" ? (props as AnnotationShareProps).book : undefined;
    const statsData = kind === "stats" ? (props as StatsShareProps).statsData : undefined;

    const [format, setFormat] = useState<CardFormat>("square");
    const [theme, setTheme] = useState<CardTheme>("match");
    const [showNote, setShowNote] = useState(true);
    const [isGenerating, setIsGenerating] = useState(false);
    const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

    const cardH = format === "story" ? 1920 : 1080;

    const containerRef = useRef<HTMLDivElement>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    const [scale, setScale] = useState(0.28);

    // Dynamically calculate the scale to perfectly fit preview container without distortion
    useEffect(() => {
        const updateScale = () => {
            if (!containerRef.current) return;
            const { clientWidth, clientHeight } = containerRef.current;
            if (clientWidth > 0 && clientHeight > 0) {
                const padding = 32;
                const scaleX = (clientWidth - padding) / CARD_W;
                const scaleY = (clientHeight - padding) / cardH;
                const calculatedScale = Math.min(scaleX, scaleY, 0.45);
                setScale(Math.max(0.15, calculatedScale));
            }
        };

        updateScale();
        const observer = new ResizeObserver(updateScale);
        if (containerRef.current) {
            observer.observe(containerRef.current);
        }
        return () => observer.disconnect();
    }, [cardH]);

    useEffect(() => {
        if (toast) {
            const t = setTimeout(() => setToast(null), 3000);
            return () => clearTimeout(t);
        }
    }, [toast]);

    const generateBlob = useCallback(async (): Promise<Blob | null> => {
        if (!cardRef.current) return null;
        setIsGenerating(true);
        try {
            await document.fonts.ready;
            const { toBlob } = await import("html-to-image");
            const blob = await toBlob(cardRef.current, {
                quality: 0.95,
                pixelRatio: 2,
                cacheBust: true,
                width: CARD_W,
                height: cardH,
                style: {
                    transform: "none",
                    margin: "0",
                    borderRadius: "0",
                    boxShadow: "none",
                },
            });
            return blob;
        } catch {
            setToast({ type: "error", message: "Failed to generate high-resolution image" });
            return null;
        } finally {
            setIsGenerating(false);
        }
    }, [cardH]);

    const handleDownload = useCallback(async () => {
        const blob = await generateBlob();
        if (!blob) return;
        const filename = buildImageFilename(kind === "annotation" ? book?.title || "Highlight" : "ReadingStats");
        const result = await downloadImage(blob, filename);
        if (result.ok) {
            setToast({ type: "success", message: "Image saved" });
        } else if (result.reason !== "Cancelled") {
            setToast({ type: "error", message: result.reason });
        }
    }, [generateBlob, book, kind]);

    const handleNativeShare = useCallback(async () => {
        const blob = await generateBlob();
        if (!blob) return;
        try {
            await shareImageNative(blob, kind === "annotation" ? book?.title || "Highlight" : "ReadingStats");
            onClose();
        } catch {
            setToast({ type: "error", message: "Share failed" });
        }
    }, [generateBlob, book, kind, onClose]);

    const handleShareOnX = useCallback(() => {
        if (kind === "annotation" && annotation) {
            const text = buildShareText(annotation, book);
            shareOnX(text);
            onClose();
        }
    }, [kind, annotation, book, onClose]);

    return (
        <Modal isOpen={true} onClose={onClose} size="xl" className="max-w-[52rem]">
            <ModalHeader title={kind === "annotation" ? "Share Highlight" : "Share Reading Stats"} onClose={onClose} />
            <ModalBody className="flex flex-col md:flex-row gap-6 p-4 sm:p-6 items-stretch">
                {/* Real-time Live Scaled Preview Container */}
                <div
                    ref={containerRef}
                    className="flex-1 flex items-center justify-center bg-[var(--color-surface-muted)] border border-[var(--color-border)] p-4 relative min-h-[320px] max-h-[50vh] md:max-h-[460px] overflow-hidden rounded-md"
                >
                    {isGenerating && (
                        <div className="absolute inset-0 z-20 flex items-center justify-center bg-[var(--color-surface)]/80 backdrop-blur-sm">
                            <div className="flex items-center gap-2 font-sans text-sm text-[var(--color-text-primary)] font-medium">
                                <Loader2 className="w-4 h-4 animate-spin text-[var(--color-accent)]" />
                                Exporting high-res image...
                            </div>
                        </div>
                    )}

                    {/* Scaled Preview Wrapper with exact aspect ratio */}
                    <div
                        style={{
                            width: CARD_W * scale,
                            height: cardH * scale,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            position: "relative",
                            flexShrink: 0,
                        }}
                    >
                        <div
                            ref={cardRef}
                            style={{
                                width: CARD_W,
                                height: cardH,
                                transform: `scale(${scale})`,
                                transformOrigin: "top left",
                                position: "absolute",
                                top: 0,
                                left: 0,
                                borderRadius: 16,
                                overflow: "hidden",
                                boxShadow: "0 16px 48px -8px rgba(0, 0, 0, 0.2)",
                            }}
                        >
                            <ShareCard
                                kind={kind}
                                annotation={annotation}
                                book={book}
                                statsData={statsData}
                                format={format}
                                theme={theme}
                                showNote={kind === "annotation" ? showNote : false}
                            />
                        </div>
                    </div>
                </div>

                {/* Sidebar Options */}
                <div className="w-full md:w-56 flex flex-col gap-5 shrink-0 justify-center">
                    <div>
                        <h3 className="text-[11px] uppercase tracking-wider font-semibold text-[color:var(--color-text-secondary)] mb-2.5">
                            Format
                        </h3>
                        <div className="grid grid-cols-2 md:grid-cols-1 gap-1.5">
                            {([["square", "Square (1:1)"], ["story", "Story (9:16)"]] as const).map(([val, label]) => (
                                <button
                                    key={val}
                                    onClick={() => setFormat(val)}
                                    className={`ui-btn w-full justify-center md:justify-start text-xs ${format === val ? "ui-btn-primary" : ""}`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div>
                        <h3 className="text-[11px] uppercase tracking-wider font-semibold text-[color:var(--color-text-secondary)] mb-2.5">
                            Theme
                        </h3>
                        <div className="grid grid-cols-2 md:grid-cols-1 gap-1.5">
                            {([["match", "App Theme"], ["dark", "Dark"], ["tinted", "Tinted"], ["sepia", "Sepia"]] as const).map(([val, label]) => (
                                <button
                                    key={val}
                                    onClick={() => setTheme(val)}
                                    className={`ui-btn w-full justify-center md:justify-start text-xs ${theme === val ? "ui-btn-primary" : ""}`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {kind === "annotation" && annotation?.noteContent && (
                        <div>
                            <h3 className="text-[11px] uppercase tracking-wider font-semibold text-[color:var(--color-text-secondary)] mb-2.5">
                                Options
                            </h3>
                            <label className="flex items-center gap-2 cursor-pointer text-xs font-sans text-[color:var(--color-text-primary)]">
                                <input
                                    type="checkbox"
                                    checked={showNote}
                                    onChange={(e) => setShowNote(e.target.checked)}
                                    className="w-4 h-4 rounded"
                                />
                                Include my note
                            </label>
                        </div>
                    )}
                </div>
            </ModalBody>

            <ModalFooter>
                {toast && (
                    <div className={`absolute bottom-full left-0 right-0 mb-2 flex items-center justify-center gap-1.5 text-xs py-2 rounded bg-[var(--color-surface)] border border-[var(--color-border)] shadow-lg ${toast.type === "success" ? "text-[var(--color-success,#22c55e)]" : "text-[var(--color-error)]"}`}>
                        {toast.type === "success" ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                        {toast.message}
                    </div>
                )}
                <div className="flex-1" />
                {kind === "annotation" && (
                    <button className="ui-btn-ghost shrink-0" onClick={handleShareOnX} disabled={isGenerating}>
                        <Share2 className="w-4 h-4" />
                        Share on X
                    </button>
                )}
                <button className="ui-btn-ghost shrink-0" onClick={onClose}>Cancel</button>
                <button className="ui-btn-primary" onClick={handleDownload} disabled={isGenerating}>
                    <Download className="w-4 h-4" />
                    Download
                </button>
                {typeof navigator !== "undefined" && typeof navigator.share === "function" && (
                    <button className="ui-btn" onClick={handleNativeShare} disabled={isGenerating}>
                        <Share2 className="w-4 h-4" />
                        Share...
                    </button>
                )}
            </ModalFooter>
        </Modal>
    );
}
