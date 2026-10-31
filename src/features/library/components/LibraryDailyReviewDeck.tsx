import { memo, useState, useMemo, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { X } from "lucide-react";
import { useLibraryStore, useUIStore, useRssStore } from "../../../core/store";
import { localDateKey } from "../../../core/lib/date-keys";
import {
    resolveAnnotationSource,
    navigateToAnnotationSource,
    type ResolvedAnnotationSource,
} from "../../../core/lib/annotation-source";
import {
    getDailyReviewStatus,
    getDailyReviewDismissal,
    dismissDailyReview,
    DAILY_REVIEW_CHANGED_EVENT,
    selectDailyReviewCards,
    markDailyReviewCompleted,
} from "../../../core/lib/daily-review";
import { useAndroidBackButton } from "../../../core/lib/env";
import { ReviewCardStack } from "./ReviewCardStack";


export interface LibraryDailyReviewDeckProps {
    showDailyHighlight: boolean;
    selectedShelf: unknown;
    showFavoritesOnly: boolean;
    isSelecting: boolean;
}

export const LibraryDailyReviewDeck = memo(function LibraryDailyReviewDeck({
    showDailyHighlight,
    selectedShelf,
    showFavoritesOnly,
    isSelecting,
}: LibraryDailyReviewDeckProps) {
    const isLibraryRoute = useUIStore(state => state.currentRoute === "library");
    const [today, setToday] = useState(localDateKey);
    const [dismissedDate, setDismissedDate] = useState(getDailyReviewDismissal);
    const dismissed = dismissedDate === today;
    const [dailyReviewStatus, setDailyReviewStatus] = useState(() => getDailyReviewStatus(today));
    useEffect(() => {
        const refresh = () => {
            const date = localDateKey();
            setToday(date);
            setDismissedDate(getDailyReviewDismissal());
            setDailyReviewStatus(getDailyReviewStatus(date));
        };
        window.addEventListener("storage", refresh);
        window.addEventListener("focus", refresh);
        window.addEventListener(DAILY_REVIEW_CHANGED_EVENT, refresh);
        const timer = window.setInterval(refresh, 60_000);
        return () => {
            window.removeEventListener("storage", refresh);
            window.removeEventListener("focus", refresh);
            window.removeEventListener(DAILY_REVIEW_CHANGED_EVENT, refresh);
            window.clearInterval(timer);
        };
    }, []);

    const annotations = useLibraryStore((state) =>
        dismissed || !showDailyHighlight ? null : state.annotations
    );
    const bookCount = useLibraryStore((state) => state.books.length);
    const getBook = useLibraryStore((state) => state.getBook);
    const rssArticles = useRssStore((state) => state.articles);
    const rssFeeds = useRssStore((state) => state.feeds);

    const setPendingReaderLocation = useUIStore((state) => state.setPendingReaderLocation);
    const setRoute = useUIStore((state) => state.setRoute);
    const openArticleInReader = useRssStore((state) => state.openArticleInReader);
    const getArticle = useRssStore((state) => state.getArticle);
    const loadArticle = useRssStore((state) => state.loadArticle);
    const hasBook = useCallback((id: string) => !!useLibraryStore.getState().getBook(id), []);


    const dailyCards = useMemo(() => {
        if (!annotations || annotations.length === 0 || dailyReviewStatus.completed) {
            return [];
        }
        return selectDailyReviewCards(annotations, today);
    }, [annotations, today, dailyReviewStatus.completed]);

    const sources = useMemo(() => {
        const lookup = new Map<string, ResolvedAnnotationSource>();
        for (const card of dailyCards) {
            if (!lookup.has(card.bookId)) {
                const src = resolveAnnotationSource(card.bookId, getBook, rssArticles, rssFeeds, card.chapterTitle);
                if (src) lookup.set(card.bookId, src);
            }
        }
        return lookup;
    }, [dailyCards, getBook, bookCount, rssArticles, rssFeeds]);

    const handleDismiss = useCallback(() => {
        try {
            dismissDailyReview(today);
        } catch {
            toast.error("Could not save dismissal. Daily Review may return after restarting.");
        }
        setDismissedDate(today);
    }, [today]);

    const handleComplete = useCallback(() => {
        markDailyReviewCompleted(today, dailyCards.map(card => card.id));
        setDailyReviewStatus({ date: today, completed: true, reviewedCardIds: dailyCards.map(card => card.id) });
    }, [today, dailyCards]);

    const handleGoToSource = useCallback((sourceId: string, location?: string) => {
        const ann = annotations?.find(
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

    useAndroidBackButton(
        useCallback(() => {
            if (isLibraryRoute && !dismissed && showDailyHighlight && !dailyReviewStatus.completed && dailyCards.length > 0) {
                handleDismiss();
                return true;
            }
            return false;
        }, [isLibraryRoute, dismissed, showDailyHighlight, dailyReviewStatus.completed, dailyCards.length, handleDismiss])
    );

    if (
        !isLibraryRoute ||
        dismissed ||
        !showDailyHighlight ||
        dailyReviewStatus.completed ||
        dailyCards.length === 0 ||
        selectedShelf ||
        showFavoritesOnly ||
        isSelecting
    ) {
        return null;
    }

    return createPortal(
        <div
            className="fixed inset-0 z-[var(--z-modal)] bg-[var(--color-background)] flex flex-col items-center justify-start p-4 sm:p-6 overflow-x-hidden overflow-y-auto overscroll-contain [content-visibility:auto] motion-safe:animate-fade-in"
            role="dialog"
            aria-modal="true"
            aria-label="Daily Review"
        >
            <div className="relative w-full shrink-0 max-w-[38rem] sm:max-w-[42rem] mx-auto my-auto px-1">
                <button
                    type="button"
                    onClick={handleDismiss}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="absolute top-3 right-3 sm:top-4 sm:right-4 z-20 p-2 rounded-full text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface)]/80 transition-colors touch-manipulation cursor-pointer shadow-xs"
                    title="Dismiss for today (Esc)"
                    aria-label="Dismiss for today"
                >
                    <X className="w-4 h-4" />
                </button>

                <ReviewCardStack
                    cards={dailyCards}
                    sources={sources}
                    onComplete={handleComplete}
                    onGoToSource={handleGoToSource}
                    onClose={handleDismiss}
                    completionTitle="Daily Review Complete"
                    completionDescription={`You reviewed all ${dailyCards.length} daily highlights. A fresh deck will be curated tomorrow.`}
                    completionActionLabel="Done"
                    onCompletionAction={handleDismiss}
                />
            </div>
        </div>,
        document.body
    );
});
