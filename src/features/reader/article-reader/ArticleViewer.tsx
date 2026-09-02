import {
    memo,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { cn } from "../../../core/lib/utils";
import { HIGHLIGHT_COLOR_TOKENS } from "../../../core/lib/design-tokens";
import { vocabularyTermFromLookup, type DictionaryLookupResult } from "../../../core/services/DictionaryService";
import { useVocabularyStore, useLibraryStore, useSettingsStore } from "../../../core/store";
import { useShallow } from "zustand/shallow";
import type { Annotation, DocLocation, DocMetadata, HighlightColor, RssArticle, TocItem, ReaderSettings as ReaderSettingsState } from "../../../core/types";
import { Backdrop } from "../../../ui";
import {
    ReaderSearch,
} from "../components/ReaderSearch";
import { ReaderAnnotationsPanel } from "../components/ReaderAnnotationsPanel";
import { ReaderSettings } from "../components/ReaderSettings";
import { TableOfContents } from "../components/TableOfContents";
import { WindowTitlebar } from "../components/WindowTitlebar";
import { HighlightColorPicker } from "../components/highlights/HighlightColorPicker";
import { NoteEditor } from "../components/highlights/NoteEditor";
import { useReaderFullscreen } from "../hooks";
import { ArticleReaderContent } from "./ArticleReaderContent";
import { ArticleReaderInfoPanel } from "./ArticleReaderInfoPanel";
import type { ArticleHeading, ArticleReaderPanel } from "./types";
import { buildArticleDescription, formatArticleDate, sanitizeArticleHtml } from "./utils";

interface ArticleViewerProps {
    article: RssArticle | null;
    feedTitle?: string;
    isOpen: boolean;
    onClose: () => void;
}

const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 32;
const MIN_LINE_HEIGHT = 1.2;
const MAX_LINE_HEIGHT = 2.2;
const MIN_BRIGHTNESS = 20;
const MAX_BRIGHTNESS = 100;
const BOOKMARK_SNAP_THRESHOLD = 0.012;
const ARTICLE_BOOKMARK_LOCATION_PREFIX = "article-bookmark:";
const ARTICLE_HIGHLIGHT_LOCATION_PREFIX = "article-highlight:";
const ARTICLE_SEARCH_MARK_SELECTOR = "mark.article-search-highlight";
const MAX_ARTICLE_SEARCH_RESULTS = 300;
const ARTICLE_HIGHLIGHT_LOCATION_SEPARATOR = "|";

interface TextSelectionSnapshot {
    start: number;
    end: number;
    text: string;
}

interface ArticleHighlightLocation {
    highlightId: string;
    start?: number;
    end?: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function buildArticleToc(headings: ArticleHeading[]): TocItem[] {
    const toc: TocItem[] = [];
    const stack: Array<{ level: number; children: TocItem[] }> = [
        { level: 0, children: toc },
    ];

    for (const heading of headings) {
        while (stack.length > 1 && heading.level <= stack[stack.length - 1].level) {
            stack.pop();
        }

        const item: TocItem = {
            label: heading.text,
            href: heading.id,
            subitems: [],
        };
        stack[stack.length - 1].children.push(item);
        stack.push({
            level: heading.level,
            children: item.subitems ?? [],
        });
    }

    return toc;
}

function parseBookmarkProgress(location: string): number | null {
    if (!location.startsWith(ARTICLE_BOOKMARK_LOCATION_PREFIX)) {
        return null;
    }

    const value = Number(location.slice(ARTICLE_BOOKMARK_LOCATION_PREFIX.length));
    if (!Number.isFinite(value)) {
        return null;
    }

    return clamp(value, 0, 1);
}

function parseArticleHighlightLocation(location: string): ArticleHighlightLocation | null {
    if (!location.startsWith(ARTICLE_HIGHLIGHT_LOCATION_PREFIX)) {
        return null;
    }

    const encoded = location.slice(ARTICLE_HIGHLIGHT_LOCATION_PREFIX.length);
    if (!encoded) {
        return null;
    }

    const [highlightId, startValue, endValue] = encoded.split(ARTICLE_HIGHLIGHT_LOCATION_SEPARATOR);
    if (!highlightId) {
        return null;
    }

    if (typeof startValue === "undefined" || typeof endValue === "undefined") {
        return { highlightId };
    }

    const start = Number(startValue);
    const end = Number(endValue);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return { highlightId };
    }

    return {
        highlightId,
        start: Math.max(0, Math.floor(start)),
        end: Math.max(0, Math.floor(end)),
    };
}

function buildArticleHighlightLocation(
    highlightId: string,
    selectionSnapshot: TextSelectionSnapshot | null,
): string {
    if (!selectionSnapshot) {
        return `${ARTICLE_HIGHLIGHT_LOCATION_PREFIX}${highlightId}`;
    }

    return [
        ARTICLE_HIGHLIGHT_LOCATION_PREFIX,
        highlightId,
        ARTICLE_HIGHLIGHT_LOCATION_SEPARATOR,
        Math.max(0, Math.floor(selectionSnapshot.start)),
        ARTICLE_HIGHLIGHT_LOCATION_SEPARATOR,
        Math.max(0, Math.floor(selectionSnapshot.end)),
    ].join("");
}

function unwrapMark(mark: Element): void {
    const parent = mark.parentNode;
    if (!parent) {
        return;
    }

    parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
    parent.normalize();
}

function normalizeSelectionText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function isSelectionRangeWithinContent(range: Range, contentRoot: HTMLElement): boolean {
    return contentRoot.contains(range.startContainer) && contentRoot.contains(range.endContainer);
}

function createHighlightMark(highlightId: string, color: HighlightColor): HTMLElement {
    const mark = document.createElement("mark");
    mark.className = "article-highlight";
    mark.dataset.highlightId = highlightId;
    mark.dataset.highlightColor = color;
    mark.style.backgroundColor = HIGHLIGHT_COLOR_TOKENS[color].soft;
    mark.style.borderRadius = "2px";
    mark.style.padding = "0.05em 0";
    mark.style.color = "inherit";
    mark.style.display = "inline";
    mark.style.setProperty("box-decoration-break", "clone");
    mark.style.setProperty("-webkit-box-decoration-break", "clone");
    return mark;
}

function findFirstTextDescendant(root: Element): Text | null {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
        const textNode = walker.currentNode as Text;
        if ((textNode.textContent?.length ?? 0) > 0) {
            return textNode;
        }
    }
    return null;
}

function findLastTextDescendant(root: Element): Text | null {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let lastTextNode: Text | null = null;
    while (walker.nextNode()) {
        const textNode = walker.currentNode as Text;
        if ((textNode.textContent?.length ?? 0) > 0) {
            lastTextNode = textNode;
        }
    }
    return lastTextNode;
}

