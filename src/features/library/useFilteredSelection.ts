import { useCallback, useEffect, useMemo, useState } from "react";
import { useUIStore } from "../../core/store";
import type { Book } from "../../core/types";

/** Selection is limited to the full filtered result, including virtualized rows. */
export function useFilteredSelection(books: Book[], scope: string, enabled: boolean, ready: boolean) {
    const storedIds = useUIStore((state) => state.selectedBooks);
    const setSelectedBooks = useUIStore((state) => state.setSelectedBooks);
    const clearSelection = useUIStore((state) => state.clearSelection);
    const [activeScope, setActiveScope] = useState<string | null>(null);
    const canSelect = enabled && ready && activeScope === scope;
    const visibleIds = useMemo(() => new Set(books.map((book) => book.id)), [books]);
    const selectedBooks = useMemo(() => canSelect
        ? storedIds.filter((id) => visibleIds.has(id)) : [], [storedIds, visibleIds, canSelect]);
    const selectedBookIds = useMemo(() => new Set(selectedBooks), [selectedBooks]);

    // Reset when the user changes the view, enters/exits selection, or searches.
    useEffect(() => { clearSelection(); setActiveScope(scope); }, [scope, enabled, ready, clearSelection]);
    useEffect(() => {
        if (canSelect && selectedBooks.length !== storedIds.length) {
            setSelectedBooks(selectedBooks);
        }
    }, [selectedBooks, storedIds.length, canSelect, setSelectedBooks]);
    useEffect(() => () => clearSelection(), [clearSelection]);

    const selectAll = useCallback(() => {
        if (canSelect) setSelectedBooks([...visibleIds]);
    }, [canSelect, visibleIds, setSelectedBooks]);
    const toggleBookSelection = useCallback((id: string) => {
        if (!canSelect || !visibleIds.has(id)) return;
        const current = useUIStore.getState().selectedBooks.filter((value) => visibleIds.has(value));
        setSelectedBooks(current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
    }, [canSelect, visibleIds, setSelectedBooks]);

    return { selectedBooks, selectedBookIds, selectAll, clearSelection, toggleBookSelection,
        allSelected: visibleIds.size > 0 && selectedBookIds.size === visibleIds.size };
}
