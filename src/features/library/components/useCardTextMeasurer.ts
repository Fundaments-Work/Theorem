import { useEffect, useMemo, useState } from "react";
import type { CardTextMeasurer } from "./annotation-card-layout";

const FALLBACK_LIST_WIDTH = 720;
const QUOTE_FONT_PX = 17;
const NOTE_FONT_PX = 16;

function createMeasure(font: string, fontPx: number): (text: string) => number {
    const cache = new Map<string, number>();
    let ctx: CanvasRenderingContext2D | null = null;
    try {
        ctx = document.createElement("canvas").getContext("2d");
        if (ctx) ctx.font = font;
    } catch {
        ctx = null;
    }
    // No canvas (tests, locked-down webviews): average serif glyph width.
    const approx = (text: string) => text.length * fontPx * 0.5;
    return (text: string) => {
        const cached = cache.get(text);
        if (cached !== undefined) return cached;
        const width = ctx ? ctx.measureText(text).width : approx(text);
        if (cache.size > 50_000) cache.clear();
        cache.set(text, width);
        return width;
    };
}

/**
 * Text metrics for list cards. Observes only the list container (one element,
 * not each row) for its width, and reads the serif font once. Re-measures when
 * web fonts finish loading, since fallback-font widths differ.
 */
export function useCardTextMeasurer(): { listRef: (el: HTMLDivElement | null) => void; measurer: CardTextMeasurer } {
    const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
    const [listWidth, setListWidth] = useState(0);
    const [fontFamily, setFontFamily] = useState("serif");
    const [fontsVersion, setFontsVersion] = useState(0);

    useEffect(() => {
        if (!listEl) return;
        const probe = document.createElement("span");
        probe.className = "font-serif";
        listEl.appendChild(probe);
        setFontFamily(getComputedStyle(probe).fontFamily || "serif");
        probe.remove();

        const update = () => setListWidth(Math.round(listEl.clientWidth));
        update();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(update);
        observer.observe(listEl);
        return () => observer.disconnect();
    }, [listEl]);

    useEffect(() => {
        let cancelled = false;
        document.fonts?.ready.then(() => {
            if (!cancelled) setFontsVersion((v) => v + 1);
        }).catch(() => {});
        return () => {
            cancelled = true;
        };
    }, []);

    const measurer = useMemo<CardTextMeasurer>(() => ({
        listWidth: listWidth > 0 ? listWidth : FALLBACK_LIST_WIDTH,
        measureQuote: createMeasure(`${QUOTE_FONT_PX}px ${fontFamily}`, QUOTE_FONT_PX),
        measureNote: createMeasure(`${NOTE_FONT_PX}px ${fontFamily}`, NOTE_FONT_PX),
    // fontsVersion: rebuild the width caches once web fonts are in.
    }), [listWidth, fontFamily, fontsVersion]);

    return { listRef: setListEl, measurer };
}
