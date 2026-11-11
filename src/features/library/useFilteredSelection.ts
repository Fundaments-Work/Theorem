import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUIStore } from "../../core/store";
import type { Book } from "../../core/types";

/** Selection is limited to the full filtered result, including virtualized rows. */
export function useFilteredSelection(books: Book[], scope: string, enabled: boolean, ready: boolean) {
    const storedIds = useUIStore((state) => state.selectedBooks);
    const setSelectedBooks = useUIStore((state) => state.setSelectedBooks);
    const clearSelection = useUIStore((state) => state.clearSelection);
    const [activeScope, setActiveScope] = useState<string | null>(null);
    const prevEnabledRef = useRef(enabled);
    const canSelect = enabled && ready && activeScope === scope;
    const visibleIds = useMemo(() => new Set(books.map((book) => book.id)), [books]);
    const selectedBooks = useMemo(() => canSelect
        ? storedIds.filter((id) => visibleIds.has(id)) : [], [storedIds, visibleIds, canSelect]);
    const selectedBookIds = useMemo(() => new Set(selectedBooks), [selectedBooks]);

    // Reset only when this selection controller was active or transitions from enabled -> disabled,
    // so hidden keep-alive routes never clear another route's active selection.
    useEffect(() => {
        if (enabled || prevEnabledRef.current) {
            clearSelection();
        }
        prevEnabledRef.current = enabled;
        setActiveScope(scope);
    }, [scope, enabled, ready, clearSelection]);
    useEffect(() => {
        if (canSelect && selectedBooks.length !== storedIds.length) {
            setSelectedBooks(selectedBooks);
        }
    }, [selectedBooks, storedIds.length, canSelect, setSelectedBooks]);
    useEffect(() => () => {
        if (prevEnabledRef.current) {
            clearSelection();
        }
    }, [clearSelection]);

    /** Returns false while selection is not ready yet (mode just entered, or search settling). */
    const selectAll = useCallback((): boolean => {
        if (!canSelect) return false;
        setSelectedBooks([...visibleIds]);
        return true;
    }, [canSelect, visibleIds, setSelectedBooks]);
    const toggleBookSelection = useCallback((id: string) => {
        if (!canSelect) return false;
        if (!visibleIds.has(id)) return true;
        const current = useUIStore.getState().selectedBooks.filter((value) => visibleIds.has(value));
        setSelectedBooks(current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
        return true;
    }, [canSelect, visibleIds, setSelectedBooks]);

    return { selectedBooks, selectedBookIds, selectAll, clearSelection, toggleBookSelection,
        allSelected: visibleIds.size > 0 && selectedBookIds.size === visibleIds.size };
}
