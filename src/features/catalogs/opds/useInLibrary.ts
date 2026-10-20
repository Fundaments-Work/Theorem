import { useMemo } from "react";
import { getLibraryTitleSet, normalizeLibraryTitle, useLibraryStore } from "../../../core/store";

/** `true` for a title already in the Library, using the same normalised-title match as Discover. */
export function useInLibrary(): (title: string) => boolean {
    const books = useLibraryStore((state) => state.books);
    return useMemo(() => {
        const titles = getLibraryTitleSet(books);
        return (title: string) => titles.has(normalizeLibraryTitle(title));
    }, [books]);
}
