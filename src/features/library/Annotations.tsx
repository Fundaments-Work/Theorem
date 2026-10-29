
import { useState, useMemo, useCallback, useRef, useEffect, useLayoutEffect, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { joinFields } from "../../core/lib/search/native-rank";
import { useFuzzyRank } from "../../core/lib/search/useFuzzyRank";
import { sanitizeHtmlForDisplay } from "../../core/lib/sanitize";
import { useLibraryStore, useUIStore, useVocabularyStore, useRssStore, getRssArticleById } from "../../core/store";
import { HIGHLIGHT_SOLID_COLORS } from "../../core/lib/design-tokens";
import type { HighlightColor, VocabularyTerm } from "../../core/types";
import {
    resolveAnnotationSource,
    navigateToAnnotationSource,
    parseAnnotationSourceId,
    type ResolvedAnnotationSource,
} from "../../core/lib/annotation-source";
import { EditNoteModal } from "./components/modals/EditNoteModal";
import { PageHeader, Dropdown, ConfirmDialog, Modal, ModalHeader, ModalBody } from "../../ui";
import { WorkbenchTabs, type WorkbenchTab } from "./components/WorkbenchTabs";
import { BookmarksPanel } from "./Bookmarks";
import {
    Highlighter,
    StickyNote,
    Trash2,
    X,
    Layers,
    List,
} from "lucide-react";
import { ReviewCardStack } from "./components/ReviewCardStack";
import { getDailyReviewStatus, selectDailyReviewCards, markDailyReviewCompleted } from "../../core/lib/daily-review";
import { ShareMenu } from "./components/ShareMenu";
import { AnnotationListCard } from "./components/AnnotationListCard";
import { ANNOTATION_ROW_GAP_PX, annotationRowSize, computeCardLayout, type CardLayout } from "./components/annotation-card-layout";
import { useCardTextMeasurer } from "./components/useCardTextMeasurer";
import {
    WORKBENCH_VIEW_STATE_KEY,
    decodeWorkbenchViewState,
    encodeWorkbenchViewState,
    resolveWorkbenchPosition,
} from "../../core/lib/workbench-state";
import type { WorkbenchViewState } from "../../core/lib/workbench-state";
import { localDateKey } from "../../core/lib/date-keys";

function getTermPrimaryDefinition(term: VocabularyTerm): string {
    const firstMeaning = term.meanings[0];
    if (!firstMeaning || firstMeaning.definitions.length === 0) {
        return "No definition";
    }
    return firstMeaning.definitions[0];
}

function isHtml(text: string): boolean {
    return text.includes("<") && text.includes(">");
}

/** Annotations whose source is unknown are hidden. */
function isVisibleSource(sourceId: string, sourceLookup: Map<string, ResolvedAnnotationSource>): boolean {
    return sourceLookup.has(sourceId);
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The Workbench subtitle, in the words its tabs use (highlights, notes, words). */
export function workbenchSummary(
    filter: string,
    marks: ReadonlyArray<{ type: string; bookId: string }>,
    wordCount: number,
): string {
    const words = plural(wordCount, "word", "words");
    if (filter === "vocabulary") return words;
    const notes = marks.filter((m) => m.type === "note").length;
    const highlights = marks.length - notes;
    const books = new Set(marks.map((m) => m.bookId)).size;
    const parts = filter === "notes"
        ? [plural(notes, "note", "notes")]
        : filter === "highlights"
            ? [plural(highlights, "highlight", "highlights")]
            : [plural(highlights, "highlight", "highlights"), plural(notes, "note", "notes")];
    const fromBooks = books > 0 ? ` from ${plural(books, "book", "books")}` : "";
    return filter === "all" ? `${parts.join(", ")}${fromBooks} · ${words}` : `${parts[0]}${fromBooks}`;
}

function EmptyAnnotations({ type }: { type: "all" | "highlights" | "notes" }) {
    const icons = {
        all: Highlighter,
        highlights: Highlighter,
        notes: StickyNote,
    };
    const titles = {
        all: "No Highlights or Notes Yet",
        highlights: "No Highlights Yet",
        notes: "No Notes Yet",
    };
    const descriptions = {
        all: "Start reading and highlight text or add notes to see them here.",
        highlights: "Highlight important passages while reading to see them here.",
        notes: "Add notes to your books while reading to see them here.",
    };

    const Icon = icons[type];

    return (
        <div className="mx-auto w-full max-w-[26rem] min-w-0 px-4 sm:px-6 flex flex-col items-center justify-center py-20 text-center animate-fade-in">
            <div className="w-16 h-16 bg-[var(--color-surface-muted)] flex items-center justify-center mb-6">
                <Icon className="w-6 h-6 text-[color:var(--color-text-secondary)]" />
            </div>
            <h2 className="w-full break-words text-balance text-lg text-[color:var(--color-text-primary)] mb-2">
                {titles[type]}
            </h2>
            <p className="mx-auto w-full max-w-[24rem] break-words text-[color:var(--color-text-muted)] mb-8 text-sm leading-relaxed">
                {descriptions[type]}
            </p>
        </div>
    );
}

interface AnnotationCardProps {
    annotation: {
        id: string;
        bookId: string;
        type: "highlight" | "note" | "bookmark";
        location: string;
        selectedText?: string;
        noteContent?: string;
        color?: HighlightColor;
        createdAt: Date;
        updatedAt?: Date;
    };
    source: ResolvedAnnotationSource | undefined;
    shareId: string | null;
    menuOpen: boolean;
    layout: CardLayout;
    onToggleExpanded: (id: string) => void;
    searchQuery?: string;
    onMenuOpenChange: (id: string | null) => void;
    onDelete: (id: string) => void;
    onEdit: (id: string) => void;
    onGoToSource: (sourceId: string, location?: string) => void;
    onShare: (id: string | null) => void;
}

const AnnotationCard = memo(function AnnotationCard({
    annotation,
    source,
    shareId,
    menuOpen,
    layout,
    onToggleExpanded,
    searchQuery,
    onMenuOpenChange,
    onDelete,
    onEdit,
    onShare,
    onGoToSource,
}: AnnotationCardProps) {
    const isArticle = source?.isArticle ?? annotation.bookId.startsWith("rss:");
    const openInSource = () => onGoToSource(annotation.bookId, annotation.location);
    return (
        <AnnotationListCard
            id={annotation.id}
            typeLabel={annotation.type}
            dateLabel={localDateKey(new Date(annotation.createdAt))}
            sourceTitle={source?.title || "Unknown source"}
            sourceAuthor={source?.author || "Unknown author"}
            accentColor={annotation.color ? HIGHLIGHT_SOLID_COLORS[annotation.color] : undefined}
            quote={annotation.selectedText}
            note={annotation.noteContent}
            searchQuery={searchQuery}
            menuOpen={menuOpen}
            onMenuOpenChange={onMenuOpenChange}
            layout={layout}
            onToggleExpanded={onToggleExpanded}
            menuItems={[
                { label: isArticle ? "Open in article" : "Open in book", onSelect: openInSource },
                { label: "Edit note", onSelect: () => onEdit(annotation.id) },
                { label: "Share", onSelect: () => onShare(annotation.id) },
                { label: "Delete", onSelect: () => onDelete(annotation.id), danger: true },
            ]}
            popover={shareId === annotation.id ? (
                <ShareMenu
                    annotation={annotation}
                    book={source ? { title: source.title, author: source.author } : undefined}
                    onClose={() => onShare(null)}
                />
            ) : undefined}
            onPopoverClose={() => onShare(null)}
            onOpen={openInSource}
            openTitle={isArticle ? "Click to open article at this highlighted location" : "Click to open at this highlighted location"}
        />
    );
});

export function AnnotationsPage() {
    const annotations = useLibraryStore((state) => state.annotations);
    const getBook = useLibraryStore((state) => state.getBook);
    const removeAnnotation = useLibraryStore((state) => state.removeAnnotation);
    const updateAnnotation = useLibraryStore((state) => state.updateAnnotation);
    const currentBookId = useUIStore((state) => state.currentBookId);
    const setRoute = useUIStore((state) => state.setRoute);
    // Bookmarks are a Workbench tab; the `bookmarks` route (Ctrl+7, its own search scope) opens it.
    const showBookmarks = useUIStore((state) => state.currentRoute === "bookmarks");
    const setPendingReaderLocation = useUIStore((state) => state.setPendingReaderLocation);
    const searchQuery = useUIStore((state) => state.searchQuery);
    const vocabularyTerms = useVocabularyStore((state) => state.vocabularyTerms);
    const deleteVocabularyTerm = useVocabularyStore((state) => state.deleteVocabularyTerm);
    const rssArticles = useRssStore((state) => state.articles);
    const rssFeeds = useRssStore((state) => state.feeds);
    const openArticleInReader = useRssStore((state) => state.openArticleInReader);
    const getArticle = useRssStore((state) => state.getArticle);
    const loadArticle = useRssStore((state) => state.loadArticle);
    const savedViewState = useRef<ReturnType<typeof decodeWorkbenchViewState> | null>(null);
    if (savedViewState.current === null) {
        savedViewState.current = decodeWorkbenchViewState(
            typeof window !== "undefined"
                ? window.sessionStorage.getItem(WORKBENCH_VIEW_STATE_KEY)
                : null
        );
    }
    const workbenchSavedState = savedViewState.current;
    const initialFilter = (workbenchSavedState.activeFilter === "all" || !workbenchSavedState.activeFilter)
        ? "highlights"
        : workbenchSavedState.activeFilter;
    const [activeFilter, setActiveFilter] = useState<"highlights" | "notes" | "vocabulary">(initialFilter as "highlights" | "notes" | "vocabulary");
    // Other pages can ask for a specific Workbench tab; honour it once.
    const workbenchFilterRequest = useUIStore((state) => state.workbenchFilterRequest);
    const requestWorkbenchFilter = useUIStore((state) => state.requestWorkbenchFilter);
    useEffect(() => {
        if (!workbenchFilterRequest) return;
        const target = workbenchFilterRequest === "all" ? "highlights" : workbenchFilterRequest;
        setActiveFilter(target);
        requestWorkbenchFilter(undefined);
    }, [workbenchFilterRequest, requestWorkbenchFilter]);
    const [sortBy, setSortBy] = useState<"newest" | "oldest" | "book">(workbenchSavedState.sortBy ?? "newest");
    const [vocabSortBy, setVocabSortBy] = useState<"alpha" | "newest" | "oldest">("alpha");
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editContent, setEditContent] = useState("");
    const [sharingId, setSharingId] = useState<string | null>(null);
    const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
    const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
    const { listRef, measurer } = useCardTextMeasurer();
    const toggleExpanded = useCallback((id: string) => {
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (!next.delete(id)) next.add(id);
            return next;
        });
    }, []);
    const [viewMode, setViewMode] = useState<"list" | "cards">(workbenchSavedState.viewMode ?? "list");
    const [cardIndex, setCardIndex] = useState(0);
    const [groupIndex, setGroupIndex] = useState(0);
    const [selectedVocabTerm, setSelectedVocabTerm] = useState<VocabularyTerm | null>(null);
    const dailyCards = useMemo(() => selectDailyReviewCards(annotations), [annotations]);
    const [showDailyReview, setShowDailyReview] = useState(() => {
        try {
            const dismissed = typeof window !== "undefined" ? window.sessionStorage.getItem("theorem:daily-review-dismissed-session") : null;
            const status = getDailyReviewStatus();
            return !status.completed && !dismissed;
        } catch {
            return false;
        }
    });
    const dailyReviewStatus = useMemo(() => getDailyReviewStatus(), [showDailyReview]);

    const handleDismissDailyReview = useCallback(() => {
        try {
            window.sessionStorage.setItem("theorem:daily-review-dismissed-session", "true");
        } catch {
            // best-effort
        }
        setShowDailyReview(false);
    }, []);

    const handleCompleteDailyReview = useCallback(() => {
        markDailyReviewCompleted(undefined, dailyCards.map((c) => c.id));
    }, [dailyCards]);

    const isDailyReviewActive = showDailyReview && dailyCards.length > 0;

    // Derive source lookup from annotation bookIds only — avoids subscribing to
    // the entire books array (which re-renders on every progress tick). The
    // book count still invalidates it: books hydrate after annotations, and a
    // lookup built before that would hide every annotation until they change.
    const bookCount = useLibraryStore((state) => state.books.length);
    const sourceLookup = useMemo(
        () => {
            const sourceIds = new Set(annotations.map((a) => a.bookId));
            const lookup = new Map<string, ResolvedAnnotationSource>();
            for (const id of sourceIds) {
                const ann = annotations.find((a) => a.bookId === id);
                const resolved = resolveAnnotationSource(id, getBook, rssArticles, rssFeeds, ann?.chapterTitle);
                if (resolved) lookup.set(id, resolved);
            }
            return lookup;
        },
        // getBook is stable (store action ref); bookCount re-derives once books load
        [annotations, getBook, bookCount, rssArticles, rssFeeds],
    );

    // If any annotations originate from RSS articles not yet loaded into memory,
    // load them from SQLite in the background so full metadata becomes available.
    useEffect(() => {
        for (const ann of annotations) {
            const { isArticle, cleanId } = parseAnnotationSourceId(ann.bookId);
            if (isArticle || (!getBook(ann.bookId) && ann.bookId)) {
                if (!getRssArticleById(rssArticles, cleanId)) {
                    loadArticle(cleanId);
                }
            }
        }
    }, [annotations, rssArticles, getBook, loadArticle]);

    const scopedAnnotations = useMemo(() => {
        let filtered = annotations.filter((a) => a.type !== "bookmark" && isVisibleSource(a.bookId, sourceLookup));

        if (currentBookId) {
            filtered = filtered.filter((annotation) => annotation.bookId === currentBookId);
        }

        if (activeFilter !== "vocabulary") {
            const typeMap = {
                highlights: "highlight",
                notes: "note",
            } as const;
            filtered = filtered.filter((a) => a.type === typeMap[activeFilter]);
        }
        return filtered;
    }, [annotations, activeFilter, currentBookId, sourceLookup]);

    // Search ranks with the native matcher; null while there is no ranking yet.
    const rankedAnnotations = useFuzzyRank(scopedAnnotations, searchQuery, (annotation) => ({
        primary: annotation.selectedText || "",
        secondary: joinFields(annotation.noteContent, sourceLookup.get(annotation.bookId)?.title),
    }));

    const filteredAnnotations = useMemo(() => {
        if (rankedAnnotations) return rankedAnnotations.map(({ item }) => item);

        const filtered = [...scopedAnnotations];
        filtered.sort((a, b) => {
            switch (sortBy) {
                case "newest": {
                    const dateA = a.createdAt instanceof Date ? a.createdAt : new Date(a.createdAt);
                    const dateB = b.createdAt instanceof Date ? b.createdAt : new Date(b.createdAt);
                    return dateB.getTime() - dateA.getTime();
                }
                case "oldest": {
                    const dateA = a.createdAt instanceof Date ? a.createdAt : new Date(a.createdAt);
                    const dateB = b.createdAt instanceof Date ? b.createdAt : new Date(b.createdAt);
                    return dateA.getTime() - dateB.getTime();
                }
                case "book":
                    const bookA = sourceLookup.get(a.bookId)?.title || "";
                    const bookB = sourceLookup.get(b.bookId)?.title || "";
                    return bookA.localeCompare(bookB);
                default:
                    return 0;
            }
        });

        return filtered;
    }, [scopedAnnotations, rankedAnnotations, sortBy, sourceLookup]);

    const sortedVocabularyTerms = useMemo(() => {
        if (activeFilter !== "vocabulary") return [];
        return [...vocabularyTerms].sort((a, b) => {
            if (vocabSortBy === "alpha") {
                return a.term.localeCompare(b.term);
            }
            const timeA = new Date(a.createdAt).getTime();
            const timeB = new Date(b.createdAt).getTime();
            if (vocabSortBy === "newest") {
                return timeB - timeA;
            }
            if (vocabSortBy === "oldest") {
                return timeA - timeB;
            }
            return 0;
        });
    }, [vocabularyTerms, activeFilter, vocabSortBy]);

    const rankedVocabularyTerms = useFuzzyRank(sortedVocabularyTerms, searchQuery, (term) => ({
        primary: term.term,
        secondary: joinFields(...term.meanings.flatMap((m) => m.definitions)),
    }));

    const filteredVocabularyTerms = useMemo(
        () => (rankedVocabularyTerms ? rankedVocabularyTerms.map(({ item }) => item) : sortedVocabularyTerms),
        [rankedVocabularyTerms, sortedVocabularyTerms],
    );

    const prevLenRef = useRef(filteredAnnotations.length);
    if (filteredAnnotations.length !== prevLenRef.current) {
        prevLenRef.current = filteredAnnotations.length;
        setGroupIndex(0);
        setCardIndex(0);
    }

    const annotationGroups = useMemo(() => {
        const groups = new Map<string, typeof filteredAnnotations>();
        for (const ann of filteredAnnotations) {
            const key = ann.bookId;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(ann);
        }
        return Array.from(groups.entries()).map(([bookId, annotations]) => {
            const source = sourceLookup.get(bookId);
            return {
                bookId,
                annotations,
                source,
                title: source?.title || "Unknown source",
                isArticle: source?.isArticle ?? bookId.startsWith("rss:"),
            };
        });
    }, [filteredAnnotations, sourceLookup]);

    const workbenchRestoredRef = useRef(false);
    useEffect(() => {
        if (workbenchRestoredRef.current) return;
        if (annotationGroups.length === 0) return;
        workbenchRestoredRef.current = true;
        const position = resolveWorkbenchPosition(annotationGroups, workbenchSavedState);
        if (position) {
            setGroupIndex(position.groupIndex);
            setCardIndex(position.cardIndex);
        }
    }, [annotationGroups, workbenchSavedState]);

    useEffect(() => {
        const group = annotationGroups[groupIndex];
        const card = group?.annotations[cardIndex];
        const state: WorkbenchViewState = { viewMode, activeFilter, sortBy };
        if (group && card) {
            state.bookId = group.bookId;
            state.cardId = card.id;
        }
        try {
            window.sessionStorage.setItem(WORKBENCH_VIEW_STATE_KEY, encodeWorkbenchViewState(state));
        } catch {
            // sessionStorage unavailable — best-effort persistence
        }
    }, [viewMode, activeFilter, sortBy, groupIndex, cardIndex, annotationGroups]);

    // Exact, not an estimate: each card renders at its computed layout height.
    const cardLayouts = useMemo(
        () => filteredAnnotations.map((ann) =>
            computeCardLayout({ quote: ann.selectedText, note: ann.noteContent }, measurer, expandedIds.has(ann.id))),
        [filteredAnnotations, measurer, expandedIds],
    );
    const estimateAnnotationSize = useCallback((index: number) => annotationRowSize(cardLayouts[index]), [cardLayouts]);

    const annotationsVirtualizer = useVirtualizer({
        count: filteredAnnotations.length,
        getScrollElement: useCallback(() => document.getElementById('app-main'), []),
        estimateSize: estimateAnnotationSize,
        getItemKey: useCallback((index: number) => filteredAnnotations[index]?.id ?? String(index), [filteredAnnotations]),
        overscan: 5,
    });

    // Sizes come from estimateSize only; recompute offsets when they change.
    useLayoutEffect(() => {
        annotationsVirtualizer.measure();
    }, [annotationsVirtualizer, cardLayouts]);

    const [deleteAnnotationId, setDeleteAnnotationId] = useState<string | null>(null);

    useEffect(() => {
        if (viewMode !== "cards" || annotationGroups.length === 0) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === "ArrowLeft") {
                if (cardIndex > 0) {
                    setCardIndex(i => i - 1);
                } else if (groupIndex > 0) {
                    setGroupIndex(g => g - 1);
                    const prevGroup = annotationGroups[groupIndex - 1];
                    setCardIndex(prevGroup.annotations.length - 1);
                }
            }
            if (e.key === "ArrowRight") {
                const group = annotationGroups[groupIndex];
                if (cardIndex < group.annotations.length - 1) {
                    setCardIndex(i => i + 1);
                } else if (groupIndex < annotationGroups.length - 1) {
                    setGroupIndex(g => g + 1);
                    setCardIndex(0);
                }
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [viewMode, annotationGroups, groupIndex, cardIndex]);

    const handleDelete = (id: string) => {
        setDeleteAnnotationId(id);
    };

    const handleDeleteConfirm = () => {
        if (deleteAnnotationId) {
            removeAnnotation(deleteAnnotationId);
            setDeleteAnnotationId(null);
        }
    };

    const handleEdit = (id: string) => {
        const annotation = annotations.find((a) => a.id === id);
        if (annotation) {
            setEditingId(id);
            setEditContent(annotation.noteContent || "");
        }
    };

    const hasBook = useCallback((id: string) => !!useLibraryStore.getState().getBook(id), []);

    const handleGoToSource = useCallback((sourceId: string, location?: string) => {
        const ann = annotations.find(
            (a) => a.bookId === sourceId && (location ? a.location === location : true),
        );
        navigateToAnnotationSource(sourceId, location, {
            setPendingReaderLocation,
            setRoute,
            openArticleInReader,
            getArticle,
            loadArticle,
            hasBook,
            fallbackTitle: ann?.chapterTitle,
        });
    }, [annotations, setPendingReaderLocation, setRoute, openArticleInReader, getArticle, loadArticle, hasBook]);

    const handleShare = (id: string | null) => {
        setSharingId(id);
    };

    const annotationCount = annotations.filter((a) => a.type !== "bookmark" && isVisibleSource(a.bookId, sourceLookup)).length;
    const hasAnyContent = annotationCount > 0 || vocabularyTerms.length > 0;
    const selectedBookTitle = currentBookId
        ? (sourceLookup.get(currentBookId)?.title || "Selected reference")
        : null;

    const selectTab = (tab: WorkbenchTab) => {
        if (tab === "bookmarks") {
            setRoute("bookmarks");
            return;
        }
        if (tab === "all") {
            setActiveFilter("highlights");
        } else {
            setActiveFilter(tab);
        }
        if (showBookmarks) setRoute("annotations");
    };
    const tabs = <WorkbenchTabs active={showBookmarks ? "bookmarks" : activeFilter} onSelect={selectTab} />;

    if (showBookmarks) {
        return (
            <div className="mx-auto w-full max-w-[var(--layout-content-max-width)] px-4 py-6 pb-[calc(var(--layout-bottom-nav-height)+var(--safe-area-bottom)+var(--spacing-xl))] sm:px-6 md:pb-0 lg:px-8 lg:py-8 animate-fade-in">
                <BookmarksPanel
                    tabs={tabs}
                    hasDailyReview={!dailyReviewStatus.completed && dailyCards.length > 0}
                    dailyCardsCount={dailyCards.length}
                    onOpenDailyReview={() => {
                        setShowDailyReview(true);
                        setRoute("annotations");
                    }}
                />
            </div>
        );
    }

    if (!hasAnyContent) {
        return (
            <div className="mx-auto w-full max-w-[var(--layout-content-max-width)] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
                {tabs}
                <EmptyAnnotations type="all" />
            </div>
        );
    }


    return (
        <div className="mx-auto w-full max-w-[var(--layout-content-max-width)] px-4 py-6 pb-[calc(var(--layout-bottom-nav-height)+var(--safe-area-bottom)+var(--spacing-xl))] sm:px-6 md:pb-0 lg:px-8 lg:py-8 animate-fade-in">
            <EditNoteModal
                isOpen={!!editingId}
                content={editContent}
                onClose={() => setEditingId(null)}
                onSave={(content) => {
                    if (editingId) {
                        updateAnnotation(editingId, { noteContent: content });
                        setEditingId(null);
                        setEditContent("");
                    }
                }}
            />

            <ConfirmDialog
                isOpen={!!deleteAnnotationId}
                title="Delete Annotation"
                message="Are you sure you want to delete this annotation?"
                confirmLabel="Delete"
                cancelLabel="Cancel"
                variant="danger"
                onConfirm={handleDeleteConfirm}
                onCancel={() => setDeleteAnnotationId(null)}
            />

            {isDailyReviewActive ? (
                <>
                    <PageHeader
                        title="Daily Review"
                        description={`${dailyCards.length} ${dailyCards.length === 1 ? "highlight" : "highlights"} selected for reflection today`}
                    >
                        <button
                            type="button"
                            onClick={handleDismissDailyReview}
                            className="inline-flex items-center gap-1.5 text-xs text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)] transition-colors py-1.5 px-3 border border-[var(--color-border)] hover:bg-[var(--color-surface-muted)] touch-manipulation ui-btn"
                            aria-label="Skip daily review to workbench"
                            title="Skip to Workbench (Esc)"
                        >
                            <span>Skip to Workbench</span>
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </PageHeader>

                    <div className="w-full max-w-[42rem] mx-auto my-2 sm:my-6">
                        <ReviewCardStack
                            cards={dailyCards}
                            sources={sourceLookup}
                            onComplete={handleCompleteDailyReview}
                            onGoToSource={handleGoToSource}
                            onClose={handleDismissDailyReview}
                            completionTitle="Daily Review Complete"
                            completionDescription={`You have reviewed all ${dailyCards.length} daily highlights. A fresh deck will be curated tomorrow.`}
                            completionActionLabel="Back to Workbench"
                            onCompletionAction={handleDismissDailyReview}
                            onEdit={handleEdit}
                            onDelete={handleDelete}
                        />
                    </div>
                </>
            ) : (
                <>
                    <PageHeader
                        title="Workbench"
                        description={
                            <span>
                                {workbenchSummary(activeFilter, filteredAnnotations, filteredVocabularyTerms.length)}
                                {!dailyReviewStatus.completed && dailyCards.length > 0 && (
                                    <>
                                        <span className="text-[color:var(--color-border-strong)] mx-1.5 select-none">·</span>
                                        <button
                                            type="button"
                                            onClick={() => setShowDailyReview(true)}
                                            className="inline-flex items-center gap-1 font-medium text-[color:var(--color-accent)] hover:underline transition-colors"
                                            aria-label="Open Daily Review"
                                        >
                                            Daily Review ({dailyCards.length})
                                        </button>
                                    </>
                                )}
                            </span>
                        }
                    />

                    {currentBookId && (
                        <div className="mb-6 flex flex-wrap items-center gap-2 border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-sans text-[11px]">
                            <span className="text-[color:var(--color-text-secondary)]">
                                Showing highlights and notes for:
                            </span>
                            <span className="text-[color:var(--color-text-primary)]">{selectedBookTitle}</span>
                            <button
                                onClick={() => setRoute("annotations")}
                                className="ml-auto border border-[var(--color-border)] px-2 py-1 text-[11px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
                            >
                                Clear
                            </button>
                        </div>
                    )}

                    <div className="mb-4 sm:mb-6">
                        {tabs}
                    </div>

                    <div className="mb-6 flex items-center justify-between gap-3">
                        <button
                            type="button"
                            onClick={() => setViewMode((prev) => (prev === "list" ? "cards" : "list"))}
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-muted)] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)] transition-colors touch-manipulation ui-btn"
                            title={viewMode === "list" ? "Cards view" : "List view"}
                            aria-label={viewMode === "list" ? "Cards view" : "List view"}
                        >
                            {viewMode === "list" ? <Layers className="w-4 h-4" /> : <List className="w-4 h-4" />}
                        </button>

                        <div className="shrink-0">
                            <Dropdown
                                value={activeFilter === "vocabulary" ? vocabSortBy : sortBy}
                                onChange={(value) => {
                                    if (activeFilter === "vocabulary") {
                                        setVocabSortBy(value as typeof vocabSortBy);
                                    } else {
                                        setSortBy(value as typeof sortBy);
                                    }
                                }}
                                size="sm"
                                align="right"
                                className="h-8 !w-auto min-w-[115px] sm:min-w-[130px] !border !border-[var(--color-border)] !text-xs !py-0 !px-2.5 font-sans"
                                options={
                                    activeFilter === "vocabulary"
                                        ? [
                                              { value: "alpha", label: "Alphabetical" },
                                              { value: "newest", label: "Newest First" },
                                              { value: "oldest", label: "Oldest First" },
                                          ]
                                        : [
                                              { value: "newest", label: "Newest First" },
                                              { value: "oldest", label: "Oldest First" },
                                              { value: "book", label: "By Book" },
                                          ]
                                }
                            />
                        </div>
                    </div>

                    {activeFilter === "vocabulary" ? (
                        filteredVocabularyTerms.length === 0 ? (
                            <div className="text-center py-16">
                                <p className="text-[color:var(--color-text-muted)]">
                                    No terms found{searchQuery ? " matching your search" : ""}.
                                </p>
                            </div>
                        ) : viewMode === "cards" ? (
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                {filteredVocabularyTerms.map((term) => (
                                    <div
                                        key={term.id}
                                        onClick={() => setSelectedVocabTerm(term)}
                                        className="border border-[var(--color-border)] bg-[var(--color-surface)] p-4 flex flex-col gap-2 cursor-pointer hover:border-[var(--color-text-muted)] transition-colors"
                                        role="button"
                                        tabIndex={0}
                                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedVocabTerm(term); }}
                                    >
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="text-sm font-medium text-[color:var(--color-text-primary)] truncate">{term.term}</span>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); deleteVocabularyTerm(term.id); setSelectedVocabTerm(null); }}
                                                className="shrink-0 p-1 text-[color:var(--color-text-muted)] hover:text-[color:var(--color-error)] transition-colors"
                                                aria-label={`Delete ${term.term}`}
                                            >
                                                <Trash2 className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                        {term.meanings[0]?.partOfSpeech && (
                                            <span className="text-[10px] text-[color:var(--color-text-muted)]">{term.meanings[0].partOfSpeech}</span>
                                        )}
                                        <p className="text-xs leading-relaxed text-[color:var(--color-text-secondary)] line-clamp-2">
                                            {(() => {
                                                const def = getTermPrimaryDefinition(term);
                                                return isHtml(def) ? (term.meanings[0]?.partOfSpeech || "Definition") : def;
                                            })()}
                                        </p>
                                        {term.language && (
                                            <span className="text-[10px] text-[color:var(--color-text-muted)]">{term.language}</span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border-subtle)]">
                                {filteredVocabularyTerms.map((term) => (
                                    <div
                                        key={term.id}
                                        onClick={() => setSelectedVocabTerm(term)}
                                        className="px-4 py-3 flex items-center justify-between gap-4 cursor-pointer hover:bg-[var(--color-surface-muted)] transition-colors group"
                                        role="button"
                                        tabIndex={0}
                                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedVocabTerm(term); }}
                                    >
                                        <div className="flex items-baseline gap-3 min-w-0 flex-1">
                                            <span className="font-serif text-sm font-medium text-[color:var(--color-text-primary)] shrink-0">
                                                {term.term}
                                            </span>
                                            {term.meanings[0]?.partOfSpeech && (
                                                <span className="font-mono text-[10px] text-[color:var(--color-text-muted)] italic shrink-0">
                                                    {term.meanings[0].partOfSpeech}
                                                </span>
                                            )}
                                            <span className="text-xs text-[color:var(--color-text-secondary)] truncate">
                                                {(() => {
                                                    const def = getTermPrimaryDefinition(term);
                                                    return isHtml(def) ? (term.meanings[0]?.partOfSpeech || "Definition") : def;
                                                })()}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                            {term.language && (
                                                <span className="font-mono text-[10px] text-[color:var(--color-text-muted)] uppercase hidden sm:inline">
                                                    {term.language}
                                                </span>
                                            )}
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    deleteVocabularyTerm(term.id);
                                                    setSelectedVocabTerm(null);
                                                }}
                                                className="p-1 text-[color:var(--color-text-muted)] hover:text-[color:var(--color-error)] transition-colors opacity-70 group-hover:opacity-100"
                                                aria-label={`Delete ${term.term}`}
                                            >
                                                <Trash2 className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )
                    ) : filteredAnnotations.length === 0 ? (
                <div className="text-center py-16">
                    <p className="text-[color:var(--color-text-muted)]">
                        No {activeFilter} found
                        {searchQuery ? " matching your search" : ""}.
                    </p>
                </div>
            ) : viewMode === "cards" ? (
                <div className="w-full max-w-[42rem] mx-auto my-2 sm:my-6">
                    {annotationGroups.length === 0 ? (
                        <div className="text-center py-16">
                            <p className="text-[color:var(--color-text-muted)]">No annotations to display as cards.</p>
                        </div>
                    ) : (
                        <ReviewCardStack
                            cards={annotationGroups[groupIndex].annotations}
                            sources={sourceLookup}
                            deckTitle={`Deck ${groupIndex + 1} of ${annotationGroups.length}: ${annotationGroups[groupIndex].title}`}
                            deckSubtitle={annotationGroups[groupIndex].isArticle ? "Article Deck" : "Book Deck"}
                            hasPrevDeck={groupIndex > 0}
                            hasNextDeck={groupIndex < annotationGroups.length - 1}
                            prevDeckLabel={annotationGroups[groupIndex].isArticle ? "Prev Article" : "Prev Book"}
                            nextDeckLabel={annotationGroups[groupIndex].isArticle ? "Next Article" : "Next Book"}
                            onPrevDeck={() => {
                                if (groupIndex > 0) setGroupIndex((g) => g - 1);
                            }}
                            onNextDeck={() => {
                                if (groupIndex < annotationGroups.length - 1) setGroupIndex((g) => g + 1);
                            }}
                            onGoToSource={handleGoToSource}
                            onEdit={handleEdit}
                            onDelete={handleDelete}
                            completionTitle="Deck Completed"
                            completionDescription={`You have reviewed all ${annotationGroups[groupIndex].annotations.length} highlights in this ${annotationGroups[groupIndex].isArticle ? "article" : "book"}.`}
                            completionActionLabel={groupIndex < annotationGroups.length - 1 ? `Next ${annotationGroups[groupIndex].isArticle ? "Article" : "Book"} →` : "Back to First Deck"}
                            onCompletionAction={() => {
                                if (groupIndex < annotationGroups.length - 1) {
                                    setGroupIndex((g) => g + 1);
                                } else {
                                    setGroupIndex(0);
                                }
                            }}
                        />
                    )}
                </div>
            ) : (
                <div ref={listRef} style={{ height: `${annotationsVirtualizer.getTotalSize()}px`, position: "relative" }}>
                        {annotationsVirtualizer.getVirtualItems().map((virtualRow) => {
                            const annotation = filteredAnnotations[virtualRow.index];
                            if (!annotation) return null;
                            return (
                                <div
                                    key={virtualRow.key}
                                    data-index={virtualRow.index}
                                    style={{
                                        position: "absolute",
                                        top: 0,
                                        left: 0,
                                        width: "100%",
                                        height: virtualRow.size,
                                        paddingBottom: ANNOTATION_ROW_GAP_PX,
                                        transform: `translateY(${virtualRow.start}px)`,
                                        // Each transformed row is its own stacking context;
                                        // lift the one with an open popover above later rows.
                                        zIndex: menuOpenId === annotation.id || sharingId === annotation.id ? 30 : undefined,
                                    }}
                                >
                                    <AnnotationCard
                                        annotation={annotation}
                                        source={sourceLookup.get(annotation.bookId)}
                                        shareId={sharingId}
                                        menuOpen={menuOpenId === annotation.id}
                                        onMenuOpenChange={setMenuOpenId}
                                        layout={cardLayouts[virtualRow.index]}
                                        onToggleExpanded={toggleExpanded}
                                        searchQuery={searchQuery}
                                        onDelete={handleDelete}
                                        onEdit={handleEdit}
                                        onGoToSource={handleGoToSource}
                                        onShare={handleShare}
                                    />
                                </div>
                            );
                        })}
                </div>
            )}

            {selectedVocabTerm && (
                <Modal isOpen onClose={() => setSelectedVocabTerm(null)} size="md">
                    <ModalHeader title={selectedVocabTerm.term} onClose={() => setSelectedVocabTerm(null)} showCloseButton />
                    <ModalBody>
                        <div className="space-y-6">
                            {selectedVocabTerm.phonetic && (
                                <span className="inline-block font-mono text-sm text-[var(--color-text-secondary)] bg-[var(--color-surface-muted)] px-2 py-0.5">
                                    /{selectedVocabTerm.phonetic}/
                                </span>
                            )}
                            {selectedVocabTerm.meanings.map((meaning, idx) => (
                                <div key={`${meaning.provider}-${idx}`}>
                                    <div className="flex items-center gap-3 mb-3">
                                        {meaning.partOfSpeech && (
                                            <span className="text-[10px] text-[var(--color-accent)] bg-[var(--color-accent)]/10 px-2 py-0.5">
                                                {meaning.partOfSpeech}
                                            </span>
                                        )}
                                        <span className="text-[9px] text-[var(--color-text-muted)]">
                                            {meaning.provider}
                                        </span>
                                    </div>
                                    <ul className="space-y-2">
                                        {meaning.definitions.slice(0, 5).map((def, i) => (
                                            <li key={`${i}-${def.slice(0, 40)}`} className="flex gap-2.5 text-sm text-[var(--color-text-primary)] leading-relaxed">
                                                <span className="shrink-0 mt-2 w-1.5 h-1.5 bg-[var(--color-accent)] opacity-40" />
                                                {isHtml(def) ? (
                                                    <div className="dict-definition min-w-0 break-words" dangerouslySetInnerHTML={sanitizeHtmlForDisplay(def)} />
                                                ) : (
                                                    <span className="min-w-0 break-words">{def}</span>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ))}
                            <hr className="border-[var(--color-border-subtle)]" />
                            <button
                                onClick={() => { deleteVocabularyTerm(selectedVocabTerm.id); setSelectedVocabTerm(null); }}
                                className="ui-btn-danger py-2.5 px-5 text-[11px]"
                            >
                                <Trash2 className="w-4 h-4" />
                                Delete this term
                            </button>
                        </div>
                    </ModalBody>
                </Modal>
            )}
                </>
            )}

        </div>
    );
}
