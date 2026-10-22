/**
 * Sections of a book to narrate for Save as Audiobook, with chapter names.
 *
 * Chapter names come from the table of contents: each spine section takes the
 * TOC entry that opens it (the deepest entry pointing at the start of the
 * file, else the first entry pointing anywhere into it), then the section's
 * first heading, then "Section N". Items a listener should not hear are
 * skipped: non-linear items (`linear="no"`, e.g. pop-up notes), the navigation
 * document and any contents page named in the landmarks, the cover, and pages
 * that are only an image.
 */

export interface TocEntry {
    label?: string;
    href?: string;
    subitems?: TocEntry[] | null;
}

export interface Landmark {
    type?: string[] | string;
    href?: string;
}

export interface AudioSectionSource {
    /** The section's href within the book (EPUB: the manifest path). */
    id: string | number;
    linear?: string;
    createDocument?: () => Promise<Document | null | undefined>;
}

export interface AudioSection {
    id: string;
    title: string;
    text: string;
}

export interface CollectAudioSectionsInput {
    sections: AudioSectionSource[];
    toc?: TocEntry[] | null;
    landmarks?: Landmark[] | null;
    /** Href of the EPUB navigation document (`properties="nav"`). */
    navPath?: string | null;
    /** Href of the cover image or cover page, when the package names one. */
    coverHref?: string | null;
    /** The book's own href → section index resolver, for TOCs that are not file paths. */
    resolveIndex?: (href: string) => number | null | undefined;
}

/** An image page with less text than this (a caption, "Cover") is not narrated. */
const IMAGE_PAGE_MAX_TEXT = 20;

const SKIPPED_ELEMENTS = new Set(["SCRIPT", "STYLE", "SVG", "NOSCRIPT", "TEMPLATE", "HEAD", "RT", "RP"]);
const BLOCK_ELEMENTS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "CAPTION", "DD", "DETAILS", "DIV", "DL", "DT",
    "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER",
    "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TD", "TH", "TR", "UL",
]);

function safeDecode(value: string): string {
    try {
        return decodeURI(value);
    } catch {
        return value;
    }
}

/** The file part of an href, decoded: "Text/ch%201.xhtml#p3" -> "Text/ch 1.xhtml". */
function hrefPath(href: string): string {
    const hash = href.indexOf("#");
    return safeDecode(hash >= 0 ? href.slice(0, hash) : href);
}

function cleanLabel(label: string | undefined): string {
    return (label ?? "").replace(/\s+/g, " ").trim();
}

function tagName(el: Element): string {
    return el.tagName.toUpperCase();
}

/**
 * Plain text of an element for narration: block elements are separated by a
 * blank line (so headings and paragraphs end a sentence), `<br>` by a line
 * break, and whitespace inside a block collapses to single spaces.
 */
