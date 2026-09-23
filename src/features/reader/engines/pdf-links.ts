import type { PDFDocumentProxy } from "pdfjs-dist";

/** PDF user-space rectangle: [x1, y1, x2, y2], y grows upward. */
export type PdfRect = [number, number, number, number];

export type PdfLink =
    | { kind: "internal"; rect: PdfRect; dest: unknown }
    | { kind: "external"; rect: PdfRect; url: string }
    | { kind: "named"; rect: PdfRect; action: string };

/** Where an internal link lands: page plus the top-left anchor in user space. */
export interface PdfDestTarget {
    pageNumber: number;
    /** x of the destination, or null when the destination does not pin one. */
    left: number | null;
    /** y of the top edge to show, or null for "top of the page". */
    top: number | null;
}

const LINK_ANNOTATION_TYPE = 2;
const SUPPORTED_NAMED_ACTIONS = new Set(["NextPage", "PrevPage", "FirstPage", "LastPage", "GoBack", "GoForward"]);

function isFiniteRect(rect: unknown): rect is PdfRect {
    return Array.isArray(rect)
        && rect.length === 4
        && rect.every((value) => typeof value === "number" && Number.isFinite(value));
}

/**
 * Keep only actionable Link annotations from `page.getAnnotations()`.
 * pdf.js exposes `url` only for URLs it considers safe (http/https/mailto…);
 * `unsafeUrl` (javascript:, file:, …) is deliberately ignored.
 */
export function extractPdfLinks(annotations: ReadonlyArray<Record<string, unknown>>): PdfLink[] {
    const links: PdfLink[] = [];
    for (const annotation of annotations) {
        if (annotation.annotationType !== LINK_ANNOTATION_TYPE && annotation.subtype !== "Link") continue;
        const rect = annotation.rect;
        if (!isFiniteRect(rect)) continue;
        const [x1, y1, x2, y2] = rect;
        const normalized: PdfRect = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
        if (normalized[2] - normalized[0] <= 0 || normalized[3] - normalized[1] <= 0) continue;

        if (typeof annotation.url === "string" && annotation.url.length > 0) {
            links.push({ kind: "external", rect: normalized, url: annotation.url });
        } else if (annotation.dest != null && annotation.dest !== "") {
            links.push({ kind: "internal", rect: normalized, dest: annotation.dest });
        } else if (typeof annotation.action === "string" && SUPPORTED_NAMED_ACTIONS.has(annotation.action)) {
            links.push({ kind: "named", rect: normalized, action: annotation.action });
        }
    }
    return links;
}

function finiteOrNull(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Anchor coordinates of an explicit destination array
 * `[pageRef, {name}, ...args]` (PDF 32000-1 §12.3.2.2).
 */
export function parseExplicitDestAnchor(explicitDest: readonly unknown[]): { left: number | null; top: number | null } {
    const mode = explicitDest[1];
    const name = mode && typeof mode === "object" && "name" in mode ? String((mode as { name: unknown }).name) : "";
    switch (name) {
        case "XYZ":
            return { left: finiteOrNull(explicitDest[2]), top: finiteOrNull(explicitDest[3]) };
        case "FitH":
        case "FitBH":
            return { left: null, top: finiteOrNull(explicitDest[2]) };
        case "FitV":
        case "FitBV":
            return { left: finiteOrNull(explicitDest[2]), top: null };
        case "FitR": {
            // [left, bottom, right, top]
            const left = finiteOrNull(explicitDest[2]);
            const bottom = finiteOrNull(explicitDest[3]);
            const top = finiteOrNull(explicitDest[5]);
            return { left, top: top ?? bottom };
        }
        default:
            return { left: null, top: null };
    }
}

/** Resolve a named or explicit destination to a 1-based page and anchor. */
export async function resolvePdfDestTarget(
    pdfDocument: Pick<PDFDocumentProxy, "getDestination" | "getPageIndex" | "numPages">,
    destination: unknown,
): Promise<PdfDestTarget | null> {
    try {
        const explicitDest = typeof destination === "string"
            ? await pdfDocument.getDestination(destination)
            : destination;
        if (!Array.isArray(explicitDest) || explicitDest.length === 0) return null;

        const ref = explicitDest[0];
        let pageNumber: number;
        if (typeof ref === "number" && Number.isInteger(ref)) {
            pageNumber = ref + 1;
        } else if (ref && typeof ref === "object") {
            pageNumber = (await pdfDocument.getPageIndex(ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0])) + 1;
        } else {
            return null;
        }
        if (pageNumber < 1 || pageNumber > pdfDocument.numPages) return null;

        return { pageNumber, ...parseExplicitDestAnchor(explicitDest) };
    } catch {
        return null;
    }
}
