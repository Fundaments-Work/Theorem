
import { Modal, ModalHeader, ModalBody, ModalFooter } from "./Modal";
import { Button } from "./Button";

export interface ConfirmDialogProps {
    isOpen: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: "danger" | "warning" | "info";
    onConfirm: () => void;
    onCancel: () => void;
}

export function ConfirmDialog({
    isOpen,
    title,
    message,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    variant = "warning",
    onConfirm,
    onCancel,
}: ConfirmDialogProps) {
    return (
        <Modal isOpen={isOpen} onClose={onCancel} size="sm" showCloseButton={true}>
            <ModalHeader title={title} onClose={onCancel} showCloseButton={true} />
            <ModalBody>
                <p className="text-sm leading-relaxed text-[color:var(--color-text-secondary)]">
                    {message}
                </p>
            </ModalBody>
            <ModalFooter>
                <Button variant="ghost" onClick={onCancel}>
                    {cancelLabel}
                </Button>
                <Button variant={variant === "danger" ? "danger" : "primary"} onClick={onConfirm}>
                    {confirmLabel}
                </Button>
            </ModalFooter>
        </Modal>
    );
}

export interface AlertDialogProps {
    isOpen: boolean;
    title: string;
    message: string;
    okLabel?: string;
    onClose: () => void;
}

export function AlertDialog({
    isOpen,
    title,
    message,
    okLabel = "OK",
    onClose,
}: AlertDialogProps) {
    return (
        <Modal isOpen={isOpen} onClose={onClose} size="sm" showCloseButton={true}>
            <ModalHeader title={title} onClose={onClose} showCloseButton={true} />
            <ModalBody>
                <p className="text-sm leading-relaxed text-[color:var(--color-text-secondary)]">
                    {message}
                </p>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={onClose}>
                    {okLabel}
                </Button>
            </ModalFooter>
        </Modal>
    );
}
