// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import "../src/features/reader/foliate-js-runtime/paginator.js";

describe("Foliate CSS data event resilience (data.replace TypeError fix)", () => {
    const createPaginator = () => {
        const paginator = document.createElement("foliate-paginator") as any;
        document.body.appendChild(paginator);
        const transformTarget = new EventTarget();
        const book = {
            dir: "ltr",
            sections: [],
            transformTarget,
        };
        paginator.open(book);
        return { paginator, transformTarget };
    };

    it("transforms string CSS containing -epub- prefixes and viewport units", async () => {
        const { paginator, transformTarget } = createPaginator();
        const rawCss = `
            .title {
                -epub-writing-mode: vertical-rl;
                width: 50vw;
                height: 50vh;
                page-break-after: always;
                break-before: page;
            }
        `;
        const detail = { type: "text/css", data: rawCss, name: "styles/main.css" };
        transformTarget.dispatchEvent(new CustomEvent("data", { detail }));

        const result = await detail.data;
        expect(typeof result).toBe("string");
        expect(result).not.toContain("-epub-writing-mode");
        expect(result).toContain("writing-mode: vertical-rl");
        expect(result).not.toContain("50vw");
        expect(result).not.toContain("50vh");
        expect(result).toContain("-webkit-column-break-after:");
        expect(result).toContain("break-before: column");

        paginator.destroy?.();
    });

    it("safely handles Blob data without throwing TypeError: data.replace is not a function", async () => {
        const { paginator, transformTarget } = createPaginator();
        const cssContent = "p { -epub-hyphens: auto; width: 10vw; }";
        const blob = new Blob([cssContent], { type: "text/css" });

        const detail = { type: "text/css", data: blob, name: "styles/unmanifested.css" };
        transformTarget.dispatchEvent(new CustomEvent("data", { detail }));

        // Previously, `data.replace` on a Blob threw:
        // TypeError: data.replace is not a function
        const result = await detail.data;
        expect(typeof result).toBe("string");
        expect(result).toContain("hyphens: auto;");
        expect(result).not.toContain("-epub-hyphens");
        expect(result).not.toContain("10vw");

        paginator.destroy?.();
    });

    it("safely handles a Promise that resolves to a Blob", async () => {
        const { paginator, transformTarget } = createPaginator();
        const cssContent = "h1 { -epub-text-orientation: mixed; }";
        const blobPromise = Promise.resolve(new Blob([cssContent], { type: "text/css" }));

        const detail = { type: "text/css", data: blobPromise, name: "styles/blob-promise.css" };
        transformTarget.dispatchEvent(new CustomEvent("data", { detail }));

        const result = await detail.data;
        expect(typeof result).toBe("string");
        expect(result).toContain("text-orientation: mixed;");

        paginator.destroy?.();
    });

    it("safely handles ArrayBuffer and Uint8Array binary CSS data", async () => {
        const { paginator, transformTarget } = createPaginator();
        const cssContent = "body { -epub-word-break: break-all; }";
        const encoder = new TextEncoder();
        const uint8Array = encoder.encode(cssContent);

        const detail = { type: "text/css", data: uint8Array, name: "styles/binary.css" };
        transformTarget.dispatchEvent(new CustomEvent("data", { detail }));

        const result = await detail.data;
        expect(typeof result).toBe("string");
        expect(result).toContain("word-break: break-all;");

        // Also test ArrayBuffer
        const bufferDetail = { type: "text/css", data: uint8Array.buffer, name: "styles/buffer.css" };
        transformTarget.dispatchEvent(new CustomEvent("data", { detail: bufferDetail }));
        const bufferResult = await bufferDetail.data;
        expect(typeof bufferResult).toBe("string");
        expect(bufferResult).toContain("word-break: break-all;");

        paginator.destroy?.();
    });

    it("safely handles null and undefined data without throwing TypeError", async () => {
        const { paginator, transformTarget } = createPaginator();

        const nullDetail = { type: "text/css", data: null, name: "styles/null.css" };
        transformTarget.dispatchEvent(new CustomEvent("data", { detail: nullDetail }));
        const nullResult = await nullDetail.data;
        expect(nullResult).toBeNull();

        const undefDetail = { type: "text/css", data: undefined, name: "styles/undef.css" };
        transformTarget.dispatchEvent(new CustomEvent("data", { detail: undefDetail }));
        const undefResult = await undefDetail.data;
        expect(undefResult).toBeUndefined();

        const nullPromiseDetail = { type: "text/css", data: Promise.resolve(null), name: "styles/null-prom.css" };
        transformTarget.dispatchEvent(new CustomEvent("data", { detail: nullPromiseDetail }));
        const nullPromiseResult = await nullPromiseDetail.data;
        expect(nullPromiseResult).toBeNull();

        paginator.destroy?.();
    });

    it("safely catches rejected data promises and returns empty string instead of failing section", async () => {
        const { paginator, transformTarget } = createPaginator();

        const rejectedDetail = {
            type: "text/css",
            data: Promise.reject(new Error("File not found in ZIP archive")),
            name: "styles/missing.css",
        };
        transformTarget.dispatchEvent(new CustomEvent("data", { detail: rejectedDetail }));

        // detail.data should NOT reject unhandled; it should resolve to ""
        const result = await rejectedDetail.data;
        expect(result).toBe("");

        paginator.destroy?.();
    });

    it("ignores non-CSS resources (does not touch or decode images, html, etc.)", async () => {
        const { paginator, transformTarget } = createPaginator();

        const imageBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
        const imageDetail = { type: "image/png", data: imageBlob, name: "images/cover.png" };
        transformTarget.dispatchEvent(new CustomEvent("data", { detail: imageDetail }));

        // Since type !== 'text/css', detail.data remains the exact original Blob reference
        expect(imageDetail.data).toBe(imageBlob);

        paginator.destroy?.();
    });

    it("successfully loads a section that references an unmanifested CSS file without crashing", async () => {
        const { EPUB } = await import("../src/features/reader/foliate-js-runtime/epub.js");
        const paginator = document.createElement("foliate-paginator") as any;
        document.body.appendChild(paginator);

        const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

        const opfXml = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">test-book</dc:identifier>
    <dc:title>Test Book</dc:title>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>`;

        const ch1Xhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <link rel="stylesheet" href="unmanifested.css" type="text/css"/>
  <link rel="stylesheet" href="missing.css" type="text/css"/>
</head>
<body>
  <h1>Chapter 1</h1>
  <p>Text content here.</p>
</body>
</html>`;

        const unmanifestedCss = "p { -epub-hyphens: auto; width: 100vw; }";

        const files: Record<string, string> = {
            "META-INF/container.xml": containerXml,
            "OEBPS/content.opf": opfXml,
            "OEBPS/ch1.xhtml": ch1Xhtml,
            "OEBPS/unmanifested.css": unmanifestedCss,
        };

        const epub = new EPUB({
            loadText: async (uri: string) => files[uri] ?? null,
            loadBlob: async (uri: string) => {
                if (uri in files) return new Blob([files[uri]], { type: "text/css" });
                return null;
            },
            getSize: (uri: string) => files[uri]?.length ?? 0,
            sha1: async () => "",
        });

        await epub.init();
        paginator.open(epub);

        expect(epub.sections).toHaveLength(1);
        // Previously, loading section 0 failed with:
        // TypeError: data.replace is not a function
        // Error: Failed to load section 0
        const sectionUrl = await epub.sections[0].load();
        expect(typeof sectionUrl).toBe("string");
        expect(sectionUrl.startsWith("blob:")).toBe(true);

        paginator.destroy?.();
    });

    it("safely handles load events when detail.doc is missing or undefined", () => {
        const { paginator } = createPaginator();
        expect(() => {
            paginator.dispatchEvent(new CustomEvent("load", { detail: {} }));
            paginator.dispatchEvent(new CustomEvent("load", { detail: { doc: null } }));
        }).not.toThrow();
        paginator.destroy?.();
    });

    it("safely handles fixed-layout getViewport with null doc or missing attributes", async () => {
        await import("../src/features/reader/foliate-js-runtime/fixed-layout.js");
        const fxl = document.createElement("foliate-fxl") as any;
        document.body.appendChild(fxl);

        expect(() => {
            fxl.dispatchEvent(new CustomEvent("load", { detail: { doc: null, index: 0 } }));
        }).not.toThrow();

        fxl.remove();
    });

    it("does not engage isKeyboardSelecting for navigation keys without Shift", () => {
        const { paginator } = createPaginator();

        const mockDoc = document.implementation.createHTMLDocument("Mock Chapter");
        mockDoc.body.innerHTML = "<p>First paragraph</p><p>Second paragraph</p>";

        paginator.dispatchEvent(new CustomEvent("load", { detail: { doc: mockDoc, index: 0 } }));
        mockDoc.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: false }));

        const sel = mockDoc.getSelection();
        if (sel) {
            const range = mockDoc.createRange();
            range.selectNodeContents(mockDoc.body.querySelector("p")!);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        }

        expect(() => {
            mockDoc.dispatchEvent(new Event("selectionchange"));
        }).not.toThrow();

        paginator.destroy?.();
    });

    it("handles setStyles and focusView safely when view or document is null/detached", () => {
        const { paginator } = createPaginator();

        expect(() => {
            paginator.setStyles?.(["body { color: red; }", "p { font-size: 16px; }"]);
        }).not.toThrow();

        expect(() => {
            paginator.focusView?.();
        }).not.toThrow();

        paginator.destroy?.();
    });

    it("handles relocate events with null/primitive anchor safely", () => {
        const { paginator } = createPaginator();

        expect(() => {
            paginator.dispatchEvent(new CustomEvent("relocate", {
                detail: { reason: "navigation", range: null, index: 0 },
            }));
            paginator.dispatchEvent(new CustomEvent("relocate", {
                detail: { reason: "selection", range: undefined, index: 0 },
            }));
        }).not.toThrow();

        paginator.destroy?.();
    });
});


