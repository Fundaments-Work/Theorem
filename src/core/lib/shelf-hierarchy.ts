import type { Collection } from "../types";

// Shelf nesting is UI organization only; membership and rules remain independent.
export function normalizeShelfHierarchy(collections: Collection[], preserveMissingParents = false): Collection[] {
    const byId = new Map(collections.map(shelf => [shelf.id, shelf]));
    return collections.map(shelf => {
        if (!shelf.parentId) return shelf;
        const parent = byId.get(shelf.parentId);
        if (!parent && preserveMissingParents) return shelf;
        return parent && parent.id !== shelf.id && !parent.parentId
            ? shelf
            : { ...shelf, parentId: undefined };
    });
}

export function canSetShelfParent(collections: Collection[], id: string, parentId?: string): boolean {
    if (!parentId) return true;
    const parent = collections.find(shelf => shelf.id === parentId);
    return !!parent && parent.id !== id && !parent.parentId
        && !collections.some(shelf => shelf.parentId === id);
}