function buildRangeFromHighlightMarks(
    contentRoot: HTMLElement,
    highlightId: string,
): Range | null {
    const marks = Array.from(
        contentRoot.querySelectorAll<HTMLElement>(`mark.article-highlight[data-highlight-id="${highlightId}"]`),
    );
    if (marks.length === 0) {
        return null;
    }

    const firstTextNode = findFirstTextDescendant(marks[0]);
    const lastTextNode = findLastTextDescendant(marks[marks.length - 1]);
    if (!firstTextNode || !lastTextNode) {
        return null;
    }

    try {
        const range = document.createRange();
        range.setStart(firstTextNode, 0);
        range.setEnd(lastTextNode, lastTextNode.textContent?.length ?? 0);
        return range;
    } catch {
        return null;
    }
}

function getClosestHighlightMark(node: Node): HTMLElement | null {
    if (node.nodeType === Node.ELEMENT_NODE) {
        return (node as Element).closest("mark.article-highlight[data-highlight-id]") as HTMLElement | null;
    }
    return node.parentElement?.closest("mark.article-highlight[data-highlight-id]") as HTMLElement | null;
}

function wrapTextNodeRange(
    textNode: Text,
    startOffset: number,
    endOffset: number,
    highlightId: string,
    color: HighlightColor,
): boolean {
    const nodeText = textNode.textContent ?? "";
    let boundedStart = clamp(startOffset, 0, nodeText.length);
    let boundedEnd = clamp(endOffset, boundedStart, nodeText.length);

    // Trim leading whitespace in this text node so empty spaces around words are never highlighted
    while (boundedStart < boundedEnd && /\s/.test(nodeText[boundedStart])) {
        boundedStart++;
    }
    // Trim trailing whitespace in this text node
    while (boundedEnd > boundedStart && /\s/.test(nodeText[boundedEnd - 1])) {
        boundedEnd--;
    }

    if (boundedEnd <= boundedStart) {
        return false;
    }

    let highlightedNode = textNode;
    if (boundedStart > 0) {
        highlightedNode = textNode.splitText(boundedStart);
    }

    const selectedLength = boundedEnd - boundedStart;
    if (selectedLength < (highlightedNode.textContent?.length ?? 0)) {
        highlightedNode.splitText(selectedLength);
    }

    const parent = highlightedNode.parentNode;
    if (!parent) {
        return false;
    }

    const mark = createHighlightMark(highlightId, color);
    parent.replaceChild(mark, highlightedNode);
    mark.appendChild(highlightedNode);
    return true;
}

function applyHighlightAcrossTextNodes(
    range: Range,
    contentRoot: HTMLElement,
    highlightId: string,
    color: HighlightColor,
): boolean {
    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(contentRoot, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
        const textNode = walker.currentNode as Text;
        const content = textNode.textContent ?? "";
        // Skip empty or pure-whitespace text nodes (e.g. newlines or spaces between tags)
        if (!content.trim()) {
            continue;
        }
        if (textNode.parentElement?.closest("mark.article-highlight")) {
            continue;
        }
        if (!range.intersectsNode(textNode)) {
            continue;
        }
        textNodes.push(textNode);
    }

    if (textNodes.length === 0) {
        return false;
    }

    let appliedCount = 0;
    for (const textNode of textNodes) {
        const textLength = textNode.textContent?.length ?? 0;
        const startOffset = textNode === range.startContainer ? range.startOffset : 0;
        const endOffset = textNode === range.endContainer ? range.endOffset : textLength;
        if (wrapTextNodeRange(textNode, startOffset, endOffset, highlightId, color)) {
            appliedCount += 1;
        }
    }

    return appliedCount > 0;
}

function removeTempSelectionMarks(contentRoot: HTMLElement | null): void {
    if (!contentRoot) return;
    const tempMarks = contentRoot.querySelectorAll<HTMLElement>("mark.article-temp-selection");
    tempMarks.forEach((mark) => {
        unwrapMark(mark);
    });
}

function createTempSelectionMark(color: HighlightColor): HTMLElement {
    const mark = document.createElement("mark");
    mark.className = "article-temp-selection";
    mark.style.backgroundColor = HIGHLIGHT_COLOR_TOKENS[color].soft;
    mark.style.borderRadius = "2px";
    mark.style.padding = "0.05em 0";
    mark.style.color = "inherit";
    mark.style.display = "inline";
    mark.style.setProperty("box-decoration-break", "clone");
    mark.style.setProperty("-webkit-box-decoration-break", "clone");
    return mark;
}

function wrapTempTextNodeRange(
    textNode: Text,
    startOffset: number,
    endOffset: number,
    color: HighlightColor,
): boolean {
    const nodeText = textNode.textContent ?? "";
    let boundedStart = clamp(startOffset, 0, nodeText.length);
    let boundedEnd = clamp(endOffset, boundedStart, nodeText.length);

    while (boundedStart < boundedEnd && /\s/.test(nodeText[boundedStart])) {
        boundedStart++;
    }
    while (boundedEnd > boundedStart && /\s/.test(nodeText[boundedEnd - 1])) {
        boundedEnd--;
    }

    if (boundedEnd <= boundedStart) {
        return false;
    }

    let highlightedNode = textNode;
    if (boundedStart > 0) {
        highlightedNode = textNode.splitText(boundedStart);
    }

    const selectedLength = boundedEnd - boundedStart;
    if (selectedLength < (highlightedNode.textContent?.length ?? 0)) {
        highlightedNode.splitText(selectedLength);
    }

    const parent = highlightedNode.parentNode;
    if (!parent) {
        return false;
    }

    const mark = createTempSelectionMark(color);
    parent.replaceChild(mark, highlightedNode);
    mark.appendChild(highlightedNode);
    return true;
}

function applyTempSelectionAcrossTextNodes(
    range: Range,
    contentRoot: HTMLElement,
    color: HighlightColor,
): boolean {
    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(contentRoot, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
        const textNode = walker.currentNode as Text;
        const content = textNode.textContent ?? "";
        if (!content.trim()) {
            continue;
        }
        if (textNode.parentElement?.closest("mark.article-highlight, mark.article-temp-selection")) {
            continue;
        }
        if (!range.intersectsNode(textNode)) {
            continue;
        }
        textNodes.push(textNode);
    }

    if (textNodes.length === 0) {
        return false;
    }

    let appliedCount = 0;
    for (const textNode of textNodes) {
        const textLength = textNode.textContent?.length ?? 0;
        const startOffset = textNode === range.startContainer ? range.startOffset : 0;
        const endOffset = textNode === range.endContainer ? range.endOffset : textLength;
        if (wrapTempTextNodeRange(textNode, startOffset, endOffset, color)) {
            appliedCount += 1;
        }
    }

    return appliedCount > 0;
}

