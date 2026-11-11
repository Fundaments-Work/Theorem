// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeHtml } from "../src/core/lib/sanitize";
import { isSafeWebUrl } from "../src/core/lib/url-safety";
import { ArticleExtractorService } from "../src/core/services/ArticleExtractorService";
import { HighlightColorPicker } from "../src/features/reader/components/highlights/HighlightColorPicker";
import { FootnotePopover } from "../src/features/reader/components/FootnotePopover";
import { ReaderSearch } from "../src/features/reader/components/ReaderSearch";

function stubVirtualizerLayout(width = 800, height = 600): () => void {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const keys = ["offsetWidth", "offsetHeight", "clientWidth", "clientHeight"] as const;
    const before = keys.map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);
    for (const key of keys) {
        Object.defineProperty(proto, key, {
            get: () => (key.includes("Width") ? width : height),
            configurable: true,
        });
    }
    const prevRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    return () => {
        for (const [key, desc] of before) {
            if (desc) Object.defineProperty(proto, key, desc);
        }
        globalThis.ResizeObserver = prevRO;
    };
}

describe("reader HTML sanitization and XSS guards", () => {
    let root: Root | null = null;
    let host: HTMLDivElement | null = null;
    let restoreLayout: (() => void) | null = null;

    beforeEach(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        restoreLayout = stubVirtualizerLayout();
        host = document.createElement("div");
        document.body.append(host);
        root = createRoot(host);
    });

    afterEach(() => {
        if (root && host) {
            act(() => root?.unmount());
            host?.remove();
        }
        restoreLayout?.();
        restoreLayout = null;
        root = null;
        host = null;
        document.body.innerHTML = "";
    });

    it("strips active HTML, unsafe URLs, and unsafe CSS urls in sanitizeHtml", () => {
        const cleaned = sanitizeHtml(
            '<p style="background:url(https://evil.test/x);color:red">'
            + '<a href="ftp://evil.test/f">ftp</a>'
            + '<a href="https://example.com">ok</a>'
            + '<img src="data:text/html,<script>alert(1)</script>" onerror="alert(1)">'
            + '<script>window.__xss = 1</script></p>',
        );
        expect(cleaned).not.toMatch(/<script/i);
        expect(cleaned).not.toMatch(/onerror/i);
        expect(cleaned).not.toMatch(/ftp:/i);
        expect(cleaned).not.toMatch(/data:text\/html/i);
        expect(cleaned).not.toMatch(/url\s*\(/i);
        expect(cleaned).toContain('href="https://example.com"');
    });

    it("rejects non-http/https schemes in isSafeWebUrl and ArticleExtractorService.extractFromUrl", async () => {
        expect(isSafeWebUrl("https://example.com/article")).toBe(true);
        expect(isSafeWebUrl("http://example.com/article")).toBe(true);
        expect(isSafeWebUrl("httpx://example.com/article")).toBe(false);
        expect(isSafeWebUrl("javascript:alert(1)")).toBe(false);
        expect(isSafeWebUrl("//example.com/article")).toBe(false);

        const fetchSpy = vi.spyOn(globalThis, "fetch");
        expect(await ArticleExtractorService.extractFromUrl("httpx://example.com/bad")).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
    });

    it("sanitizes dictionary definition HTML in HighlightColorPicker", () => {
        act(() => {
            root?.render(
                <HighlightColorPicker
                    isOpen={true}
                    position={{ x: 100, y: 100 }}
                    onSelectColor={vi.fn()}
                    onAddNote={vi.fn()}
                    onBookmark={vi.fn()}
                    onClose={vi.fn()}
                    dictionary={{
                        term: "test",
                        loading: false,
                        saved: false,
                        onSave: vi.fn(),
                        result: {
                            term: "test",
                            normalizedTerm: "test",
                            language: "en",
                            providersUsed: ["stardict"],
                            meanings: [
                                {
                                    provider: "stardict",
                                    partOfSpeech: "noun",
                                    definitions: [
                                        '<b>safe</b><img src="x" onerror="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)">bad</a>',
                                    ],
                                },
                            ],
                        },
                    }}
                />,
            );
        });

        const dictEl = document.body.querySelector(".dict-definition");
        expect(dictEl).not.toBeNull();
        expect(dictEl?.innerHTML).toContain("<b>safe</b>");
        expect(dictEl?.querySelector("script")).toBeNull();
        expect(dictEl?.querySelector("img")?.getAttribute("onerror")).toBeNull();
        expect(dictEl?.querySelector("a")?.getAttribute("href")).toBeNull();
    });

    it("sanitizes footnote HTML in FootnotePopover", () => {
        act(() => {
            root?.render(
                <FootnotePopover
                    footnote={{
                        title: "Note 1",
                        text: "Footnote text",
                        href: "#fn1",
                        html: '<p>Footnote <em>text</em><img src="x" onerror="alert(1)"><script>evil()</script><a href="javascript:alert(1)">bad</a></p>',
                    }}
                    onClose={vi.fn()}
                />,
            );
        });

        expect(document.body.textContent).toContain("Footnote text");
        expect(document.body.querySelector("script")).toBeNull();
        expect(document.body.querySelector("img")?.getAttribute("onerror")).toBeNull();
        expect(document.body.querySelector("a")?.getAttribute("href")).toBeNull();
    });

    it("renders ReaderSearch excerpts safely via React text nodes without dangerouslySetInnerHTML", async () => {
        async function* mockSearch() {
            yield { cfi: "epubcfi(/6/4!/4/2:0)", excerpt: 'Before <script>alert("xss")</script> needle after' };
            yield "done" as const;
        }

        await act(async () => {
            root?.render(
                <ReaderSearch
                    visible={true}
                    onClose={vi.fn()}
                    onNavigate={vi.fn()}
                    onSearch={mockSearch}
                    onClearSearch={vi.fn()}
                />,
            );
        });

        const input = document.body.querySelector('input[type="text"]') as HTMLInputElement | null;
        expect(input).not.toBeNull();
        await act(async () => {
            if (input) {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
                setter?.call(input, "needle");
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
            }
        });
        await act(async () => {
            await new Promise((r) => setTimeout(r, 20));
        });

        expect(document.body.querySelector("script")).toBeNull();
        expect(document.body.textContent).toContain('Before <script>alert("xss")</script>');
        expect(document.body.textContent).toContain("needle");
    });
});
