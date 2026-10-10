import { useState } from "react";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "../../../../ui";

export function FolderImportModal({ isOpen, onClose, onContinue }: {
    isOpen: boolean;
    onClose: () => void;
    onContinue: (preserve: boolean) => void;
}) {
    const [preserve, setPreserve] = useState(true);
    return (
        <Modal isOpen={isOpen} onClose={onClose}>
            <ModalHeader title="Import a folder" onClose={onClose} />
            <ModalBody>
                <fieldset className="space-y-4">
                    <legend className="mb-4 text-sm">How should imported books be organized?</legend>
                    <label className="flex cursor-pointer items-start gap-3">
                        <input type="radio" name="folder-import-mode" checked={preserve}
                            onChange={() => setPreserve(true)} className="mt-1" />
                        <span><strong className="block">Preserve folder structure</strong>
                            <span className="text-sm text-[color:var(--color-text-secondary)]">Browse books by their original folders and subfolders. Shelves stay separate.</span>
                        </span>
                    </label>
                    <label className="flex cursor-pointer items-start gap-3">
                        <input type="radio" name="folder-import-mode" checked={!preserve}
                            onChange={() => setPreserve(false)} className="mt-1" />
                        <span><strong className="block">Import as a flat library</strong>
                            <span className="text-sm text-[color:var(--color-text-secondary)]">Add all discovered books together without adding folder organization.</span>
                        </span>
                    </label>
                    <p className="text-sm text-[color:var(--color-text-secondary)]">Both options include subfolders. Your original files stay in place.</p>
                </fieldset>
            </ModalBody>
            <ModalFooter>
                <button className="ui-btn-ghost" onClick={onClose}>Cancel</button>
                <button className="ui-btn-primary" onClick={() => onContinue(preserve)}>Choose folder</button>
            </ModalFooter>
        </Modal>
    );
}
