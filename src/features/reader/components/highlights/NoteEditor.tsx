
import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Save } from 'lucide-react';
import { cn } from "../../../../core/lib/utils";

interface NoteEditorProps {
    isOpen: boolean;
    position: { x: number; y: number };
    initialNote: string;
    selectedText: string;
    viewportPadding?: Partial<{
        top: number;
        right: number;
        bottom: number;
        left: number;
    }>;
    onSave: (note: string) => void;
    onClose: () => void;
}

export function NoteEditor({
    isOpen,
    position,
    initialNote,
    selectedText,
    viewportPadding,
    onSave,
    onClose,
}: NoteEditorProps) {
    const [note, setNote] = useState(initialNote);
    const [adjustedPosition, setAdjustedPosition] = useState(position);
    const editorRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (!isOpen) return;

        const editor = editorRef.current;
        if (!editor) return;

        const rect = editor.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const padding = 16;
        const leftBound = Math.max(padding, viewportPadding?.left ?? padding);
        const rightBound = Math.min(viewportWidth - padding, viewportWidth - (viewportPadding?.right ?? padding));
        const topBound = Math.max(padding, viewportPadding?.top ?? padding);
        const bottomBound = Math.min(viewportHeight - padding, viewportHeight - (viewportPadding?.bottom ?? padding));

        let { x, y } = position;

        if (x + rect.width > rightBound) {
            x = rightBound - rect.width;
        }
        if (x < leftBound) {
            x = leftBound;
        }

        if (y + rect.height > bottomBound) {
            y = y - rect.height - 40;
        }
        if (y + rect.height > bottomBound) {
            y = bottomBound - rect.height;
        }
        if (y < topBound) {
            y = topBound;
        }

        setAdjustedPosition({ x, y });
    }, [isOpen, position, viewportPadding?.bottom, viewportPadding?.left, viewportPadding?.right, viewportPadding?.top]);

    useEffect(() => {
        if (isOpen && textareaRef.current) {
            textareaRef.current.focus();
            textareaRef.current.setSelectionRange(note.length, note.length);
        }
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;

        const handleClickOutside = (e: MouseEvent) => {
            if (editorRef.current && !editorRef.current.contains(e.target as Node)) {
                onClose();
            }
        };

        document.addEventListener('pointerdown', handleClickOutside, true);
        document.addEventListener('mousedown', handleClickOutside, true);
        document.addEventListener('click', handleClickOutside, true);
        
        const handleScroll = () => onClose();
        window.addEventListener('scroll', handleScroll, true);
        
        return () => {
            document.removeEventListener('pointerdown', handleClickOutside, true);
            document.removeEventListener('mousedown', handleClickOutside, true);
            document.removeEventListener('click', handleClickOutside, true);
            window.removeEventListener('scroll', handleScroll, true);
        };
    }, [isOpen, onClose]);

    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                handleSave();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose, note]);

    const handleSave = useCallback(() => {
        onSave(note.trim());
    }, [note, onSave]);

    if (!isOpen) return null;

    const editorContent = (
        <div
            ref={editorRef}
            className={cn(
                "fixed animate-fade-in",
                "bg-[var(--color-surface)]",
                "border border-[var(--color-border)]",
                
                "p-4 w-[var(--layout-note-editor-width)]"
            )}
            style={{
                left: adjustedPosition.x,
                top: adjustedPosition.y,
                zIndex: "calc(var(--z-tooltip) + 40)",
            }}
        >
            
            <div className="flex items-center justify-between mb-3">
                <span className="font-mono text-[11px] text-[color:var(--color-text-primary)]">
                    {initialNote ? 'Edit Note' : 'Add Note'}
                </span>
                <button
                    onClick={onClose}
                    className={cn(
                        "p-1",
                        "text-[color:var(--color-text-muted)]",
                        "hover:bg-[var(--color-surface-muted)]",
                        "transition-colors"
                    )}
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            {selectedText && (
                <div className="mb-3 px-2 py-1.5 bg-[var(--color-surface-muted)] text-xs text-[color:var(--color-text-secondary)] line-clamp-2">
                    &ldquo;{selectedText.slice(0, 100)}{selectedText.length > 100 ? '...' : ''}&rdquo;
                </div>
            )}

            <textarea
                ref={textareaRef}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Add your note..."
                className={cn(
                    "w-full min-h-[var(--layout-note-editor-min-height)] max-h-[var(--layout-note-editor-max-height)]",
                    "px-3 py-2 text-sm",
                    "bg-[var(--color-background)]",
                    "border border-[var(--color-border)]",
                    "resize-y",
                    "text-[color:var(--color-text-primary)]",
                    "placeholder:text-[color:var(--color-text-muted)]",
                    "focus:outline-none focus:border-[var(--color-accent)]",
                    "transition-colors"
                )}
            />

            <div className="flex items-center justify-between mt-3 pt-3 border-t border-[var(--color-border)]">
                <span className="font-mono text-[10px] text-[color:var(--color-text-muted)]">
                    Ctrl+Enter to save
                </span>
                <button
                    onClick={handleSave}
                    className={cn(
                        "flex items-center gap-1.5 border border-[var(--color-accent)]",
                        "px-3 py-1.5 font-mono text-[10px]",
                        
                        "bg-[var(--color-accent)]",
                        "text-[color:var(--color-accent-contrast)]",
                        "hover:opacity-90",
                        "transition-opacity"
                    )}
                >
                    <Save className="w-3.5 h-3.5" />
                    Save
                </button>
            </div>
        </div>
    );

    if (typeof document === "undefined") {
        return editorContent;
    }

    return createPortal(editorContent, document.body);
}

export default NoteEditor;
