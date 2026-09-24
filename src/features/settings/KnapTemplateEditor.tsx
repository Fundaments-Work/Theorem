import { useState, useEffect, useRef } from "react";
import {
    DEFAULT_KNAP_TEMPLATE,
    validateKnapTemplate,
    renderKnapBookPage,
    type KnapBookData,
} from "../../core/lib/knap-templates";
import { useLibraryStore } from "../../core/store";
import { RotateCcw, Eye, EyeOff, AlertCircle, CheckCircle2 } from "lucide-react";

interface KnapTemplateEditorProps {
    template: string;
    onChange: (value: string) => void;
}

const CANONICAL_SAMPLE: KnapBookData = {
    id: "sample-1",
    title: "Dune",
    author: "Frank Herbert",
    format: "epub",
    filePath: "/books/dune.epub",
    highlights: [
        {
            id: "h1",
            text: "I must not fear. Fear is the mind-killer.",
            note: "The classic litany against fear.",
            color: "yellow",
            createdAt: "2026-09-24T10:00:00Z",
            chapterTitle: "Chapter 1",
        },
        {
            id: "h2",
            text: "A beginning is the time for taking the most delicate care that the balances are correct.",
            note: null,
            color: "blue",
            createdAt: "2026-09-24T10:15:00Z",
            chapterTitle: "Chapter 1",
        },
    ],
    totalHighlights: 2,
    syncDate: "2026-09-24",
    tags: ["reading/highlights", "theorem"],
};

const INSERT_VARIABLES = [
    { label: "Title", token: "{{ title }}" },
    { label: "Author Wikilink", token: "{{ author | wikilink }}" },
    { label: "Format", token: "{{ format }}" },
    { label: "Count", token: "{{ highlights | length }}" },
    { label: "Quote", token: "> {{ item.text | highlight }}" },
    { label: "Note", token: "{{ item.note }}" },
    { label: "Chapter", token: "{{ item.chapterTitle }}" },
    { label: "Callout", token: "{{ item.text | callout: 'quote' }}" },
];

export function KnapTemplateEditor({ template, onChange }: KnapTemplateEditorProps) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [showPreview, setShowPreview] = useState(true);
    const [previewContent, setPreviewContent] = useState("");
    const [previewErrors, setPreviewErrors] = useState<string[]>([]);

    const books = useLibraryStore((s) => s.books);
    const annotations = useLibraryStore((s) => s.annotations);

    // Pick first real book with annotations if available, otherwise canonical sample
    const sampleData: KnapBookData = (() => {
        for (const book of books) {
            const bookAnnos = annotations.filter((a) => a.bookId === book.id && a.selectedText);
            if (bookAnnos.length > 0) {
                return {
                    id: book.id,
                    title: book.title,
                    author: book.author,
                    format: book.format,
                    filePath: book.filePath,
                    highlights: bookAnnos.slice(0, 3).map((a) => ({
                        id: a.id,
                        text: a.selectedText?.trim() || "",
                        note: a.noteContent?.trim() || null,
                        color: a.color,
                        createdAt: a.createdAt ? new Date(a.createdAt).toISOString() : undefined,
                    })),
                    totalHighlights: bookAnnos.length,
                    syncDate: new Date().toISOString().split("T")[0],
                    tags: ["reading/highlights", "theorem"],
                };
            }
        }
        return CANONICAL_SAMPLE;
    })();

    const validation = validateKnapTemplate(template);

    useEffect(() => {
        let isMounted = true;
        void renderKnapBookPage(template || DEFAULT_KNAP_TEMPLATE, sampleData).then((res) => {
            if (isMounted) {
                setPreviewContent(res.output);
                setPreviewErrors(res.errors);
            }
        });
        return () => {
            isMounted = false;
        };
    }, [template, sampleData]);

    const handleInsertToken = (token: string) => {
        const textarea = textareaRef.current;
        if (!textarea) {
            onChange(`${template} ${token}`);
            return;
        }

        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const before = template.substring(0, start);
        const after = template.substring(end);
        const newText = before + token + after;
        onChange(newText);

        setTimeout(() => {
            textarea.focus();
            const newPos = start + token.length;
            textarea.setSelectionRange(newPos, newPos);
        }, 0);
    };

    const handleReset = () => {
        onChange(DEFAULT_KNAP_TEMPLATE);
    };

    return (
        <div className="mt-3 space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-elevated)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] pb-2">
                <span className="text-xs font-semibold text-[color:var(--color-text-primary)]">
                    Knap Markdown Template (Sandboxed AST)
                </span>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={handleReset}
                        className="inline-flex items-center gap-1 text-[11px] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)]"
                    >
                        <RotateCcw className="h-3 w-3" />
                        Reset
                    </button>
                    <button
                        type="button"
                        onClick={() => setShowPreview(!showPreview)}
                        className="inline-flex items-center gap-1 text-[11px] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)]"
                    >
                        {showPreview ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                        {showPreview ? "Hide preview" : "Show preview"}
                    </button>
                </div>
            </div>

            {/* Quick insert tokens */}
            <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-text-muted)]">
                    Insert:
                </span>
                {INSERT_VARIABLES.map(({ label, token }) => (
                    <button
                        key={token}
                        type="button"
                        onClick={() => handleInsertToken(token)}
                        className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[color:var(--color-text-primary)]"
                        title={`Insert ${token}`}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {/* Editor Textarea */}
            <div className="relative">
                <textarea
                    ref={textareaRef}
                    value={template}
                    onChange={(e) => onChange(e.target.value)}
                    rows={10}
                    spellCheck={false}
                    className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-2.5 font-mono text-xs leading-relaxed text-[color:var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
                    placeholder="Enter Knap markdown template..."
                />
            </div>

            {/* Syntax validation feedback */}
            {!validation.valid ? (
                <div className="rounded border border-red-500/20 bg-red-500/10 p-2 text-xs text-red-500">
                    <div className="flex items-center gap-1.5 font-medium">
                        <AlertCircle className="h-3.5 w-3.5" />
                        Template Syntax Errors:
                    </div>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 font-mono text-[11px]">
                        {validation.errors.map((err, i) => (
                            <li key={i}>{err}</li>
                        ))}
                    </ul>
                </div>
            ) : (
                <div className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Valid Knap template syntax
                </div>
            )}

            {/* Live Preview */}
            {showPreview && (
                <div className="mt-2 space-y-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5">
                    <div className="flex items-center justify-between text-[11px] font-medium text-[color:var(--color-text-muted)]">
                        <span>Live Preview ({sampleData.title})</span>
                        {previewErrors.length > 0 && (
                            <span className="text-red-500">Render warnings present</span>
                        )}
                    </div>
                    <pre className="max-h-48 overflow-x-auto overflow-y-auto whitespace-pre-wrap rounded bg-[var(--color-surface-muted)] p-2 font-mono text-[11px] leading-relaxed text-[color:var(--color-text-primary)]">
                        {previewContent || "_No output generated_"}
                    </pre>
                </div>
            )}
        </div>
    );
}
