import { strToU8, zipSync } from "fflate";
import type { RssArticle } from "../types";
import { isTauri } from "./env";
import { sanitizeArticleHtml } from "../../features/reader/article-reader/utils";

function escapeXml(unsafe: string): string {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function htmlToValidXhtmlBody(htmlContent: string, coverImageUrl?: string): { xhtml: string; hasCoverInBody: boolean } {
    if (typeof DOMParser === "undefined") {
        return { xhtml: `<div>${escapeXml(htmlContent)}</div>`, hasCoverInBody: false };
    }

    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(`<body>${htmlContent}</body>`, "text/html");
        
        // Remove scripts, styles, iframes
        doc.querySelectorAll("script, style, iframe, object, embed, form").forEach(el => el.remove());

        let hasCoverInBody = false;
        const normalizedCover = coverImageUrl?.trim().toLowerCase();

        const images = Array.from(doc.querySelectorAll<HTMLImageElement>("img[src]"));
        const seenSrcs = new Set<string>();

        for (const img of images) {
            const src = img.getAttribute("src")?.trim();
            if (!src) continue;
            const normSrc = src.toLowerCase();

            // Check if this matches coverImageUrl
            if (normalizedCover && (normSrc === normalizedCover || normalizedCover.endsWith(normSrc) || normSrc.endsWith(normalizedCover))) {
                hasCoverInBody = true;
            }

            // Remove duplicate identical images in body
            if (seenSrcs.has(normSrc)) {
                img.remove();
            } else {
                seenSrcs.add(normSrc);
            }
        }

        const serializer = new XMLSerializer();
        let serialized = "";
        for (const child of Array.from(doc.body.childNodes)) {
            serialized += serializer.serializeToString(child);
        }
        return {
            xhtml: serialized || `<div>${escapeXml(htmlContent)}</div>`,
            hasCoverInBody,
        };
    } catch {
        return { xhtml: `<div>${escapeXml(htmlContent)}</div>`, hasCoverInBody: false };
    }
}

export async function convertArticleToEpubBlob(article: RssArticle, feedTitle?: string): Promise<Blob> {
    const rawContent = article.fullContent || article.content || article.summary || "";
    const sanitizedHtml = sanitizeArticleHtml(rawContent);
    const { xhtml: xhtmlBody, hasCoverInBody } = htmlToValidXhtmlBody(sanitizedHtml, article.imageUrl);
    const shouldRenderCover = !!article.imageUrl && !hasCoverInBody;

    const title = article.title || "Untitled Article";
    const author = article.author || feedTitle || "RSS Feed";

    if (isTauri()) {
        try {
            const { invoke } = await import("@tauri-apps/api/core");
            const bytes = await invoke<number[] | Uint8Array>("create_article_epub_native", {
                payload: {
                    title,
                    author: author || null,
                    content: xhtmlBody,
                    url: article.url || null,
                    coverImageUrl: shouldRenderCover ? article.imageUrl : null,
                    publishedAt: article.publishedAt || null,
                },
            });
            const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            return new Blob([u8 as unknown as BlobPart], { type: "application/epub+zip" });
        } catch (err) {
            if (import.meta.env.DEV) {
                console.warn("Native article EPUB creation failed, falling back to JS fflate:", err);
            }
        }
    }

    const escapedTitle = escapeXml(title);
    const escapedAuthor = escapeXml(author);
    const escapedFeedTitle = feedTitle ? escapeXml(feedTitle) : "";

    const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

    const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="pub-id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">rss:${article.id}</dc:identifier>
    <dc:title>${escapedTitle}</dc:title>
    <dc:creator>${escapedAuthor}</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="article" href="article.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="style" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="article"/>
  </spine>
</package>`;

    const navXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head>
    <title>Table of Contents</title>
  </head>
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="article.xhtml">${escapedTitle}</a></li>
      </ol>
    </nav>
  </body>
</html>`;

    const styleCss = `
* {
  box-sizing: border-box;
}
html, body {
  margin: 0 !important;
  padding: 0 !important;
}
body {
  line-height: 1.6;
}
h1 {
  font-size: 1.6em;
  font-weight: 700;
  line-height: 1.25;
  margin: 0.5em 0 0.25em 0;
  break-after: avoid;
  page-break-after: avoid;
}
.article-meta {
  color: #71717a;
  font-size: 0.85em;
  font-family: system-ui, -apple-system, sans-serif;
  margin-bottom: 1.5em;
  padding-bottom: 0.75em;
  border-bottom: 1px solid rgba(161, 161, 170, 0.2);
  break-after: avoid;
  page-break-after: avoid;
}
p {
  margin: 0.85em 0;
  orphans: 2;
  widows: 2;
}
img {
  max-width: 100%;
  max-height: 70vh;
  height: auto;
  object-fit: contain;
  margin: 1em auto;
  display: block;
  border-radius: 6px;
  break-inside: avoid;
  page-break-inside: avoid;
}
blockquote {
  border-left: 3px solid rgba(161, 161, 170, 0.4);
  padding-left: 1em;
  margin: 1em 0;
  font-style: italic;
  break-inside: avoid;
  page-break-inside: avoid;
}
a {
  color: var(--color-accent, #60a5fa);
  text-decoration: underline;
}
pre, code {
  font-family: monospace;
  background: rgba(161, 161, 170, 0.1);
  border-radius: 3px;
}
pre {
  padding: 0.75em;
  overflow-x: auto;
  break-inside: avoid;
  page-break-inside: avoid;
}
`;

    const articleXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>${escapedTitle}</title>
    <link rel="stylesheet" type="text/css" href="style.css"/>
  </head>
  <body>
    <h1>${escapedTitle}</h1>
    <div class="article-meta">
      ${escapedFeedTitle}${escapedFeedTitle && escapedAuthor ? " · " : ""}${escapedAuthor}
    </div>
    ${shouldRenderCover ? `<p><img src="${escapeXml(article.imageUrl!)}" alt=""/></p>` : ""}
    <div class="article-content">
      ${xhtmlBody}
    </div>
  </body>
</html>`;

    const zipData = zipSync({
        "mimetype": [strToU8("application/epub+zip"), { level: 0 }],
        "META-INF/container.xml": strToU8(containerXml),
        "OEBPS/content.opf": strToU8(contentOpf),
        "OEBPS/nav.xhtml": strToU8(navXhtml),
        "OEBPS/style.css": strToU8(styleCss),
        "OEBPS/article.xhtml": strToU8(articleXhtml),
    });

    return new Blob([zipData], { type: "application/epub+zip" });
}