function createSelectionSnapshot(
    range: Range,
    contentRoot: HTMLElement,
): TextSelectionSnapshot | null {
    if (!isSelectionRangeWithinContent(range, contentRoot)) {
        return null;
    }

    try {
        const startMeasure = document.createRange();
        startMeasure.selectNodeContents(contentRoot);
        startMeasure.setEnd(range.startContainer, range.startOffset);
        const start = startMeasure.toString().length;

        const endMeasure = document.createRange();
        endMeasure.selectNodeContents(contentRoot);
        endMeasure.setEnd(range.endContainer, range.endOffset);
        const end = endMeasure.toString().length;

        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
            return null;
        }

        return {
            start,
            end,
            text: normalizeSelectionText(range.toString()),
        };
    } catch {
        return null;
    }
}

function buildRangeFromSnapshot(
    snapshot: TextSelectionSnapshot,
    contentRoot: HTMLElement,
): Range | null {
    const startTarget = Math.max(0, snapshot.start);
    const endTarget = Math.max(startTarget, snapshot.end);
    if (endTarget <= startTarget) {
        return null;
    }

    const walker = document.createTreeWalker(contentRoot, NodeFilter.SHOW_TEXT, null);
    let traversed = 0;
    let startNode: Text | null = null;
    let endNode: Text | null = null;
    let startOffset = 0;
    let endOffset = 0;
    let lastTextNode: Text | null = null;

    while (walker.nextNode()) {
        const textNode = walker.currentNode as Text;
        const textLength = textNode.textContent?.length ?? 0;
        if (textLength === 0) {
            continue;
        }

        const nextTraversed = traversed + textLength;
        lastTextNode = textNode;

        if (!startNode && startTarget <= nextTraversed) {
            startNode = textNode;
            startOffset = clamp(startTarget - traversed, 0, textLength);
        }

        if (!endNode && endTarget <= nextTraversed) {
            endNode = textNode;
            endOffset = clamp(endTarget - traversed, 0, textLength);
            break;
        }

        traversed = nextTraversed;
    }

    if (!startNode || !endNode) {
        if (!startNode || !lastTextNode) {
            return null;
        }
        endNode = lastTextNode;
        endOffset = lastTextNode.textContent?.length ?? 0;
    }

    if (startNode === endNode && endOffset <= startOffset) {
        return null;
    }

    try {
        const restoredRange = document.createRange();
        restoredRange.setStart(startNode, startOffset);
        restoredRange.setEnd(endNode, endOffset);
        return restoredRange;
    } catch {
        return null;
    }
}

function getCleanTextRange(range: Range, container: HTMLElement): Range | null {
    try {
        const clone = range.cloneRange();

        if (clone.startContainer.nodeType !== Node.TEXT_NODE) {
            const walker = document.createTreeWalker(clone.startContainer, NodeFilter.SHOW_TEXT, null);
            let firstText: Text | null = null;
            while (walker.nextNode()) {
                const node = walker.currentNode as Text;
                if ((node.textContent?.length ?? 0) > 0 && container.contains(node)) {
                    firstText = node;
                    break;
                }
            }
            if (firstText) {
                clone.setStart(firstText, 0);
            }
        }

        if (clone.endContainer.nodeType !== Node.TEXT_NODE) {
            const walker = document.createTreeWalker(clone.endContainer, NodeFilter.SHOW_TEXT, null);
            let lastText: Text | null = null;
            while (walker.nextNode()) {
                const node = walker.currentNode as Text;
                if ((node.textContent?.length ?? 0) > 0 && container.contains(node)) {
                    lastText = node;
                }
            }
            if (lastText) {
                clone.setEnd(lastText, lastText.textContent?.length ?? 0);
            }
        }

        if (clone.startContainer.nodeType === Node.TEXT_NODE) {
            const text = clone.startContainer.textContent ?? "";
            let offset = clone.startOffset;
            while (offset < text.length && /\s/.test(text[offset])) {
                offset++;
            }
            clone.setStart(clone.startContainer, Math.min(offset, text.length));
        }

        if (clone.endContainer.nodeType === Node.TEXT_NODE) {
            const text = clone.endContainer.textContent ?? "";
            let offset = clone.endOffset;
            while (offset > 0 && /\s/.test(text[offset - 1])) {
                offset--;
            }
            clone.setEnd(clone.endContainer, Math.max(0, offset));
        }

        if (clone.collapsed || !clone.toString().trim()) {
            return null;
        }

        return clone;
    } catch {
        return range;
    }
}

function resolveSelectionRange(
    selectedRange: Range | null,
    selectionSnapshot: TextSelectionSnapshot | null,
    expectedText: string,
    contentRoot: HTMLElement,
): Range | null {
    if (
        selectedRange
        && isSelectionRangeWithinContent(selectedRange, contentRoot)
        && selectedRange.toString().trim().length > 0
    ) {
        return getCleanTextRange(selectedRange, contentRoot);
    }

    if (!selectionSnapshot) {
        return null;
    }

    const restoredRange = buildRangeFromSnapshot(selectionSnapshot, contentRoot);
    if (!restoredRange || restoredRange.toString().trim().length === 0) {
        return null;
    }

    const expected = normalizeSelectionText(expectedText || selectionSnapshot.text);
    if (!expected) {
        return getCleanTextRange(restoredRange, contentRoot);
    }

    const restoredText = normalizeSelectionText(restoredRange.toString());
    if (restoredText === expected || restoredText.includes(expected) || expected.includes(restoredText)) {
        return getCleanTextRange(restoredRange, contentRoot);
    }

    return null;
}

function applyHighlightToRange(
    range: Range,
    contentRoot: HTMLElement,
    highlightId: string,
    color: HighlightColor,
): boolean {
    const workingRange = range.cloneRange();
    const selectedText = workingRange.toString().trim();
    if (!selectedText) {
        return false;
    }

    return applyHighlightAcrossTextNodes(workingRange, contentRoot, highlightId, color);
}

