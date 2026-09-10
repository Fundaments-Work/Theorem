import { Modal, ModalFooter } from 'theorem';

export function Default() {
    return (
        <Modal isOpen onClose={() => {}} size="md" showCloseButton={false}>
            <ModalFooter>
                <button type="button" className="ui-btn-ghost">Cancel</button>
                <button type="button" className="ui-btn-primary">Save</button>
            </ModalFooter>
        </Modal>
    );
}
