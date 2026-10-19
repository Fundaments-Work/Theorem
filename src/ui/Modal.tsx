
import { useCallback, useId } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "../core/lib/utils";
import { useAndroidBackButton } from "../core/lib/env";

export interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    children: React.ReactNode;
    className?: string;
    size?: "sm" | "md" | "lg" | "xl" | "fullscreen";
    showCloseButton?: boolean;
    ariaLabelledby?: string;
}

const sizeClasses: Record<string, string> = {
    sm: "max-w-[var(--layout-modal-width-sm)]",
    md: "",
    lg: "max-w-[var(--layout-modal-width-lg)]",
    xl: "max-w-[var(--layout-modal-width-xl)]",
    fullscreen: "h-screen max-h-none w-screen max-w-none border-0",
};

export function Modal({
    isOpen,
    onClose,
    children,
    className,
    size = "md",
    ariaLabelledby,
}: ModalProps) {
    const autoHeaderId = useId();
    const headerId = ariaLabelledby || autoHeaderId;

    useAndroidBackButton(
        useCallback(() => {
            if (isOpen) {
                onClose();
                return true;
            }
            return false;
        }, [isOpen, onClose])
    );

    return (
        <Dialog.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-[var(--z-modal)] bg-[var(--color-overlay-strong)]" />
                <Dialog.Content
                    aria-labelledby={headerId}
                    className={cn(
                        "fixed left-1/2 top-1/2 z-[calc(var(--z-modal)+1)] -translate-x-1/2 -translate-y-1/2",
                        "flex w-full max-h-[var(--layout-modal-max-height)] max-w-[var(--layout-modal-width-md)] flex-col overflow-hidden",
                        "border border-[var(--color-border)] bg-[var(--color-surface)]",
                        "outline-none",
                        sizeClasses[size],
                        className,
                    )}
                >
                    <Dialog.Title id={headerId} className="sr-only" />
                    <Dialog.Description className="sr-only" />
                    {children}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

interface ModalHeaderProps {
    title: string;
    onClose?: () => void;
    showCloseButton?: boolean;
}

export function ModalHeader({ title, onClose, showCloseButton = true }: ModalHeaderProps) {
    return (
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
            <Dialog.Title className="text-base text-[color:var(--color-text-primary)]">
                {title}
            </Dialog.Title>
            {showCloseButton && onClose && (
                <Dialog.Close asChild>
                    <button
                        className="inline-flex h-9 w-9 items-center justify-center text-[color:var(--color-text-secondary)] transition-colors duration-200 ease-out hover:text-[color:var(--color-accent)]"
                        aria-label="Close"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </Dialog.Close>
            )}
        </div>
    );
}

export function ModalBody({ children, className }: { children: React.ReactNode; className?: string }) {
    return <div className={cn("flex-1 overflow-y-auto px-5 py-5", className)}>{children}</div>;
}

interface ModalFooterProps {
    children: React.ReactNode;
    className?: string;
}

export function ModalFooter({ children, className }: ModalFooterProps) {
    return (
        <div className={cn("relative flex shrink-0 items-center justify-end gap-2 border-t border-[var(--color-border)] px-5 py-4", className)}>
            {children}
        </div>
    );
}
