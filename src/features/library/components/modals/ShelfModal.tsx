import type { Collection } from "../../../../core/types";
import { canSetShelfParent } from "../../../../core/lib/shelf-hierarchy";
import { useState, useEffect } from "react";
import { cn } from "../../../../core/lib/utils";
import { Modal, ModalBody, ModalFooter } from "../../../../ui";

interface ShelfModalProps {
    isOpen: boolean;
    shelf?: {
        id: string;
        name: string;
        description?: string;
        parentId?: string;
    };
    onClose: () => void;
    onSave: (name: string, description: string, parentId?: string) => void;
    collections?: Collection[];
    initialParentId?: string;
}

export function ShelfModal({ isOpen, shelf, onClose, onSave, collections = [], initialParentId }: ShelfModalProps) {
    const [name, setName] = useState(shelf?.name || "");
    const [description, setDescription] = useState(shelf?.description || "");
    const [parentId, setParentId] = useState(shelf?.parentId || initialParentId || "");
    const isEditing = !!shelf;

    useEffect(() => {
        if (isOpen) {
            setParentId(shelf?.parentId || initialParentId || "");
            setName(shelf?.name || "");
            setDescription(shelf?.description || "");
        }
    }, [isOpen, shelf, initialParentId]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (name.trim()) {
            onSave(name.trim(), description.trim(), parentId || undefined);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (name.trim()) {
                onSave(name.trim(), description.trim(), parentId || undefined);
            }
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="md" showCloseButton={true}>
            <form onSubmit={handleSubmit}>
                <ModalBody>
                    <div className="space-y-4">
                        <div>
                            <label htmlFor="shelf-parent" className="block text-sm font-medium mb-1.5">Parent shelf</label>
                            <select id="shelf-parent" className="ui-input" value={parentId} onChange={e => setParentId(e.target.value)}>
                                <option value="">None (top-level shelf)</option>
                                {collections.filter(c => canSetShelfParent(collections, shelf?.id || "", c.id)).map(c => (
                                    <option key={c.id} value={c.id}>{c.name}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label htmlFor="shelf-name" className="block text-sm font-medium text-[color:var(--color-text-primary)] mb-1.5">
                                Name
                            </label>
                            <input
                                id="shelf-name"
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="e.g., To Read, Favorites, Sci-Fi"
                                className="ui-input"
                                autoFocus
                            />
                        </div>
                        <div>
                            <label htmlFor="shelf-description" className="block text-sm font-medium text-[color:var(--color-text-primary)] mb-1.5">
                                Description <span className="text-[color:var(--color-text-muted)] font-normal">(optional)</span>
                            </label>
                            <textarea
                                id="shelf-description"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                placeholder="Add a description for this shelf..."
                                className={cn(
                                    "ui-input",
                                    "resize-none min-h-[calc(var(--control-height-md)_*_2.1)]"
                                )}
                                rows={3}
                            />
                        </div>
                    </div>
                </ModalBody>
                <ModalFooter>
                    <button
                        type="button"
                        onClick={onClose}
                        className="ui-btn-ghost"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={!name.trim()}
                        className={cn(
                            "ui-btn-primary",
                            "disabled:opacity-50 disabled:cursor-not-allowed"
                        )}
                    >
                        {isEditing ? "Save Changes" : "Create Shelf"}
                    </button>
                </ModalFooter>
            </form>
        </Modal>
    );
}
