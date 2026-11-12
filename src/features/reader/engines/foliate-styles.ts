import {
    type getCurrentReaderSettings,
    getHighlightSolidColor,
    getThemeColors,
} from "../../../core/lib/design-tokens";
import type {
    BookFormat,
    HighlightColor,
    PageLayout,
    ReaderTheme,
    ReadingFlow,
    TocItem,
} from "../../../core/types";

export type EffectiveReaderSettings = NonNullable<ReturnType<typeof getCurrentReaderSettings>>;
import { COMIC_SCROLL_CSS, isComicFormat } from "./comic-flow";
import { getCSS } from "../foliate/reader.js";
import { getTheme } from "../foliate/themes";

export const SELECTION_OVERLAY_CLASS = "theorem-selection-overlay";
/** Same look as PDF selection (see .textLayer ::selection). */
export const SELECTION_FILL = "color-mix(in srgb, var(--color-accent) 35%, transparent)";

export function getHighlightColor(colorName: string): string {
    const colorKey: HighlightColor = (
        colorName === "yellow"
        || colorName === "green"
        || colorName === "blue"
        || colorName === "red"
        || colorName === "orange"
        || colorName === "purple"
    )
        ? colorName
        : "yellow";
    return getHighlightSolidColor(colorKey);
}

export function extractTocItems(rawToc: unknown): TocItem[] {
    if (!Array.isArray(rawToc)) {
        return [];
    }

    const convertToc = (items: Array<{ label?: string; href?: string; subitems?: unknown[] }>): TocItem[] => {
        return items.map((item) => ({
            label: item.label || "",
            href: item.href || "",
            subitems: Array.isArray(item.subitems)
                ? convertToc(item.subitems as Array<{ label?: string; href?: string; subitems?: unknown[] }>)
                : undefined,
        }));
    };

    return convertToc(rawToc as Array<{ label?: string; href?: string; subitems?: unknown[] }>);
}

export function applyRendererLayoutAttributes(params: {
    renderer: { setAttribute: (name: string, val: string) => void; removeAttribute: (name: string) => void };
    flow: ReadingFlow;
    layout: PageLayout;
    zoomLevel: number;
    isFixedLayoutFormat: boolean;
    currentSettings: EffectiveReaderSettings | null | undefined;
}): void {
    const { renderer, flow, layout, zoomLevel, isFixedLayoutFormat, currentSettings } = params;

    renderer.setAttribute("flow", flow === "scroll" ? "scrolled" : "paginated");
    renderer.setAttribute("gap", "5%");

    const isMobileViewport = typeof window !== "undefined"
        && window.matchMedia("(max-width: 768px)").matches;
    const columnCount = isMobileViewport && flow !== "scroll"
        ? 1
        : layout === "single"
            ? 1
            : layout === "double"
                ? 2
                : flow === "scroll"
                    ? 1
                    : 2;

    renderer.setAttribute("max-column-count", String(columnCount));

    renderer.setAttribute(
        "max-inline-size",
        `${currentSettings?.fontSize ? Math.max(480, currentSettings.fontSize * 40) : 720}px`,
    );
    renderer.setAttribute("max-block-size", "800px");
    // The page band above and below the text. On desktop the reader toolbar
    // (45px) sits over the top of the page, so the paginator's default 48px
    // left the first line almost touching it.
    renderer.setAttribute("margin", isMobileViewport ? "48px" : "72px");
    if (currentSettings?.enableAnimations) {
        renderer.setAttribute("animated", "");
    } else {
        renderer.removeAttribute("animated");
    }

    if (isFixedLayoutFormat && flow !== "scroll") {
        const zoomValue = zoomLevel === 1.0 ? "fit-page" : zoomLevel;
        renderer.setAttribute("zoom", String(zoomValue));
    } else {
        renderer.removeAttribute("zoom");
    }
}

export function computeFoliateCssKey(
    currentSettings: EffectiveReaderSettings,
    theme: ReaderTheme,
    zoomLevel: number,
    flow: ReadingFlow,
): string {
    return [
        currentSettings.fontSize,
        currentSettings.lineHeight,
        currentSettings.fontFamily,
        currentSettings.letterSpacing,
        currentSettings.wordSpacing,
        currentSettings.textAlign,
        currentSettings.hyphenation,
        currentSettings.forcePublisherStyles ?? false,
        theme,
        zoomLevel,
        flow,
    ].join("|");
}

