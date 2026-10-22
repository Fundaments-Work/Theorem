import { Modal, ModalBody, ModalFooter, ModalHeader } from "../../ui";

export interface PairingRequest {
    requestId: string;
    deviceName: string;
    code: string;
}

/**
 * Shown on the device whose QR code was scanned. The other device shows the
 * same six digits; accepting pairs them, anything else (Decline, closing,
 * or waiting it out) refuses.
 */
export function PairingRequestDialog({
    request,
    onAnswer,
}: {
    request: PairingRequest | null;
    onAnswer: (accept: boolean) => void;
}) {
    return (
        <Modal isOpen={!!request} onClose={() => onAnswer(false)} size="sm">
            <ModalHeader title="Pair this device?" onClose={() => onAnswer(false)} />
            <ModalBody className="space-y-4">
                <p className="text-sm leading-relaxed text-[color:var(--color-text-secondary)]">
                    <span className="text-[color:var(--color-text-primary)]">
                        {request?.deviceName || "A device"}
                    </span>{" "}
                    scanned your pairing code. Accept only if it shows the same number:
                </p>
                <p
                    data-pairing-code
                    className="text-center font-mono text-3xl tracking-[0.3em] text-[color:var(--color-text-primary)]"
                >
                    {request?.code}
                </p>
                <p className="text-xs text-[color:var(--color-text-muted)]">
                    A paired device can read and change your library, notes and settings.
                </p>
            </ModalBody>
            <ModalFooter>
                <button type="button" onClick={() => onAnswer(false)} className="ui-btn-ghost">
                    Decline
                </button>
                <button type="button" onClick={() => onAnswer(true)} className="ui-btn-primary">
                    Accept
                </button>
            </ModalFooter>
        </Modal>
    );
}
