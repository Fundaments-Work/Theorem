import { HIGHLIGHT_COLOR_TOKENS } from "../../../core/lib/design-tokens";
import type { HighlightColor } from "../../../core/types";

export interface TextSelectionSnapshot {
    start: number;
    end: number;
    text: string;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
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

    const mark = createHighlightMark(highlightId, color);
    parent.replaceChild(mark, highlightedNode);
    mark.appendChild(highlightedNode);
    return true;
}

export interface ArticleTextIndex {
    nodes: Text[];
    starts: number[];
    lens: number[];
    fullText: string;
    totalLength: number;
}

export function buildArticleTextIndex(contentRoot: HTMLElement): ArticleTextIndex {
    const nodes: Text[] = [];
    const starts: number[] = [];
    const lens: number[] = [];
    const parts: string[] = [];
    let traversed = 0;
    const walker = document.createTreeWalker(contentRoot, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
        const textNode = walker.currentNode as Text;
        const textLength = textNode.textContent?.length ?? 0;
        if (textLength === 0) {
            continue;
        }
        nodes.push(textNode);
        starts.push(traversed);
        lens.push(textLength);
        parts.push(textNode.textContent ?? "");
        traversed += textLength;
    }
    return { nodes, starts, lens, fullText: parts.join(""), totalLength: traversed };
}

export interface IndexedRange {
    range: Range;
    startIdx: number;
    startOff: number;
    endIdx: number;
    endOff: number;
}

export function buildIndexedRange(
    snapshot: TextSelectionSnapshot,
    index: ArticleTextIndex,
): IndexedRange | null {
    const startTarget = Math.max(0, snapshot.start);
    const endTarget = Math.max(startTarget, snapshot.end);
    if (endTarget <= startTarget || index.nodes.length === 0) {
        return null;
    }
    const find = (target: number): number => {
        let lo = 0;
        let hi = index.nodes.length - 1;
        let ans = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (index.starts[mid] + index.lens[mid] >= target) {
                ans = mid;
                hi = mid - 1;
            } else {
                lo = mid + 1;
            }
        }
        return ans;
    };
    const startIdx = find(startTarget);
    if (startIdx === -1) {
        return null;
    }
    const startNode = index.nodes[startIdx];
    const startLiveLen = startNode.textContent?.length ?? 0;
    const startOff = clamp(startTarget - index.starts[startIdx], 0, startLiveLen);
    let endIdx = find(endTarget);
    let endNode: Text;
    let endOff: number;
    if (endIdx === -1) {
        endIdx = index.nodes.length - 1;
        endNode = index.nodes[endIdx];
        endOff = endNode.textContent?.length ?? 0;
    } else {
        endNode = index.nodes[endIdx];
        const endLiveLen = endNode.textContent?.length ?? 0;
        endOff = clamp(endTarget - index.starts[endIdx], 0, endLiveLen);
    }
    if (startNode === endNode && endOff <= startOff) {
        return null;
    }
    try {
        const range = document.createRange();
        range.setStart(startNode, startOff);
        range.setEnd(endNode, endOff);
        return { range, startIdx, startOff, endIdx, endOff };
    } catch {
        return null;
    }
}

export function applyHighlightToIndexedNodes(
    indexed: IndexedRange,
    index: ArticleTextIndex,
    highlightId: string,
    color: HighlightColor,
): boolean {
    let applied = false;
    for (let i = indexed.startIdx; i <= indexed.endIdx; i++) {
        const textNode = index.nodes[i];
        if (!textNode.isConnected) {
            continue;
        }
        if (textNode.parentElement?.closest("mark.article-highlight")) {
            continue;
        }
        const len = textNode.textContent?.length ?? 0;
        if (len === 0) {
            continue;
        }
        const startOffset = i === indexed.startIdx ? Math.min(indexed.startOff, len) : 0;
        const endOffset = i === indexed.endIdx ? Math.min(indexed.endOff, len) : len;
        if (wrapTextNodeRange(textNode, startOffset, endOffset, highlightId, color)) {
            applied = true;
        }
    }
    return applied;
}
