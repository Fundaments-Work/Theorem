
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "../core/lib/utils";
import { useAndroidBackButton } from "../core/lib/env";

/** Lets a `ModalHeader` tell its `Modal` that the dialog already has a visible title to be named by. */
const ModalHeaderContext = createContext<((present: boolean) => void) | null>(null);

export interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    children: React.ReactNode;
    className?: string;
    size?: "sm" | "md" | "lg" | "xl" | "fullscreen";
    showCloseButton?: boolean;
    ariaLabelledby?: string;
    /** Name for a dialog that has no `ModalHeader`. */
    ariaLabel?: string;
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
    ariaLabel,
}: ModalProps) {
    // The dialog is named by its visible `ModalHeader` title (Radix wires them together). A dialog
    // without one gets an off-screen title so it is never announced as an unnamed "dialog".
    const [hasHeader, setHasHeader] = useState(false);

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
                    // Only override Radix's own wiring when a caller names a specific element.
                    {...(ariaLabelledby ? { "aria-labelledby": ariaLabelledby } : {})}
                    className={cn(
                        "fixed left-1/2 top-1/2 z-[calc(var(--z-modal)+1)] -translate-x-1/2 -translate-y-1/2",
                        // On a phone the dialog keeps the page's 16px gutter on each side instead of touching the
                        // screen edges; from the tablet width up the max-width takes over.
                        "flex w-[calc(100%-2rem)] max-h-[var(--layout-modal-max-height)] max-w-[var(--layout-modal-width-md)] flex-col overflow-hidden",
                        "border border-[var(--color-border)] bg-[var(--color-surface)]",
                        "outline-none",
                        sizeClasses[size],
                        className,
                    )}
                >
                    {!hasHeader && !ariaLabelledby && <Dialog.Title className="sr-only">{ariaLabel ?? "Dialog"}</Dialog.Title>}
                    <Dialog.Description className="sr-only" />
                    <ModalHeaderContext.Provider value={setHasHeader}>{children}</ModalHeaderContext.Provider>
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
    const setHasHeader = useContext(ModalHeaderContext);
    useEffect(() => {
        setHasHeader?.(true);
        return () => setHasHeader?.(false);
    }, [setHasHeader]);
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
