import { Modal, ModalHeader, ModalBody } from "./Modal";
import { getAllShortcuts, formatShortcutKeys } from "../core/lib/keyboard-shortcuts";
import type { KeyboardShortcut } from "../core/lib/keyboard-shortcuts";
import { useMemo } from "react";

interface KeyboardShortcutsHelpProps {
    isOpen: boolean;
    onClose: () => void;
}

export function KeyboardShortcutsHelp({ isOpen, onClose }: KeyboardShortcutsHelpProps) {
    const groupedShortcuts = useMemo(() => {
        const all = getAllShortcuts();
        const groups = new Map<string, KeyboardShortcut[]>();

        for (const s of all) {
            const existing = groups.get(s.category) ?? [];
            existing.push(s);
            groups.set(s.category, existing);
        }

        return Array.from(groups.entries());
    }, []);

    if (groupedShortcuts.length === 0) return null;

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="lg">
            <ModalHeader title="Keyboard Shortcuts" onClose={onClose} />
            <ModalBody>
                <div className="space-y-6">
                    {groupedShortcuts.map(([category, shortcuts]) => (
                        <div key={category}>
                            <h3 className="text-xs text-[color:var(--color-text-muted)] mb-2">
                                {category}
                            </h3>
                            <div className="divide-y divide-[var(--color-border)]">
                                {shortcuts.map((s, idx) => (
                                    <div
                                        key={idx}
                                        className="flex items-center justify-between py-2 text-sm"
                                    >
                                        <span className="text-[color:var(--color-text)]">
                                            {s.label}
                                        </span>
                                        <kbd className="px-2 py-0.5 text-xs font-mono bg-[var(--color-surface-muted)] border border-[var(--color-border)] text-[color:var(--color-text-secondary)]">
                                            {formatShortcutKeys(s.keys)}
                                        </kbd>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </ModalBody>
        </Modal>
    );
}
