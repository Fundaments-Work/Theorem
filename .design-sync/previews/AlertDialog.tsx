import { AlertDialog } from 'theorem';

export function Default() {
    return (
        <AlertDialog
            isOpen
            title="Import complete"
            message="14 books were imported into your library."
            okLabel="OK"
            onClose={() => {}}
        />
    );
}
