
import { X, Info, Calendar, Hash, Globe, FileText, User, Cpu, Layers, Maximize2, Paperclip, Download } from 'lucide-react';
import type { DocMetadata } from '../../../core/types';
import { Backdrop, FloatingPanel } from '../../../ui';
import { cn, normalizeAuthor } from '../../../core/lib/utils';
import { formatAttachmentSize } from '../engines/pdf-attachments';

interface BookInfoPopoverProps {
    metadata: DocMetadata | null;
    visible: boolean;
    onClose: () => void;
    /** Save one of `metadata.attachments` (PDF embedded files). */
    onSaveAttachment?: (key: string) => void;
    className?: string;
}

const METADATA_SECTIONS = [
    { key: 'author', label: 'Author', icon: User },
    { key: 'pubdate', label: 'Published', icon: Calendar },
    { key: 'publisher', label: 'Publisher', icon: FileText },
    { key: 'language', label: 'Language', icon: Globe },
    { key: 'identifier', label: 'Identifier', icon: Hash },
    { key: 'creator', label: 'Application', icon: Cpu },
    { key: 'producer', label: 'PDF Producer', icon: FileText },
    { key: 'pdfVersion', label: 'PDF Version', icon: Layers },
    { key: 'pageSize', label: 'Page Dimensions', icon: Maximize2 },
] as const;

export function BookInfoPopover({
    metadata,
    visible,
    onClose,
    onSaveAttachment,
    className,
}: BookInfoPopoverProps) {
    if (!metadata) return null;

    const sections = METADATA_SECTIONS
        .map(({ key, label, icon: Icon }) => ({
            label,
            value: metadata[key],
            Icon,
        }))
        .filter(s => s.value);

    return (
        <>
            <Backdrop visible={visible} onClick={onClose} />

            <FloatingPanel visible={visible} className={cn("overflow-hidden", className)}>
                
                <div className="reader-panel-header flex items-center justify-between p-4 sm:p-5">
                    <div className="flex items-center gap-2.5">
                        <div className="border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-1.5 text-[color:var(--color-accent)]">
                            <Info className="w-4 h-4" />
                        </div>
                        <h2 className="text-sm font-semibold text-[color:var(--color-text-primary)]">Book Information</h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="inline-flex h-9 w-9 items-center justify-center border border-[var(--color-border)] text-[color:var(--color-text-secondary)] transition-colors duration-200 ease-out hover:bg-[var(--color-surface-muted)] hover:text-[color:var(--color-text-primary)]"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="p-5 sm:p-6 space-y-6 flex-1 min-h-0 overflow-y-auto custom-scrollbar [content-visibility:auto] overscroll-contain">
                    
                    <div className="flex gap-4">
                        {metadata.cover ? (
                            <img
                                src={metadata.cover}
                                alt={metadata.title}
                                className="w-20 aspect-[2/3] object-cover border border-[var(--color-border)]"
                            />
                        ) : (
                            <div className="w-20 aspect-[2/3] border border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[color:var(--color-text-muted)] flex items-center justify-center">
                                <FileText className="w-6 h-6" />
                            </div>
                        )}
                        <div className="flex-1 overflow-hidden">
                            <h3 className="text-sm font-bold text-[color:var(--color-text-primary)] line-clamp-2 mb-1">
                                {metadata.title}
                            </h3>
                            <p className="text-xs text-[color:var(--color-text-secondary)] line-clamp-1">
                                {normalizeAuthor(metadata.author) || "Unknown Author"}
                            </p>
                        </div>
                    </div>

                    <div className="space-y-4">
                        {sections.map(({ label, value, Icon }, idx) => (
                            <div key={idx} className="flex flex-col gap-1.5">
                                <span className="text-[var(--font-size-3xs)] font-bold text-[color:var(--color-text-muted)] uppercase tracking-wider flex items-center gap-1.5">
                                    <Icon className="w-4 h-4" />
                                    {label}
                                </span>
                                <span className="text-xs text-[color:var(--color-text-primary)] font-medium leading-relaxed">
                                    {value}
                                </span>
                            </div>
                        ))}
                    </div>

                    {metadata.attachments && metadata.attachments.length > 0 && (
                        <div className="space-y-2 pt-2 border-t border-[var(--color-border-subtle)]">
                            <span className="text-[var(--font-size-3xs)] font-bold text-[color:var(--color-text-muted)] uppercase tracking-wider flex items-center gap-1.5">
                                <Paperclip className="w-4 h-4" />
                                Attachments ({metadata.attachments.length})
                            </span>
                            <ul className="space-y-1">
                                {metadata.attachments.map((file) => (
                                    <li key={file.key} className="flex items-center gap-2">
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs text-[color:var(--color-text-primary)] font-medium truncate" title={file.name}>{file.name}</p>
                                            <p className="text-[var(--font-size-3xs)] text-[color:var(--color-text-muted)] truncate">
                                                {[file.size !== undefined ? formatAttachmentSize(file.size) : "", file.description ?? ""].filter(Boolean).join(" · ")}
                                            </p>
                                        </div>
                                        {onSaveAttachment && (
                                            <button
                                                type="button"
                                                onClick={() => onSaveAttachment(file.key)}
                                                aria-label={`Save ${file.name}`}
                                                title="Save"
                                                className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-[var(--color-border)] text-[color:var(--color-text-secondary)] transition-colors duration-200 ease-out hover:bg-[var(--color-surface-muted)] hover:text-[color:var(--color-text-primary)]"
                                            >
                                                <Download className="w-4 h-4" />
                                            </button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {metadata.description && (
                        <div className="space-y-2 pt-2 border-t border-[var(--color-border-subtle)]">
                            <span className="text-[var(--font-size-3xs)] font-bold text-[color:var(--color-text-muted)] uppercase tracking-wider">
                                Description
                            </span>
                            <p className="text-xs text-[color:var(--color-text-secondary)] leading-relaxed italic line-clamp-[8]">
                                {metadata.description}
                            </p>
                        </div>
                    )}
                </div>
            </FloatingPanel>
        </>
    );
}


