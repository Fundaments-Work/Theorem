import { useEffect, useState } from "react";

/**
 * Reactive CSS media query.
 *
 * Returns false during SSR / when `matchMedia` is unavailable, so the first
 * render matches the desktop (wider) layout and the effect corrects it on the
 * client. Re-evaluates on resize and orientation change.
 */
export function useMediaQuery(query: string): boolean {
    const [matches, setMatches] = useState(() => (
        typeof window !== "undefined" && typeof window.matchMedia === "function"
            ? window.matchMedia(query).matches
            : false
    ));

    useEffect(() => {
        if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
            return;
        }
        const list = window.matchMedia(query);
        const onChange = () => setMatches(list.matches);
        onChange();
        list.addEventListener("change", onChange);
        return () => list.removeEventListener("change", onChange);
    }, [query]);

    return matches;
}