import { ConfirmDialog } from 'theorem';

export function Warning() {
    return (
        <ConfirmDialog
            isOpen
            title="Delete highlight?"
            message="This will remove the highlight and its note. This can't be undone."
            confirmLabel="Delete"
            cancelLabel="Cancel"
            variant="warning"
            onConfirm={() => {}}
            onCancel={() => {}}
        />
    );
}

export function Danger() {
    return (
        <ConfirmDialog
            isOpen
            title="Remove book from library?"
            message="Your reading progress and annotations for this book will be permanently deleted."
            confirmLabel="Remove"
            cancelLabel="Keep book"
            variant="danger"
            onConfirm={() => {}}
            onCancel={() => {}}
        />
    );
}

export function Info() {
    return (
        <ConfirmDialog
            isOpen
            title="Enable cloud sync?"
            message="Your library and highlights will sync across devices using your Obsidian vault."
            confirmLabel="Enable"
            cancelLabel="Not now"
            variant="info"
            onConfirm={() => {}}
            onCancel={() => {}}
        />
    );
}
