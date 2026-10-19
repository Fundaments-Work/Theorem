import { useState, useEffect } from "react";
import { cn } from "../../../../core/lib/utils";
import { Modal, ModalBody, ModalFooter } from "../../../../ui";

interface EditNoteModalProps {
    isOpen: boolean;
    content: string;
    onClose: () => void;
    onSave: (content: string) => void;
}

export function EditNoteModal({ isOpen, content, onClose, onSave }: EditNoteModalProps) {
    const [editContent, setEditContent] = useState(content);

    useEffect(() => {
        if (isOpen) {
            setEditContent(content);
        }
    }, [isOpen, content]);

    const handleSave = () => {
        onSave(editContent);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleSave();
        }
        if (e.key === "Escape") {
            onClose();
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="lg" showCloseButton={true}>
            <ModalBody>
                <h3 className="text-lg text-[color:var(--color-text-primary)] mb-4">
                    Edit Note
                </h3>
                <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    onKeyDown={handleKeyDown}
                    className={cn(
                        "ui-input",
                        "h-40 p-3 resize-none"
                    )}
                    placeholder="Add your note..."
                    autoFocus
                />
            </ModalBody>
            <ModalFooter>
                <button
                    onClick={onClose}
                    className="ui-btn-ghost"
                >
                    Cancel
                </button>
                <button
                    onClick={handleSave}
                    className="ui-btn-primary"
                >
                    Save
                </button>
            </ModalFooter>
        </Modal>
    );
}
