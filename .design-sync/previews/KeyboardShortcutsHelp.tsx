import { KeyboardShortcutsHelp, registerShortcuts } from 'theorem';

// getAllShortcuts() reads a module-level registry populated by other app
// code via registerShortcuts() — outside the real app nothing has
// registered, so we seed it here with realistic sample data. registerShortcuts
// is reached via `theorem` (cfg.extraEntries), not a relative import, so it's
// the exact same module instance KeyboardShortcutsHelp itself reads — a
// relative import here would bundle a separate copy with its own empty
// registry. See NOTES.md.
registerShortcuts('preview-navigation', [
    { label: 'Open library', keys: 'ctrl+1', category: 'Navigation', handler: () => {} },
    { label: 'Open reader', keys: 'ctrl+2', category: 'Navigation', handler: () => {} },
    { label: 'Search', keys: 'ctrl+k', category: 'Navigation', handler: () => {} },
]);
registerShortcuts('preview-reading', [
    { label: 'Next page', keys: 'right', category: 'Reading', handler: () => {} },
    { label: 'Previous page', keys: 'left', category: 'Reading', handler: () => {} },
    { label: 'Add highlight', keys: 'ctrl+h', category: 'Reading', handler: () => {} },
    { label: 'Toggle table of contents', keys: 'ctrl+t', category: 'Reading', handler: () => {} },
]);

export function Default() {
    return <KeyboardShortcutsHelp isOpen onClose={() => {}} />;
}
