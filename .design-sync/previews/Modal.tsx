import { Modal, ModalHeader, ModalBody, ModalFooter } from 'theorem';

export function Default() {
    return (
        <Modal isOpen onClose={() => {}} size="md">
            <ModalHeader title="Reading Settings" onClose={() => {}} />
            <ModalBody>
                <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)', margin: 0 }}>
                    Adjust font, theme, and layout for the current book.
                </p>
            </ModalBody>
            <ModalFooter>
                <button type="button" className="ui-btn-ghost">Cancel</button>
                <button type="button" className="ui-btn-primary">Save</button>
            </ModalFooter>
        </Modal>
    );
}

export function Large() {
    return (
        <Modal isOpen onClose={() => {}} size="lg">
            <ModalHeader title="Export Highlights" onClose={() => {}} />
            <ModalBody>
                <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)', margin: 0 }}>
                    Export every highlight and note from this book as Markdown, ready to drop into your Obsidian or Logseq vault.
                </p>
            </ModalBody>
            <ModalFooter>
                <button type="button" className="ui-btn-ghost">Cancel</button>
                <button type="button" className="ui-btn-primary">Export</button>
            </ModalFooter>
        </Modal>
    );
}

export function Small() {
    return (
        <Modal isOpen onClose={() => {}} size="sm" showCloseButton={false}>
            <ModalBody>
                <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)', margin: 0 }}>
                    A minimal modal with no header — content only.
                </p>
            </ModalBody>
        </Modal>
    );
}
