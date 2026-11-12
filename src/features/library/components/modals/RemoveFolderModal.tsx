import { useEffect, useState } from "react";
import { Button, Modal, ModalBody, ModalFooter, ModalHeader } from "../../../../ui";

export interface RemoveFolderTarget {
    root: string;
    name: string;
    count: number;
}

export function RemoveFolderModal({
    folderToRemove,
    onClose,
    onConfirm,
}: {
    folderToRemove: RemoveFolderTarget | null;
    onClose: () => void;
    onConfirm: (root: string, deleteBooks: boolean) => void;
}) {
    const [deleteBooks, setDeleteBooks] = useState(false);

    useEffect(() => {
        if (folderToRemove) {
            setDeleteBooks(false);
        }
    }, [folderToRemove]);

    if (!folderToRemove) {
        return null;
    }

    return (
        <Modal isOpen={!!folderToRemove} onClose={onClose} size="sm" showCloseButton={true}>
            <ModalHeader title="Remove Folder" onClose={onClose} showCloseButton={true} />
            <ModalBody>
                <p className="text-sm leading-relaxed text-[color:var(--color-text-primary)]">
                    Remove &ldquo;{folderToRemove.name}&rdquo; from your library?
                </p>
                <p className="text-xs text-[color:var(--color-text-muted)] mt-1 truncate" title={folderToRemove.root}>
                    {folderToRemove.root}
                </p>
                <p className="text-xs text-[color:var(--color-text-muted)] mt-3">
                    Your original book files on your device will never be deleted.
                </p>
                {folderToRemove.count > 0 && (
                    <label className="flex items-center gap-2 mt-4 text-xs text-[color:var(--color-text-primary)] cursor-pointer select-none">
                        <input
                            type="checkbox"
                            checked={deleteBooks}
                            onChange={(e) => setDeleteBooks(e.target.checked)}
                            className="border-[var(--color-border)] text-[color:var(--color-accent)]"
                        />
                        <span>Also remove {folderToRemove.count} {folderToRemove.count === 1 ? "book" : "books"} from Theorem library</span>
                    </label>
                )}
            </ModalBody>
            <ModalFooter>
                <Button variant="ghost" onClick={onClose}>
                    Cancel
                </Button>
                <Button
                    variant="danger"
                    onClick={() => onConfirm(folderToRemove.root, deleteBooks)}
                >
                    Remove Folder
                </Button>
            </ModalFooter>
        </Modal>
    );
}
