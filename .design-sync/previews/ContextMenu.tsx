import { ContextMenu } from 'theorem';

// The open menu is triggered by a real contextmenu (right-click) pointer
// event that Radix handles internally — it can't be forced open through
// props, so this story shows the trigger surface only. See
// .design-sync/NOTES.md ("Known render-time quirks").
export function Default() {
    return (
        <ContextMenu
            items={[
                { id: 'copy', label: 'Copy', shortcut: '⌘C' },
                { id: 'highlight', label: 'Highlight', shortcut: '⌘H' },
                { id: 'sep', label: '', separator: true },
                { id: 'delete', label: 'Delete', danger: true },
            ]}
        >
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 260,
                    height: 120,
                    border: '1px dashed var(--color-border)',
                    color: 'var(--color-text-muted)',
                    fontSize: '0.8125rem',
                }}
            >
                Right-click this area
            </div>
        </ContextMenu>
    );
}