export function buildFoliateStyles(params: {
    currentSettings: EffectiveReaderSettings;
    themeName: ReaderTheme;
    format: BookFormat;
    flow: ReadingFlow;
    mediaActiveClass?: string;
    viewStyle?: CSSStyleDeclaration;
}): string | [string, string] {
    const { currentSettings, themeName, format, flow, mediaActiveClass, viewStyle } = params;

    const alignValue = currentSettings.textAlign === "justify"
        ? "justify"
        : currentSettings.textAlign === "center"
            ? "center"
            : "left";

    const theme = getTheme(themeName);

    const readerStyle = {
        spacing: currentSettings.lineHeight,
        lineHeight: currentSettings.lineHeight,
        justify: currentSettings.textAlign === "justify",
        hyphenate: currentSettings.hyphenation,
        invert: false,
        theme,
        overrideFont: currentSettings.forcePublisherStyles,
        // The theme forces every element's background, so the book's own
        // rule for this class can't show. getCSS styles it instead.
        mediaActiveClass,
    };

    const colors = getThemeColors(themeName);
    const isDark = themeName === "dark";
    if (viewStyle) {
        viewStyle.setProperty("--overlayer-highlight-blend-mode", isDark ? "screen" : "multiply");
        viewStyle.setProperty("--overlayer-highlight-opacity", isDark ? "0.45" : "0.35");
    }

    const fontStack = currentSettings.fontFamily === "serif"
        ? 'Georgia, "Times New Roman", serif'
        : currentSettings.fontFamily === "sans"
            ? '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
            : currentSettings.fontFamily === "mono"
                ? '"SF Mono", Monaco, "Cascadia Code", "Roboto Mono", Consolas, "Courier New", monospace'
                : "inherit";

    const fontFamilyCSS = currentSettings.fontFamily === "original" ? "" : `
        /* Font family override - applies to ALL elements with !important */
        html, body,
        p, div, span,
        h1, h2, h3, h4, h5, h6,
        li, ul, ol,
        blockquote, q,
        td, th, tr, table,
        dd, dt, dl,
        pre, code, samp, kbd,
        em, strong, b, i, u,
        small, sub, sup,
        label, figcaption,
        a, abbr, cite,
        input, textarea, button,
        ::before, ::after {
            font-family: ${fontStack} !important;
        }

        /* Override inline styles that specify font-family */
        [style*="font-family"] {
            font-family: ${fontStack} !important;
        }
    `;

    const textAlignCSS = `
        /* Text alignment - comprehensive selector coverage */
        body, p, div,
        h1, h2, h3, h4, h5, h6,
        li,
        blockquote, q,
        td, th,
        dd, dt,
        figcaption {
            text-align: ${alignValue} !important;
        }

        /* Don't justify headers and captions */
        h1, h2, h3, h4, h5, h6, figcaption {
            text-align: ${currentSettings.textAlign === "justify" || currentSettings.textAlign === "left" ? "left" : currentSettings.textAlign} !important;
        }

        /* Override align attributes */
        [align="left"] { text-align: left !important; }
        [align="right"] { text-align: right !important; }
        [align="center"] { text-align: center !important; }
        [align="justify"] { text-align: justify !important; }

        /* Override inline text-align styles */
        [style*="text-align"] {
            text-align: ${alignValue} !important;
        }
    `;

    const fontSizeOverrideCSS = currentSettings.forcePublisherStyles ? "" : `
        /* Force font-size inheritance on ALL text elements to override book CSS */
        p, div, span,
        h1, h2, h3, h4, h5, h6,
        li, ul, ol,
        blockquote, q,
        td, th, tr, table,
        dd, dt, dl,
        pre, code,
        em, strong, b, i, u,
        small, sub, sup,
        label, figcaption,
        a, abbr, cite {
            font-size: inherit !important;
        }

        /* Override inline font-size styles from book.
           Exclude html and body to preserve engine-set zoom font-size. */
        :not(html):not(body)[style*="font-size"] {
            font-size: inherit !important;
        }
    `;

    const customCSS = `
        @namespace epub "http://www.idpf.org/2007/ops";

        :root {
            --reader-bg: ${colors.bg};
            --reader-fg: ${colors.fg};
            --reader-link: ${colors.link};
        }

        @media screen {
            html {
                font-size: calc(${currentSettings.fontSize}px * var(--reader-zoom, 1)) !important;
                line-height: ${currentSettings.lineHeight} !important;
                color: ${colors.fg} !important;
                background: ${colors.bg} !important;
                letter-spacing: ${currentSettings.letterSpacing}em !important;
                word-spacing: ${currentSettings.wordSpacing}em !important;
                column-count: auto !important;
            }

            body {
                font-size: inherit !important;
                line-height: inherit !important;
                color: inherit !important;
                background: ${colors.bg} !important;
                letter-spacing: inherit !important;
                word-spacing: inherit !important;
                column-count: auto !important;
                column-width: auto !important;
            }

            ${fontSizeOverrideCSS}

            ${fontFamilyCSS}

            ${textAlignCSS}

            a:any-link {
                color: ${colors.link} !important;
            }

            /* Typography elements */
            p, li, blockquote, dd {
                line-height: ${currentSettings.lineHeight} !important;
                hyphens: ${currentSettings.hyphenation ? "auto" : "none"} !important;
            }

            ::selection {
                background: color-mix(in srgb, ${colors.fg} 35%, transparent) !important;
                color: ${colors.fg} !important;
            }

            /* The overlayer draws the selection (text-only rects). */
            html.${SELECTION_OVERLAY_CLASS} ::selection {
                background: transparent !important;
            }

            /* Suppress iOS native callout menu so Theorem's toolbar
               is not obscured by the system Look Up / Copy / Share popup.
               Native selection handles and the magnifying loupe still work. */
            html, body {
                -webkit-touch-callout: none;
            }
        }
    `;

    const foliateCSS = getCSS(readerStyle);
    const comicCSS = isComicFormat(format) && flow === "scroll" ? COMIC_SCROLL_CSS : "";
    const cssResult = Array.isArray(foliateCSS)
        ? `${foliateCSS[1]}\n${customCSS}\n${comicCSS}`
        : `${foliateCSS}\n${customCSS}\n${comicCSS}`;
    // Cache the pair, not only the second sheet: re-applying just the
    // string dropped foliate's base sheet (line height, orphans/widows)
    // from every section loaded afterwards, so the same page could break
    // at a different place on the next open and a saved position came
    // back one page early.
    return Array.isArray(foliateCSS)
        ? [foliateCSS[0], cssResult]
        : cssResult;
}