export const ArticleViewer = memo(function ArticleViewer({
    article,
    feedTitle,
    isOpen,
    onClose,
}: ArticleViewerProps) {
    const articleAnnotationBookId = article ? `rss:${article.id}` : "";
    const globalReaderSettings = useSettingsStore((state) => state.settings.readerSettings);
    const updateReaderSettings = useSettingsStore((state) => state.updateReaderSettings);
    const learningSettings = useSettingsStore((state) => state.settings.vocabulary);
    const lookupTerm = useVocabularyStore((state) => state.lookupTerm);
    const saveVocabularyTerm = useVocabularyStore((state) => state.saveVocabularyTerm);
    const annotations = useLibraryStore(useShallow(
        (state) => state.getBookAnnotations(articleAnnotationBookId),
    ));
    const addAnnotation = useLibraryStore((state) => state.addAnnotation);
    const updateAnnotation = useLibraryStore((state) => state.updateAnnotation);
    const removeAnnotation = useLibraryStore((state) => state.removeAnnotation);

    const [activePanel, setActivePanel] = useState<ArticleReaderPanel>(null);
    const [showChrome, setShowChrome] = useState(true);
    const [readingProgress, setReadingProgress] = useState(0);
    const [headings, setHeadings] = useState<ArticleHeading[]>([]);
    const [showColorPicker, setShowColorPicker] = useState(false);
    const [colorPickerMode, setColorPickerMode] = useState<"actions" | "dictionary">("actions");
    const [colorPickerPosition, setColorPickerPosition] = useState<{ x: number, y: number, height?: number }>({ x: 0, y: 0 });
    const [selectedText, setSelectedText] = useState("");
    const [showNoteEditor, setShowNoteEditor] = useState(false);
    const [noteEditorPosition, setNoteEditorPosition] = useState({ x: 0, y: 0 });
    const [editingNote, setEditingNote] = useState("");
    const [editingHighlightId, setEditingHighlightId] = useState<string | null>(null);
    const [pendingHighlightColor, setPendingHighlightColor] = useState<HighlightColor | null>(null);

    const [dictionaryState, setDictionaryState] = useState<{
        term: string;
        result: DictionaryLookupResult | null;
        loading: boolean;
        error: string | null;
        saved: boolean;
    }>({
        term: "",
        result: null,
        loading: false,
        error: null,
        saved: false,
    });

    const contentRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const toolbarContainerRef = useRef<HTMLDivElement>(null);
    const selectedRangeRef = useRef<Range | null>(null);
    const selectionSnapshotRef = useRef<TextSelectionSnapshot | null>(null);
    
    const backfilledIdsRef = useRef<Set<string>>(new Set());
    const bookmarkAnnotations = useMemo(
        () => annotations.filter((entry) => entry.type === "bookmark"),
        [annotations],
    );
    const highlightAnnotations = useMemo(
        () => annotations.filter((entry) => entry.type === "highlight" || entry.type === "note"),
        [annotations],
    );

    const sanitizedContent = useMemo(
        () => sanitizeArticleHtml(article?.content || article?.summary || ""),
        [article?.content, article?.summary],
    );

    useEffect(() => {
        setActivePanel(null);
        setShowChrome(true);
        setHeadings([]);
        setReadingProgress(0);
        selectedRangeRef.current = null;
        selectionSnapshotRef.current = null;
        backfilledIdsRef.current = new Set();
        setShowColorPicker(false);
        setColorPickerMode("actions");
        setShowNoteEditor(false);
        setSelectedText("");
        setEditingHighlightId(null);
        setEditingNote("");
        setDictionaryState({
            term: "",
            result: null,
            loading: false,
            error: null,
            saved: false,
        });

        if (scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop = 0;
        }
    }, [article?.id]);

    useEffect(() => {
        const container = scrollContainerRef.current;
        if (!container || !isOpen) {
            return;
        }

        const handleScroll = () => {
            const { scrollTop, scrollHeight, clientHeight } = container;
            const denominator = scrollHeight - clientHeight;
            const progress = denominator > 0 ? scrollTop / denominator : 0;
            setReadingProgress(clamp(progress, 0, 1));
        };

        handleScroll();
        container.addEventListener("scroll", handleScroll, { passive: true });
        return () => {
            container.removeEventListener("scroll", handleScroll);
        };
    }, [article?.id, isOpen]);

    const updateReaderSetting = useCallback((updates: Partial<ReaderSettingsState>) => {
        updateReaderSettings(updates);
    }, [updateReaderSettings]);

    const isFullscreen = Boolean(globalReaderSettings.fullscreen);
    const theme = globalReaderSettings.theme ?? "light";
    const fontSize = clamp(globalReaderSettings.fontSize ?? 18, MIN_FONT_SIZE, MAX_FONT_SIZE);
    const lineHeight = clamp(globalReaderSettings.lineHeight ?? 1.6, MIN_LINE_HEIGHT, MAX_LINE_HEIGHT);
    const brightness = clamp(globalReaderSettings.brightness ?? 100, MIN_BRIGHTNESS, MAX_BRIGHTNESS);
    const fontFamily = globalReaderSettings.fontFamily ?? "original";
    const textAlign = globalReaderSettings.textAlign ?? "left";
    const letterSpacing = globalReaderSettings.letterSpacing ?? 0;
    const wordSpacing = globalReaderSettings.wordSpacing ?? 0;

    const handleToggleFullscreen = useCallback(() => {
        updateReaderSetting({ fullscreen: !isFullscreen });
    }, [isFullscreen, updateReaderSetting]);

    const handleArticleExitFullscreen = useCallback(() => {
        updateReaderSetting({ fullscreen: false });
    }, [updateReaderSetting]);

    useReaderFullscreen({
        fullscreen: isFullscreen,
        enabled: isOpen,
        onExitFullscreen: handleArticleExitFullscreen,
        errorLabel: "[ArticleViewer]",
    });

    const togglePanel = useCallback((panel: Exclude<ArticleReaderPanel, null>) => {
        setActivePanel((current) => (current === panel ? null : panel));
    }, []);

    const closePanel = useCallback(() => {
        setActivePanel(null);
    }, []);

    const clearBrowserSelection = useCallback(() => {
        window.getSelection()?.removeAllRanges();
    }, []);

    const scrollByViewport = useCallback((direction: -1 | 1) => {
        const container = scrollContainerRef.current;
        if (!container) {
            return;
        }

        const step = Math.max(220, Math.floor(container.clientHeight * 0.86));
        container.scrollBy({
            top: direction * step,
            behavior: "smooth",
        });
    }, []);

    const getCurrentHeadingLabel = useCallback((): string => {
        const contentElement = contentRef.current;
        const container = scrollContainerRef.current;
        if (!contentElement || !container) {
            return `${Math.round(readingProgress * 100)}%`;
        }

        const headingElements = Array.from(contentElement.querySelectorAll<HTMLElement>("h1, h2, h3, h4"));
        if (headingElements.length === 0) {
            return `${Math.round(readingProgress * 100)}%`;
        }

        const containerTop = container.getBoundingClientRect().top;
        let currentHeading: HTMLElement | null = null;

        for (const heading of headingElements) {
            const offset = heading.getBoundingClientRect().top - containerTop;
            if (offset <= 72) {
                currentHeading = heading;
            } else {
                break;
            }
        }

        return currentHeading?.textContent?.trim() || `${Math.round(readingProgress * 100)}%`;
    }, [readingProgress]);

    const currentBookmark = useMemo(() => (
        bookmarkAnnotations.find((bookmark) => {
            const progress = parseBookmarkProgress(bookmark.location);
            return progress !== null && Math.abs(progress - readingProgress) <= BOOKMARK_SNAP_THRESHOLD;
        }) || null
    ), [bookmarkAnnotations, readingProgress]);

    const handleAddScrollBookmark = useCallback(() => {
        const progress = clamp(readingProgress, 0, 1);
        if (!articleAnnotationBookId) {
            return;
        }

        const existingBookmark = bookmarkAnnotations.find((entry) => {
            const entryProgress = parseBookmarkProgress(entry.location);
            return entryProgress !== null && Math.abs(entryProgress - progress) <= BOOKMARK_SNAP_THRESHOLD;
        });

        if (existingBookmark) {
            removeAnnotation(existingBookmark.id);
            return;
        }

        addAnnotation({
            id: crypto.randomUUID(),
            bookId: articleAnnotationBookId,
            referenceId: articleAnnotationBookId,
            type: "bookmark",
            location: `${ARTICLE_BOOKMARK_LOCATION_PREFIX}${progress.toFixed(6)}`,
            selectedText: getCurrentHeadingLabel(),
            createdAt: new Date(),
        });
    }, [
        addAnnotation,
        articleAnnotationBookId,
        bookmarkAnnotations,
        getCurrentHeadingLabel,
        readingProgress,
        removeAnnotation,
    ]);

    useEffect(() => {
        if (!isOpen) {
            return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
                event.preventDefault();
                setActivePanel((current) => (current === "search" ? null : "search"));
                return;
            }

            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
                event.preventDefault();
                handleAddScrollBookmark();
                return;
            }

            if (event.key !== "Escape") {
                return;
            }

            if (activePanel) {
                setActivePanel(null);
                return;
            }
            if (showColorPicker) {
                removeTempSelectionMarks(contentRef.current);
                selectedRangeRef.current = null;
                selectionSnapshotRef.current = null;
                setShowColorPicker(false);
                setColorPickerMode("actions");
                clearBrowserSelection();
                return;
            }
            if (showNoteEditor) {
                removeTempSelectionMarks(contentRef.current);
                setShowNoteEditor(false);
                return;
            }
            onClose();
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [
        activePanel,
        clearBrowserSelection,
        handleAddScrollBookmark,
        isOpen,
        onClose,
        showColorPicker,
        showNoteEditor,
    ]);

    const handleTextSelect = useCallback((text: string, position: { x: number; y: number; height?: number }, range: Range) => {
        const normalizedText = text.trim();
        if (!normalizedText) {
            return;
        }

        const contentRoot = contentRef.current;
        if (!contentRoot) {
            return;
        }

        // Remove any previous temporary selection marks
        removeTempSelectionMarks(contentRoot);

        const rangeClone = range.cloneRange();
        selectedRangeRef.current = rangeClone;
        selectionSnapshotRef.current = createSelectionSnapshot(rangeClone, contentRoot);

        const startMark = getClosestHighlightMark(rangeClone.startContainer);
        const endMark = getClosestHighlightMark(rangeClone.endContainer);
        const selectedHighlightId = (
            startMark
            && endMark
            && startMark.dataset.highlightId
            && startMark.dataset.highlightId === endMark.dataset.highlightId
        )
            ? startMark.dataset.highlightId
            : null;

        if (selectedHighlightId) {
            const existingHighlight = highlightAnnotations.find((entry) => entry.id === selectedHighlightId) ?? null;
            setEditingHighlightId(selectedHighlightId);
            setPendingHighlightColor(existingHighlight?.color ?? "yellow");
            setSelectedText(existingHighlight?.selectedText?.trim() || normalizedText);
        } else {
            setEditingHighlightId(null);
            setPendingHighlightColor("yellow");
            setSelectedText(normalizedText);

            // Apply clean, line-by-line temporary highlight mark over the exact words
            applyTempSelectionAcrossTextNodes(rangeClone, contentRoot, "yellow");
            // Clear the ugly native browser selection immediately
            clearBrowserSelection();
        }

        setColorPickerPosition(position);
        setColorPickerMode("actions");
        setDictionaryState({
            term: "",
            result: null,
            loading: false,
            error: null,
            saved: false,
        });
        setShowColorPicker(true);
    }, [clearBrowserSelection, highlightAnnotations]);

    const handleDeleteHighlightMark = useCallback((highlightId: string) => {
        const marks = contentRef.current?.querySelectorAll(
            `mark.article-highlight[data-highlight-id="${highlightId}"]`,
        ) ?? [];
        marks.forEach((mark) => {
            unwrapMark(mark);
        });
    }, []);

    const createHighlightAnnotation = useCallback((color: HighlightColor): string | null => {
        const selectionText = selectedText.trim();
        const contentRoot = contentRef.current;
        if (!selectionText || !contentRoot || !articleAnnotationBookId) {
            return null;
        }

        const highlightId = crypto.randomUUID();

        // If we have temporary selection marks in the DOM, convert them directly into permanent highlight marks
        const tempMarks = Array.from(contentRoot.querySelectorAll<HTMLElement>("mark.article-temp-selection"));
        let applied = false;
        if (tempMarks.length > 0) {
            tempMarks.forEach((mark) => {
                mark.className = "article-highlight";
                mark.dataset.highlightId = highlightId;
                mark.dataset.highlightColor = color;
                mark.style.backgroundColor = HIGHLIGHT_COLOR_TOKENS[color].soft;
            });
            applied = true;
        } else {
            const selectedRange = selectedRangeRef.current;
            const selectionSnapshot = selectionSnapshotRef.current;
            const rangeToHighlight = resolveSelectionRange(
                selectedRange,
                selectionSnapshot,
                selectionText,
                contentRoot,
            );
            if (rangeToHighlight) {
                applied = applyHighlightToRange(rangeToHighlight, contentRoot, highlightId, color);
            }
        }

        if (!applied) {
            return null;
        }

        const locationSnapshot = selectionSnapshotRef.current ?? (selectedRangeRef.current ? createSelectionSnapshot(selectedRangeRef.current, contentRoot) : null);

        addAnnotation({
            id: highlightId,
            bookId: articleAnnotationBookId,
            referenceId: articleAnnotationBookId,
            type: "highlight",
            location: buildArticleHighlightLocation(highlightId, locationSnapshot),
            selectedText: selectionText,
            color,
            createdAt: new Date(),
        });

        selectedRangeRef.current = null;
        selectionSnapshotRef.current = null;
        clearBrowserSelection();
        return highlightId;
    }, [addAnnotation, articleAnnotationBookId, clearBrowserSelection, selectedText]);

    const handleSelectHighlightColor = useCallback((color: HighlightColor) => {
        setPendingHighlightColor(color);
        if (editingHighlightId) {
            updateAnnotation(editingHighlightId, {
                color,
                updatedAt: new Date(),
            });

            const marks = contentRef.current?.querySelectorAll<HTMLElement>(
                `mark.article-highlight[data-highlight-id="${editingHighlightId}"]`,
            ) ?? [];
            marks.forEach((mark) => {
                mark.dataset.highlightColor = color;
                mark.style.backgroundColor = HIGHLIGHT_COLOR_TOKENS[color].soft;
            });

            selectedRangeRef.current = null;
            selectionSnapshotRef.current = null;
            clearBrowserSelection();
            setEditingHighlightId(null);
            setColorPickerMode("actions");
            setShowColorPicker(false);
            return;
        }

        const createdHighlightId = createHighlightAnnotation(color);
        if (!createdHighlightId) {
            return;
        }

        setEditingHighlightId(createdHighlightId);
        setColorPickerMode("actions");
        setShowColorPicker(false);
    }, [clearBrowserSelection, createHighlightAnnotation, editingHighlightId, updateAnnotation]);

    const handleAddNote = useCallback(() => {
        let highlightId = editingHighlightId;
        if (!highlightId) {
            highlightId = createHighlightAnnotation(pendingHighlightColor ?? "yellow");
        }
        if (!highlightId) {
            return;
        }

        const existingHighlight = highlightAnnotations.find((entry) => entry.id === highlightId);
        setEditingHighlightId(highlightId);
        setEditingNote(existingHighlight?.noteContent ?? "");
        setNoteEditorPosition(colorPickerPosition);
        setColorPickerMode("actions");
        setShowColorPicker(false);
        setShowNoteEditor(true);
    }, [
        colorPickerPosition,
        createHighlightAnnotation,
        editingHighlightId,
        highlightAnnotations,
        pendingHighlightColor,
    ]);

    const handleSaveNote = useCallback((noteContent: string) => {
        if (!editingHighlightId) {
            return;
        }

        updateAnnotation(editingHighlightId, {
            type: noteContent ? "note" : "highlight",
            noteContent: noteContent || undefined,
            updatedAt: new Date(),
        });
        setShowNoteEditor(false);
        setEditingHighlightId(null);
        setEditingNote("");
    }, [editingHighlightId, updateAnnotation]);

    const handleDeleteAnnotation = useCallback((annotationId: string) => {
        handleDeleteHighlightMark(annotationId);
        if (editingHighlightId === annotationId) {
            setEditingHighlightId(null);
            setEditingNote("");
        }
    }, [editingHighlightId, handleDeleteHighlightMark]);

    const handleJumpToHeading = useCallback((headingId: string) => {
        const target = document.getElementById(headingId);
        target?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, []);

    const handleNavigateToAnnotation = useCallback((locationValue: string) => {
        const container = scrollContainerRef.current;
        if (!container) {
            return;
        }

        const bookmarkProgress = parseBookmarkProgress(locationValue);
        if (bookmarkProgress !== null) {
            const maxScroll = container.scrollHeight - container.clientHeight;
            container.scrollTo({
                top: Math.max(0, Math.floor(maxScroll * bookmarkProgress)),
                behavior: "smooth",
            });
            setActivePanel(null);
            return;
        }

        if (locationValue.startsWith(ARTICLE_HIGHLIGHT_LOCATION_PREFIX)) {
            const parsedLocation = parseArticleHighlightLocation(locationValue);
            const highlightId = parsedLocation?.highlightId ?? "";
            if (!highlightId) {
                setActivePanel(null);
                return;
            }
            const target = contentRef.current?.querySelector<HTMLElement>(
                `mark.article-highlight[data-highlight-id="${highlightId}"]`,
            );
            target?.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        setActivePanel(null);
    }, []);

    const restoreHighlightMark = useCallback((annotation: Annotation) => {
        const contentRoot = contentRef.current;
        if (!contentRoot || !annotation.selectedText) {
            return;
        }

        if (contentRoot.querySelector(`mark.article-highlight[data-highlight-id="${annotation.id}"]`)) {
            return;
        }

        const parsedLocation = parseArticleHighlightLocation(annotation.location);
        if (
            parsedLocation?.highlightId
            && parsedLocation.highlightId === annotation.id
            && typeof parsedLocation.start === "number"
            && typeof parsedLocation.end === "number"
        ) {
            const rangeFromLocation = buildRangeFromSnapshot({
                start: parsedLocation.start,
                end: parsedLocation.end,
                text: normalizeSelectionText(annotation.selectedText),
            }, contentRoot);

            if (rangeFromLocation && rangeFromLocation.toString().trim()) {
                const appliedFromLocation = applyHighlightToRange(
                    rangeFromLocation,
                    contentRoot,
                    annotation.id,
                    annotation.color || "yellow",
                );
                if (appliedFromLocation) {
                    return;
                }
            }
        }

        const normalizedText = annotation.selectedText.trim();
        if (!normalizedText) {
            return;
        }

        const fullText = contentRoot.textContent || "";
        const fullTextIndex = fullText.indexOf(annotation.selectedText);
        if (fullTextIndex !== -1) {
            const fullTextRange = buildRangeFromSnapshot({
                start: fullTextIndex,
                end: fullTextIndex + annotation.selectedText.length,
                text: normalizeSelectionText(annotation.selectedText),
            }, contentRoot);

            if (fullTextRange && fullTextRange.toString().trim()) {
                const appliedFromFullText = applyHighlightToRange(
                    fullTextRange,
                    contentRoot,
                    annotation.id,
                    annotation.color || "yellow",
                );
                if (appliedFromFullText) {
                    return;
                }
            }
        }

        const treeWalker = document.createTreeWalker(contentRoot, NodeFilter.SHOW_TEXT, null);
        while (treeWalker.nextNode()) {
            const textNode = treeWalker.currentNode as Text;
            const textContent = textNode.textContent || "";
            if (!textContent.includes(normalizedText)) {
                continue;
            }

            if (textNode.parentElement?.closest("mark.article-highlight")) {
                continue;
            }

            const startIndex = textContent.indexOf(normalizedText);
            if (startIndex === -1) {
                continue;
            }

            const range = document.createRange();
            range.setStart(textNode, startIndex);
            range.setEnd(textNode, startIndex + normalizedText.length);
            applyHighlightToRange(
                range,
                contentRoot,
                annotation.id,
                annotation.color || "yellow",
            );
            break;
        }
    }, []);

    useEffect(() => {
        const contentRoot = contentRef.current;
        if (!contentRoot) {
            return;
        }

        const existingMarks = contentRoot.querySelectorAll<HTMLElement>("mark.article-highlight[data-highlight-id]");
        existingMarks.forEach((mark) => {
            const highlightId = mark.dataset.highlightId;
            if (!highlightId) {
                return;
            }

            const annotation = highlightAnnotations.find((entry) => entry.id === highlightId);
            if (annotation) {
                mark.style.backgroundColor = HIGHLIGHT_COLOR_TOKENS[annotation.color || "yellow"].soft;
            }
        });

        highlightAnnotations.forEach((annotation) => {
            restoreHighlightMark(annotation);
        });
    }, [
        sanitizedContent,
        article?.id,
        highlightAnnotations,
        restoreHighlightMark,
    ]);

    useEffect(() => {
        const contentRoot = contentRef.current;
        if (!contentRoot) {
            return;
        }

        let didUpdate = false;
        highlightAnnotations.forEach((annotation) => {
            if (backfilledIdsRef.current.has(annotation.id)) {
                return;
            }

            const parsedLocation = parseArticleHighlightLocation(annotation.location);
            if (!parsedLocation || parsedLocation.highlightId !== annotation.id) {
                backfilledIdsRef.current.add(annotation.id);
                return;
            }
            if (typeof parsedLocation.start === "number" && typeof parsedLocation.end === "number") {
                backfilledIdsRef.current.add(annotation.id);
                return;
            }

            const markRange = buildRangeFromHighlightMarks(contentRoot, annotation.id);
            if (!markRange) {
                return;
            }

            const snapshot = createSelectionSnapshot(markRange, contentRoot);
            if (!snapshot) {
                return;
            }

            backfilledIdsRef.current.add(annotation.id);
            didUpdate = true;
            updateAnnotation(annotation.id, {
                location: buildArticleHighlightLocation(annotation.id, snapshot),
                updatedAt: new Date(),
            });
        });

        if (didUpdate) {
        }
    }, [
        sanitizedContent,
        article?.id,
        highlightAnnotations,
        updateAnnotation,
    ]);

    const clearArticleSearchHighlights = useCallback(() => {
        const marks = contentRef.current?.querySelectorAll<HTMLElement>(ARTICLE_SEARCH_MARK_SELECTOR) ?? [];
        marks.forEach((mark) => {
            const parent = mark.parentNode;
            if (parent) {
                parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
                parent.normalize();
            }
        });
    }, []);

    const searchArticleContent = useCallback((query: string) => {
        const container = contentRef.current;
        const normalizedQuery = query.trim().toLowerCase();

        if (!container || !normalizedQuery) {
            clearArticleSearchHighlights();
            return [];
        }

        clearArticleSearchHighlights();

        const treeWalker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
        const results: Array<{ cfi: string; excerpt: string }> = [];

        while (treeWalker.nextNode()) {
            const textNode = treeWalker.currentNode as Text;
            const text = textNode.textContent || "";
            const lowerText = text.toLowerCase();
            let cursor = 0;

            while (cursor < lowerText.length) {
                const matchIndex = lowerText.indexOf(normalizedQuery, cursor);
                if (matchIndex === -1) {
                    break;
                }

                const excerptStart = Math.max(0, matchIndex - 40);
                const excerptEnd = Math.min(
                    text.length,
                    matchIndex + normalizedQuery.length + 40,
                );
                const excerpt = `${excerptStart > 0 ? "..." : ""}${text.slice(excerptStart, excerptEnd)}${excerptEnd < text.length ? "..." : ""}`;

                const range = document.createRange();
                range.setStart(textNode, matchIndex);
                range.setEnd(textNode, matchIndex + normalizedQuery.length);

                const mark = document.createElement("mark");
                mark.className = "article-search-highlight";
                mark.style.backgroundColor = "color-mix(in srgb, var(--color-accent) 24%, transparent)";
                mark.style.color = "var(--color-text-primary)";
                mark.style.borderRadius = "2px";
                mark.style.padding = "0 1px";

                let isHighlighted = false;
                try {
                    range.surroundContents(mark);
                    isHighlighted = true;
                } catch {
                    
                }

                cursor = matchIndex + normalizedQuery.length;

                if (isHighlighted) {
                    const resultIndex = results.length;
                    mark.dataset.searchIndex = String(resultIndex);
                    results.push({
                        cfi: `article-search:${resultIndex}`,
                        excerpt,
                    });
                }

                break;
            }

            if (results.length >= MAX_ARTICLE_SEARCH_RESULTS) {
                break;
            }
        }

        return results;
    }, [clearArticleSearchHighlights]);

    const handleArticleSearch = useCallback(async function* (query: string) {
        const results = searchArticleContent(query);
        for (const result of results) {
            yield result;
        }
        yield "done" as const;
    }, [searchArticleContent]);

    const handleArticleSearchNavigate = useCallback((target: string) => {
        const match = target.match(/^article-search:(\d+)$/);
        if (!match) {
            return;
        }

        const index = Number(match[1]);
        if (!Number.isFinite(index) || index < 0) {
            return;
        }

        const resultMarks = contentRef.current?.querySelectorAll<HTMLElement>(ARTICLE_SEARCH_MARK_SELECTOR);
        resultMarks?.item(index)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, []);

    const handleDefine = useCallback(async () => {
        const term = selectedText.trim();
        if (!term) {
            return;
        }

        setColorPickerMode("dictionary");
        setShowColorPicker(true);
        clearBrowserSelection();
        setDictionaryState({
            term,
            result: null,
            loading: true,
            error: null,
            saved: false,
        });

        try {
            const result = await lookupTerm(term, "en");
            setDictionaryState((previous) => ({
                ...previous,
                loading: false,
                result,
            }));
        } catch (error) {
            setDictionaryState((previous) => ({
                ...previous,
                loading: false,
                error: error instanceof Error ? error.message : "Lookup failed",
            }));
        }
    }, [clearBrowserSelection, lookupTerm, selectedText]);

    const handleSaveToVocabulary = useCallback(() => {
        if (!dictionaryState.result || !article) {
            return;
        }

        const term = vocabularyTermFromLookup(dictionaryState.result);
        saveVocabularyTerm(term);

        setDictionaryState((previous) => ({ ...previous, saved: true }));
    }, [article, dictionaryState.result, saveVocabularyTerm]);

    const metadata = useMemo<DocMetadata | null>(() => {
        if (!article) {
            return null;
        }

        return {
            title: article.title || "Untitled Article",
            author: article.author || feedTitle || "Unknown Source",
            description: buildArticleDescription(article),
            publisher: feedTitle,
            pubdate: formatArticleDate(article.publishedAt ?? article.fetchedAt) || undefined,
        };
    }, [article, feedTitle]);

    const location = useMemo<DocLocation | null>(() => {
        if (!article) {
            return null;
        }

        return {
            cfi: `rss:${article.id}`,
            percentage: readingProgress,
        };
    }, [article, readingProgress]);

    const articleToc = useMemo(() => buildArticleToc(headings), [headings]);
    const usesSharedPanelBackdrop = activePanel === "toc"
        || activePanel === "search"
        || activePanel === "settings"
        || activePanel === "bookmarks";
    const shouldShowReaderChrome = showChrome || activePanel !== null;

    if (!article) {
        return null;
    }

    return (
        <div
            className={cn(
                "fixed inset-0 z-[var(--z-modal)]",
                isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
            )}
        >
            <div
                className={cn(
                    "absolute inset-0 overflow-hidden",
                    `theme-${theme}`,
                )}
                style={{
                    backgroundColor: "var(--reader-bg)",
                    filter: `brightness(${brightness}%)`,
                    overscrollBehavior: "none",
                }}
                data-reading-mode="scroll"
            >
                <div
                    ref={toolbarContainerRef}
                    className={cn(
                        "absolute left-0 right-0 top-0 z-[140] transition-transform duration-300",
                        shouldShowReaderChrome ? "translate-y-0" : "-translate-y-full",
                    )}
                >
                    <WindowTitlebar
                        metadata={metadata}
                        location={location}
                        onBack={onClose}
                        onPrevPage={() => scrollByViewport(-1)}
                        onNextPage={() => scrollByViewport(1)}
                        onToggleToc={() => togglePanel("toc")}
                        onToggleSettings={() => togglePanel("settings")}
                        onToggleBookmarks={() => togglePanel("bookmarks")}
                        onToggleSearch={() => togglePanel("search")}
                        onToggleInfo={() => togglePanel("info")}
                        onToggleMenu={() => togglePanel("menu")}
                        onAddBookmark={handleAddScrollBookmark}
                        isCurrentPageBookmarked={Boolean(currentBookmark)}
                        activePanel={activePanel}
                        fullscreen={isFullscreen}
                        onToggleFullscreen={handleToggleFullscreen}
                    />
                </div>

                <Backdrop visible={activePanel !== null && !usesSharedPanelBackdrop} onClick={closePanel} blur />

                <TableOfContents
                    toc={articleToc}
                    visible={activePanel === "toc"}
                    onNavigate={handleJumpToHeading}
                    onClose={closePanel}
                />

                <ReaderSearch
                    visible={activePanel === "search"}
                    onClose={closePanel}
                    onSearch={handleArticleSearch}
                    onNavigate={handleArticleSearchNavigate}
                    onClearSearch={clearArticleSearchHighlights}
                />

                <ReaderAnnotationsPanel
                    bookId={articleAnnotationBookId}
                    visible={activePanel === "bookmarks"}
                    onClose={closePanel}
                    onNavigate={handleNavigateToAnnotation}
                    onDelete={handleDeleteAnnotation}
                />

                <ReaderSettings
                    settings={globalReaderSettings}
                    visible={activePanel === "settings"}
                    onUpdate={updateReaderSetting}
                    format="epub"
                    onClose={closePanel}
                />

                <ArticleReaderInfoPanel
                    visible={activePanel === "info"}
                    article={article}
                    feedTitle={feedTitle}
                    onClose={closePanel}
                />

                <div
                    className="absolute inset-0 overflow-hidden"
                    onClick={() => {
                        const sel = window.getSelection();
                        if (!sel || sel.isCollapsed) {
                            setShowChrome(s => !s);
                        }
                    }}
                >
                    <ArticleReaderContent
                        article={article}
                        feedTitle={feedTitle}
                        fontSize={fontSize}
                        lineHeight={lineHeight}
                        fontFamily={fontFamily}
                        textAlign={textAlign}
                        letterSpacing={letterSpacing}
                        wordSpacing={wordSpacing}
                        contentRef={contentRef}
                        scrollContainerRef={scrollContainerRef}
                        onTextSelect={handleTextSelect}
                        onHeadingsChange={setHeadings}
                        sanitizedContent={sanitizedContent}
                    />
                </div>
            </div>

            <HighlightColorPicker
                isOpen={showColorPicker}
                position={colorPickerPosition}
                currentColor={editingHighlightId
                    ? (highlightAnnotations.find((entry) => entry.id === editingHighlightId)?.color ?? pendingHighlightColor)
                    : pendingHighlightColor}
                onSelectColor={handleSelectHighlightColor}
                onAddNote={handleAddNote}
                onDefine={handleDefine}
                onBookmark={handleAddScrollBookmark}
                dictionary={colorPickerMode === "dictionary"
                    ? {
                        term: dictionaryState.term,
                        result: dictionaryState.result,
                        loading: dictionaryState.loading,
                        error: dictionaryState.error,
                        saved: dictionaryState.saved,
                        canSaveToVocabulary: learningSettings.vocabularyEnabled,
                        onSave: handleSaveToVocabulary,
                        onBack: () => setColorPickerMode("actions"),
                    }
                    : undefined}
                onClose={() => {
                    removeTempSelectionMarks(contentRef.current);
                    selectedRangeRef.current = null;
                    selectionSnapshotRef.current = null;
                    setShowColorPicker(false);
                    setColorPickerMode("actions");
                    setEditingHighlightId(null);
                    setDictionaryState({
                        term: "",
                        result: null,
                        loading: false,
                        error: null,
                        saved: false,
                    });
                    clearBrowserSelection();
                }}
            />

            <NoteEditor
                isOpen={showNoteEditor}
                position={noteEditorPosition}
                initialNote={editingNote}
                selectedText={selectedText}
                onSave={handleSaveNote}
                onClose={() => {
                    removeTempSelectionMarks(contentRef.current);
                    setShowNoteEditor(false);
                    setEditingNote("");
                    setEditingHighlightId(null);
                    selectedRangeRef.current = null;
                    selectionSnapshotRef.current = null;
                    clearBrowserSelection();
                }}
            />
        </div>
    );
});
