/**
 * Progressive rendering while the view moves fast: pages entering the view
 * during a fling or scrollbar drag render at a low pixel ratio (a fraction of
 * the pixels, so they appear instead of staying white), and are re-rendered
 * sharp once the interaction settles (never downgraded).
 */

/** Scroll speed, in viewport heights per second, that counts as fast. */
export const FAST_SCROLL_VIEWPORTS_PER_SECOND = 1.5;

/** Pixel ratio for renders during a fast interaction. */
export function interactionPixelRatio(isAndroid: boolean): number {
    return isAndroid ? 0.5 : 0.6;
}

/** True when `deltaPx` scrolled in `elapsedMs` is a fast scroll for this viewport. */
export function isFastScroll(deltaPx: number, elapsedMs: number, viewportPx: number): boolean {
    if (!(elapsedMs > 0) || !(viewportPx > 0)) return false;
    const viewportsPerSecond = (Math.abs(deltaPx) / viewportPx) * (1000 / elapsedMs);
    return viewportsPerSecond >= FAST_SCROLL_VIEWPORTS_PER_SECOND;
}
