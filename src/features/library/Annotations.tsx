
import { useState, useMemo, useCallback, useRef, useEffect, useLayoutEffect, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "../../core/lib/utils";
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
    Pencil,
    BookOpen,
    BookOpenText,
    Trash2,
    ChevronLeft,
    ChevronRight,
    ChevronsLeft,
    ChevronsRight,
} from "lucide-react";
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

    const [activeFilter, setActiveFilter] = useState<"all" | "highlights" | "notes" | "vocabulary">(workbenchSavedState.activeFilter ?? "all");
    // Other pages can ask for a specific Workbench tab; honour it once.
    const workbenchFilterRequest = useUIStore((state) => state.workbenchFilterRequest);
    const requestWorkbenchFilter = useUIStore((state) => state.requestWorkbenchFilter);
    useEffect(() => {
        if (!workbenchFilterRequest) return;
        setActiveFilter(workbenchFilterRequest);
        requestWorkbenchFilter(undefined);
    }, [workbenchFilterRequest, requestWorkbenchFilter]);
    const [sortBy, setSortBy] = useState<"newest" | "oldest" | "book">(workbenchSavedState.sortBy ?? "newest");
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

    const cardTouchStartX = useRef(0);
    const cardTouchStartY = useRef(0);

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

        if (activeFilter !== "all" && activeFilter !== "vocabulary") {
            const typeMap = {
                highlights: "highlight",
                notes: "note",
            };
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
            const updatedA = a.updatedAt ? new Date(a.updatedAt).getTime() : new Date(a.createdAt).getTime();
            const updatedB = b.updatedAt ? new Date(b.updatedAt).getTime() : new Date(b.createdAt).getTime();
            if (updatedA !== updatedB) return updatedB - updatedA;
            return a.term.localeCompare(b.term);
        });
    }, [vocabularyTerms, activeFilter]);

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

    const handleCardTouchStart = useCallback((e: React.TouchEvent) => {
        cardTouchStartX.current = e.touches[0].clientX;
        cardTouchStartY.current = e.touches[0].clientY;
    }, []);
    const handleCardTouchEnd = useCallback((e: React.TouchEvent) => {
        const dx = e.changedTouches[0].clientX - cardTouchStartX.current;
        const dy = e.changedTouches[0].clientY - cardTouchStartY.current;
        if (Math.abs(dx) < 30 || Math.abs(dx) < Math.abs(dy)) return;
        const group = annotationGroups[groupIndex];
        if (!group) return;
        if (dx > 0) {
            if (cardIndex > 0) setCardIndex(i => i - 1);
            else if (groupIndex > 0) { setGroupIndex(g => g - 1); setCardIndex(0); }
        } else {
            if (cardIndex < group.annotations.length - 1) setCardIndex(i => i + 1);
            else if (groupIndex < annotationGroups.length - 1) { setGroupIndex(g => g + 1); setCardIndex(0); }
        }
    }, [cardIndex, groupIndex, annotationGroups]);

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
        setActiveFilter(tab);
        if (showBookmarks) setRoute("annotations");
    };
    const tabs = <WorkbenchTabs active={showBookmarks ? "bookmarks" : activeFilter} onSelect={selectTab} />;

    if (showBookmarks) {
        return (
            <div className="mx-auto w-full max-w-[var(--layout-content-max-width)] px-4 py-6 pb-[calc(var(--layout-bottom-nav-height)+var(--safe-area-bottom)+var(--spacing-xl))] sm:px-6 md:pb-0 lg:px-8 lg:py-8 animate-fade-in">
                <BookmarksPanel tabs={tabs} />
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
            
            <PageHeader
                title="Workbench"
                description={workbenchSummary(activeFilter, filteredAnnotations, activeFilter === "all" ? vocabularyTerms.length : filteredVocabularyTerms.length)}
            />

            {currentBookId && (
                <div className="mb-8 flex flex-wrap items-center gap-2 border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-sans text-[11px]">
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

            <div className="mb-10 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
                
                {tabs}

                <div className="flex items-center gap-2">
                    {activeFilter !== "vocabulary" && (
                    <button
                        onClick={() => setViewMode(viewMode === "list" ? "cards" : "list")}
                        className={cn(
                            "border border-[var(--color-border)] px-3 py-2 font-sans text-xs transition-colors",
                            viewMode === "cards"
                                ? "ui-selected"
                                : "bg-[var(--color-surface)] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
                        )}
                        aria-label={viewMode === "list" ? "Card view" : "List view"}
                    >
                        {viewMode === "list" ? "Cards" : "List"}
                    </button>
                    )}

                    <Dropdown
                        value={sortBy}
                        onChange={(value) => setSortBy(value as typeof sortBy)}
                        options={[
                            { value: "newest", label: "Newest First" },
                            { value: "oldest", label: "Oldest First" },
                            { value: "book", label: "By Book" },
                        ]}
                    />
                </div>
            </div>

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

            {activeFilter === "vocabulary" ? (
                filteredVocabularyTerms.length === 0 ? (
                    <div className="text-center py-16">
                        <p className="text-[color:var(--color-text-muted)]">
                            No terms found{searchQuery ? " matching your search" : ""}.
                        </p>
                    </div>
                ) : (
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
                                    <span className="text-sm text-[color:var(--color-text-primary)] truncate">{term.term}</span>
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
                )
            ) : filteredAnnotations.length === 0 ? (
                <div className="text-center py-16">
                    <p className="text-[color:var(--color-text-muted)]">
                        No {activeFilter === "all" ? "" : activeFilter} found
                        {searchQuery ? " matching your search" : ""}.
                    </p>
                </div>
            ) : viewMode === "cards" ? (
                <div className="flex flex-col items-center">
                    <div className="w-full max-w-[42rem]">
                        {annotationGroups.length === 0 ? (
                            <div className="text-center py-16">
                                <p className="text-[color:var(--color-text-muted)]">No annotations to display as cards.</p>
                            </div>
                        ) : (
                            <>
                                <div className="mb-4 sm:mb-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 px-1">
                                    <div className="flex items-center gap-2 min-w-0 w-full sm:w-auto">
                                        <span className="text-[10px] text-[color:var(--color-text-muted)] whitespace-nowrap">
                                            Deck {groupIndex + 1} of {annotationGroups.length}
                                        </span>
                                        <span className="text-[color:var(--color-border)] hidden sm:inline shrink-0">|</span>
                                        <span className="text-[10px] text-[color:var(--color-text-muted)] truncate min-w-0">
                                            {annotationGroups[groupIndex].title}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-1 self-end sm:self-auto">
                                        <button
                                            onClick={() => {
                                                if (groupIndex > 0) {
                                                    setGroupIndex(g => g - 1);
                                                    setCardIndex(0);
                                                }
                                            }}
                                            disabled={groupIndex === 0}
                                            className="inline-flex items-center gap-1 px-2 py-1.5 text-[10px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)] disabled:opacity-30 transition-colors touch-manipulation"
                                            aria-label={annotationGroups[groupIndex].isArticle ? "Previous article" : "Previous book"}
                                        >
                                            <ChevronsLeft className="w-3.5 h-3.5 sm:hidden" />
                                            <span className="hidden sm:inline">← Prev {annotationGroups[groupIndex].isArticle ? "Article" : "Book"}</span>
                                        </button>
                                        <button
                                            onClick={() => {
                                                if (groupIndex < annotationGroups.length - 1) {
                                                    setGroupIndex(g => g + 1);
                                                    setCardIndex(0);
                                                }
                                            }}
                                            disabled={groupIndex >= annotationGroups.length - 1}
                                            className="inline-flex items-center gap-1 px-2 py-1.5 text-[10px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)] disabled:opacity-30 transition-colors touch-manipulation"
                                            aria-label={annotationGroups[groupIndex].isArticle ? "Next article" : "Next book"}
                                        >
                                            <span className="hidden sm:inline">Next {annotationGroups[groupIndex].isArticle ? "Article" : "Book"} →</span>
                                            <ChevronsRight className="w-3.5 h-3.5 sm:hidden" />
                                        </button>
                                    </div>
                                </div>

                                {(() => {
                                    const group = annotationGroups[groupIndex];
                                    const ann = group.annotations[cardIndex];
                                    const source = group.source;
                                    const isArticle = group.isArticle;

                                    return (
                                        <div
                                            className="border border-[var(--color-border)] bg-[var(--color-surface)]"
                                            onTouchStart={handleCardTouchStart}
                                            onTouchEnd={handleCardTouchEnd}
                                        >
                                            <div className="px-4 sm:px-8 pt-4 sm:pt-8 pb-3 sm:pb-4 border-b border-[var(--color-border-subtle)] flex items-center justify-between min-h-0">
                                                <div className="flex items-center gap-2 text-[11px] text-[color:var(--color-text-secondary)] min-w-0">
                                                    {ann.color && (
                                                        <span className="w-2.5 h-2.5 shrink-0 border border-[var(--color-border)]" style={{ backgroundColor: HIGHLIGHT_SOLID_COLORS[ann.color] }} />
                                                    )}
                                                    <span className="truncate">{source?.title || "Unknown source"}</span>
                                                    {source?.author && <><span className="text-[color:var(--color-text-muted)] shrink-0">·</span><span className="truncate hidden sm:inline">{source.author}</span></>}
                                                </div>
                                            </div>

                                            <div className="px-4 sm:px-8 py-6 sm:py-10">
                                                {ann.selectedText && (
                                                    <blockquote
                                                        className="pl-4 sm:pl-5 leading-relaxed font-serif text-[1.05rem] sm:text-[1.25rem] text-[color:var(--color-text-primary)] border-l-[3px]"
                                                        style={{ borderColor: ann.color ? HIGHLIGHT_SOLID_COLORS[ann.color] : 'var(--color-accent)' }}
                                                    >
                                                        {ann.selectedText}
                                                    </blockquote>
                                                )}

                                                {ann.noteContent && (
                                                    <>
                                                        {ann.selectedText && <div className="my-4 sm:my-6 border-t border-[var(--color-border-subtle)]" />}
                                                        <p className="font-sans text-[12px] sm:text-[13px] leading-relaxed text-[color:var(--color-text-secondary)] whitespace-pre-wrap">
                                                            {ann.noteContent}
                                                        </p>
                                                    </>
                                                )}
                                            </div>

                                            <div className="px-4 sm:px-8 py-2.5 sm:py-3 border-t border-[var(--color-border-subtle)] flex items-center justify-between gap-1">
                                                <button
                                                    onClick={() => {
                                                        if (cardIndex > 0) {
                                                            setCardIndex(i => i - 1);
                                                        } else if (groupIndex > 0) {
                                                            setGroupIndex(g => g - 1);
                                                            setCardIndex(annotationGroups[groupIndex - 1].annotations.length - 1);
                                                        }
                                                    }}
                                                    disabled={groupIndex === 0 && cardIndex === 0}
                                                    className="inline-flex items-center gap-1 ui-btn text-[11px] disabled:opacity-30 touch-manipulation"
                                                    aria-label="Previous card"
                                                >
                                                    <ChevronLeft className="w-4 h-4 sm:hidden" />
                                                    <span className="hidden sm:inline">← Previous</span>
                                                </button>

                                                <div className="flex items-center gap-1 sm:gap-1.5 px-1 overflow-hidden">
                                                    {group.annotations.slice(0, Math.min(group.annotations.length, 20)).map((_, i) => {
                                                        const distance = Math.abs(i - cardIndex);
                                                        if (distance > 4 && group.annotations.length > 9) return null;
                                                        return (
                                                            <button
                                                                key={i}
                                                                onClick={() => setCardIndex(i)}
                                                                className="border-0 p-0 transition-[transform,background-color] duration-200 touch-manipulation"
                                                                style={{
                                                                    width: i === cardIndex ? '10px' : '6px',
                                                                    height: i === cardIndex ? '10px' : '6px',
                                                                    backgroundColor: i === cardIndex ? 'var(--color-accent)' : 'var(--color-border)',
                                                                }}
                                                                aria-label={`Go to card ${i + 1}`}
                                                            />
                                                        );
                                                    })}
                                                </div>

                                                <button
                                                    onClick={() => {
                                                        if (cardIndex < group.annotations.length - 1) {
                                                            setCardIndex(i => i + 1);
                                                        } else if (groupIndex < annotationGroups.length - 1) {
                                                            setGroupIndex(g => g + 1);
                                                            setCardIndex(0);
                                                        }
                                                    }}
                                                    disabled={groupIndex === annotationGroups.length - 1 && cardIndex >= group.annotations.length - 1}
                                                    className="inline-flex items-center gap-1 ui-btn text-[11px] disabled:opacity-30 touch-manipulation"
                                                    aria-label="Next card"
                                                >
                                                    <span className="hidden sm:inline">Next →</span>
                                                    <ChevronRight className="w-4 h-4 sm:hidden" />
                                                </button>
                                            </div>

                                            <div className="px-4 sm:px-8 py-2 border-t border-[var(--color-border-subtle)] flex items-center justify-center gap-2 sm:gap-3 flex-wrap">
                                                <span className="text-[10px] text-[color:var(--color-text-muted)] whitespace-nowrap">
                                                    {cardIndex + 1}/{group.annotations.length}
                                                    <span className="hidden sm:inline"> in this {isArticle ? "article" : "book"}</span>
                                                </span>
                                                <button
                                                    onClick={() => { handleEdit(ann.id); }}
                                                    className="inline-flex items-center gap-1 px-2 py-1 text-[10px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)] transition-colors touch-manipulation"
                                                    aria-label="Edit"
                                                >
                                                    <Pencil className="w-3 h-3 sm:hidden" />
                                                    <span className="hidden sm:inline">Edit</span>
                                                </button>
                                                <button
                                                    onClick={() => handleGoToSource(ann.bookId, ann.location)}
                                                    className="inline-flex items-center gap-1 px-2 py-1 text-[10px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)] transition-colors touch-manipulation"
                                                    aria-label={isArticle ? "Open article" : "Open book"}
                                                >
                                                    {isArticle ? <BookOpenText className="w-3 h-3 sm:hidden" /> : <BookOpen className="w-3 h-3 sm:hidden" />}
                                                    <span className="hidden sm:inline">{isArticle ? "Open Article" : "Open Book"}</span>
                                                </button>
                                                <button
                                                    onClick={() => handleDelete(ann.id)}
                                                    className="inline-flex items-center gap-1 px-2 py-1 text-[10px] text-[color:var(--color-error)] hover:text-[color:var(--color-error)] transition-colors touch-manipulation"
                                                    aria-label="Delete"
                                                >
                                                    <Trash2 className="w-3 h-3 sm:hidden" />
                                                    <span className="hidden sm:inline">Delete</span>
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })()}
                            </>
                        )}
                    </div>
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
        </div>
    );
}
