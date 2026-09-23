import { createContext, memo, useContext, useEffect, useMemo, useState } from "react";
import type { PDFPageProxy } from "pdfjs-dist";
import { viewRotation } from "../engines/pdf-rotation";
import { extractPdfLinks, type PdfLink } from "../engines/pdf-links";

export interface PdfLinkHandlers {
    /** False while an annotation tool is active: links must not steal gestures. */
    enabled: boolean;
    onActivate: (link: PdfLink, anchor: HTMLElement, pointerType: string) => void;
    onHoverStart: (link: PdfLink, anchor: HTMLElement) => void;
    onHoverEnd: () => void;
}

export const PdfLinkHandlersContext = createContext<PdfLinkHandlers | null>(null);

const pageLinkCache = new WeakMap<PDFPageProxy, Promise<PdfLink[]>>();

export function getPageLinks(page: PDFPageProxy): Promise<PdfLink[]> {
    let cached = pageLinkCache.get(page);
    if (!cached) {
        cached = page
            .getAnnotations({ intent: "display" })
            .then((annotations) => extractPdfLinks(annotations as Array<Record<string, unknown>>))
            .catch(() => []);
        pageLinkCache.set(page, cached);
    }
    return cached;
}

interface PDFLinkLayerProps {
    page: PDFPageProxy;
    /** Viewport scale in CSS px per PDF unit (already includes PDF_TO_CSS_UNITS). */
    cssScale: number;
    rotation: number;
}

export const PDFLinkLayer = memo(function PDFLinkLayer({ page, cssScale, rotation }: PDFLinkLayerProps) {
    const handlers = useContext(PdfLinkHandlersContext);
    const [links, setLinks] = useState<PdfLink[]>([]);

    useEffect(() => {
        let cancelled = false;
        void getPageLinks(page).then((result) => {
            if (!cancelled) setLinks(result);
        });
        return () => {
            cancelled = true;
        };
    }, [page]);

    const boxes = useMemo(() => {
        if (links.length === 0) return [];
        const viewport = page.getViewport({ scale: cssScale, rotation: viewRotation(page, rotation) });
        return links.map((link) => {
            const [x1, y1, x2, y2] = link.rect;
            const [ax, ay] = viewport.convertToViewportPoint(x1, y1);
            const [bx, by] = viewport.convertToViewportPoint(x2, y2);
            return {
                link,
                left: Math.min(ax, bx),
                top: Math.min(ay, by),
                width: Math.abs(bx - ax),
                height: Math.abs(by - ay),
            };
        });
    }, [links, page, cssScale, rotation]);

    if (!handlers?.enabled || boxes.length === 0) return null;

    return (
        <div className="pdf-link-layer">
            {boxes.map(({ link, left, top, width, height }, index) => (
                <a
                    key={index}
                    href={link.kind === "external" ? link.url : "#"}
                    title={link.kind === "external" ? link.url : undefined}
                    data-no-viewport-tap
                    draggable={false}
                    className="pdf-link"
                    style={{ left, top, width, height }}
                    onPointerDown={(event) => {
                        // `click` is not a PointerEvent on every WebView (WebKitGTK),
                        // so remember how this activation started.
                        event.currentTarget.dataset.pointerType = event.pointerType;
                    }}
                    onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        const pointerType = event.currentTarget.dataset.pointerType || "mouse";
                        handlers.onActivate(link, event.currentTarget, pointerType);
                    }}
                    onPointerEnter={(event) => {
                        if (event.pointerType === "mouse" && link.kind === "internal") {
                            handlers.onHoverStart(link, event.currentTarget);
                        }
                    }}
                    onPointerLeave={(event) => {
                        if (event.pointerType === "mouse") handlers.onHoverEnd();
                    }}
                />
            ))}
        </div>
    );
});
