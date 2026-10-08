import { Bookmark, Calendar, ExternalLink, Globe, User, X } from "lucide-react";
import { cn } from "../../../core/lib/utils";
import { openExternalUrl } from "../../../core/lib/open-external-url";
import type { RssArticle } from "../../../core/types";
import { FloatingPanel } from "../../../ui";
import { formatArticleDate } from "./utils";

interface ArticleReaderInfoPanelProps {
    visible: boolean;
    article: RssArticle;
    feedTitle?: string;
    onClose: () => void;
    onToggleSaved?: () => void;
}

export function ArticleReaderInfoPanel({
    visible,
    article,
    feedTitle,
    onClose,
    onToggleSaved,
}: ArticleReaderInfoPanelProps) {
    return (
        <FloatingPanel visible={visible} className="overflow-hidden">
            <div className="reader-panel-header px-4 pt-4 pb-3 flex items-center justify-between">
                <h2 className="font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-[color:var(--color-text-primary)]">Article Info</h2>
                <button
                    onClick={onClose}
                    className="reader-chip w-8 h-8 inline-flex items-center justify-center transition-colors hover:opacity-80"
                    aria-label="Close"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            <div className="p-5 space-y-5 flex-1 min-h-0 overflow-y-auto custom-scrollbar [content-visibility:auto] overscroll-contain">
                <div>
                    <h3 className="font-serif text-xl font-semibold text-[color:var(--color-text-primary)] leading-tight">
                        {article.title}
                    </h3>
                </div>

                <div className="space-y-3 font-mono text-[11px] uppercase tracking-[0.08em]">
                    {article.author && (
                        <div className="flex items-start gap-2 text-[color:var(--color-text-secondary)]">
                            <User className="w-4 h-4 mt-0.5" />
                            <span>{article.author}</span>
                        </div>
                    )}

                    {(article.publishedAt || article.fetchedAt) && (
                        <div className="flex items-start gap-2 text-[color:var(--color-text-secondary)]">
                            <Calendar className="w-4 h-4 mt-0.5" />
                            <span>{formatArticleDate(article.publishedAt ?? article.fetchedAt)}</span>
                        </div>
                    )}

                    {feedTitle && (
                        <div className="flex items-start gap-2 text-[color:var(--color-text-secondary)]">
                            <Globe className="w-4 h-4 mt-0.5" />
                            <span>{feedTitle}</span>
                        </div>
                    )}
                </div>

                {onToggleSaved && (
                    <button
                        type="button"
                        onClick={onToggleSaved}
                        className={cn(
                            "flex h-10 w-full items-center justify-center gap-2 border font-mono text-[11px] font-bold uppercase tracking-[0.1em] transition-colors",
                            article.isSaved
                                ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[color:var(--color-accent)]"
                                : "border-[var(--color-border)] hover:bg-[var(--color-surface-muted)] text-[color:var(--color-text-secondary)]"
                        )}
                    >
                        <Bookmark className={cn("w-4 h-4", article.isSaved && "fill-current")} />
                        {article.isSaved ? "Saved for Offline" : "Save for Offline"}
                    </button>
                )}

                {article.url && (
                    <button
                        type="button"
                        onClick={() => {
                            void openExternalUrl(article.url);
                        }}
                        className="flex h-10 w-full items-center justify-center gap-2 border border-[var(--color-border)] font-mono text-[11px] font-bold uppercase tracking-[0.1em] transition-colors hover:bg-[var(--color-surface-muted)]"
                    >
                        <ExternalLink className="w-4 h-4" />
                        Open Original
                    </button>
                )}
            </div>
        </FloatingPanel>
    );
}