export function extractSpeechText(root: Element | null | undefined): string {
    if (!root) return "";
    const parts: string[] = [];
    const walk = (node: Node) => {
        if (node.nodeType === 3) {
            parts.push((node.nodeValue ?? "").replace(/\s+/g, " "));
            return;
        }
        if (node.nodeType !== 1) return;
        const el = node as Element;
        const tag = tagName(el);
        if (SKIPPED_ELEMENTS.has(tag)) return;
        if (tag === "BR") {
            parts.push("\n");
            return;
        }
        const block = BLOCK_ELEMENTS.has(tag);
        if (block) parts.push("\n\n");
        for (const child of Array.from(el.childNodes)) walk(child);
        if (block) parts.push("\n\n");
    };
    walk(root);
    return parts
        .join("")
        .replace(/[^\S\n]+/g, " ")
        .replace(/ ?\n ?/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function firstHeading(doc: Document): string {
    const heading = doc.querySelector("h1, h2, h3, h4, h5, h6");
    return heading ? cleanLabel(heading.textContent ?? "") : "";
}

function isImageOnly(doc: Document, text: string): boolean {
    if (text.length >= IMAGE_PAGE_MAX_TEXT) return false;
    return !!doc.querySelector("img, svg, image, picture");
}

function landmarkTypes(landmark: Landmark): string[] {
    const { type } = landmark;
    if (!type) return [];
    return (Array.isArray(type) ? type : String(type).split(/\s+/)).map((t) => t.toLowerCase());
}

/**
 * Section index → chapter name from the TOC. For each section the deepest
 * entry that points at its start wins; with only fragment links into it, the
 * first such entry in reading order.
 */
export function sectionTitlesFromToc(
    sectionIds: string[],
    toc: TocEntry[] | null | undefined,
    resolveIndex?: (href: string) => number | null | undefined,
): Map<number, string> {
    const byPath = new Map<string, number>();
    sectionIds.forEach((id, index) => {
        const path = safeDecode(id);
        if (!byPath.has(path)) byPath.set(path, index);
    });
    const indexOf = (href: string): number | null => {
        const direct = byPath.get(hrefPath(href));
        if (direct !== undefined) return direct;
        try {
            const resolved = resolveIndex?.(href);
            return typeof resolved === "number" && resolved >= 0 && resolved < sectionIds.length ? resolved : null;
        } catch {
            return null;
        }
    };

    // Best candidate per section: start-of-file links beat fragment links, deeper beats shallower.
    const best = new Map<number, { label: string; atStart: boolean; depth: number }>();
    const visit = (entries: TocEntry[] | null | undefined, depth: number) => {
        for (const entry of entries ?? []) {
            const label = cleanLabel(entry.label);
            const href = entry.href ?? "";
            const index = href && label ? indexOf(href) : null;
            if (index !== null) {
                const atStart = !href.includes("#");
                const current = best.get(index);
                const better = !current
                    || (atStart && !current.atStart)
                    || (atStart && current.atStart && depth > current.depth);
                if (better) best.set(index, { label, atStart, depth });
            }
            visit(entry.subitems, depth + 1);
        }
    };
    visit(toc, 0);

    const titles = new Map<number, string>();
    for (const index of [...best.keys()].sort((a, b) => a - b)) {
        titles.set(index, best.get(index)!.label);
    }
    return titles;
}

/** Every section worth narrating, in reading order, with its chapter name and text. */
export async function collectAudioSections(input: CollectAudioSectionsInput): Promise<AudioSection[]> {
    const { sections } = input;
    if (sections.length === 0) return [];
    const ids = sections.map((s) => String(s.id));
    const hasToc = (input.toc?.length ?? 0) > 0;
    const titles = sectionTitlesFromToc(ids, input.toc, input.resolveIndex);

    const skipPaths = new Set<string>();
    if (input.navPath) skipPaths.add(hrefPath(input.navPath));
    if (input.coverHref) skipPaths.add(hrefPath(input.coverHref));
    for (const landmark of input.landmarks ?? []) {
        const types = landmarkTypes(landmark);
        if (landmark.href && types.some((t) => t === "toc" || t === "cover")) {
            skipPaths.add(hrefPath(landmark.href));
        }
    }

    const out: AudioSection[] = [];
    for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        if (section.linear === "no" || skipPaths.has(safeDecode(ids[i]))) continue;
        let doc: Document | null | undefined;
        try {
            doc = await section.createDocument?.();
        } catch {
            continue; // Unreadable section: narration continues with the rest.
        }
        if (!doc?.body) continue;
        const text = extractSpeechText(doc.body);
        if (!text || isImageOnly(doc, text)) continue;

        const tocTitle = titles.get(i);
        const heading = tocTitle ? "" : firstHeading(doc);
        if (!tocTitle && !heading && hasToc && out.length > 0) {
            // A file the TOC does not list and with no heading continues the
            // previous chapter (EPUBs often split one chapter over several files).
            const previous = out[out.length - 1];
            previous.text = `${previous.text}\n\n${text}`;
            continue;
        }
        out.push({ id: `section-${i}`, title: tocTitle || heading || `Section ${i + 1}`, text });
    }
    return out;
}
