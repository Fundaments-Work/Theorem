import { Modal, ModalHeader } from 'theorem';

// ModalHeader renders Radix Dialog.Title/Dialog.Close, which throw outside
// a Dialog.Root — composed inside its real parent, per NOTES.md.
export function Default() {
    return (
        <Modal isOpen onClose={() => {}} size="md">
            <ModalHeader title="Reading Settings" onClose={() => {}} />
        </Modal>
    );
}

export function WithoutCloseButton() {
    return (
        <Modal isOpen onClose={() => {}} size="md">
            <ModalHeader title="Book Details" showCloseButton={false} />
        </Modal>
    );
}
