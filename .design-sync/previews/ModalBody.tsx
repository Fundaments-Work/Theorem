import { Modal, ModalHeader, ModalBody } from 'theorem';

export function Default() {
    return (
        <Modal isOpen onClose={() => {}} size="md">
            <ModalHeader title="About This Book" onClose={() => {}} />
            <ModalBody>
                <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)', margin: 0, lineHeight: 1.6 }}>
                    Scrollable content area for a modal's body — description text, settings controls, or long-form
                    content that should scroll independently of the header and footer.
                </p>
            </ModalBody>
        </Modal>
    );
}
