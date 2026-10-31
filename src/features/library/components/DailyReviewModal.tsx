import { useMemo, useCallback } from "react";
import { Modal, ModalHeader, ModalBody } from "../../../ui";
import { useLibraryStore, useRssStore } from "../../../core/store";
import { selectDailyReviewCards, markDailyReviewCompleted } from "../../../core/lib/daily-review";
import { resolveAnnotationSource, type ResolvedAnnotationSource } from "../../../core/lib/annotation-source";
import { ReviewCardStack } from "./ReviewCardStack";

export interface DailyReviewModalProps {
    isOpen: boolean;
    onClose: () => void;
    onGoToSource: (sourceId: string, location?: string) => void;
}

export function DailyReviewModal({
    isOpen,
    onClose,
    onGoToSource,
}: DailyReviewModalProps) {
    const annotations = useLibraryStore((s) => s.annotations);
    const getBook = useLibraryStore((s) => s.getBook);
    const articles = useRssStore((s) => s.articles);
    const feeds = useRssStore((s) => s.feeds);

    const dailyCards = useMemo(() => {
        return selectDailyReviewCards(annotations);
    }, [annotations]);

    const sources = useMemo(() => {
        const lookup = new Map<string, ResolvedAnnotationSource>();
        for (const card of dailyCards) {
            const resolved = resolveAnnotationSource(card.bookId, getBook, articles, feeds, card.chapterTitle);
            if (resolved) {
                lookup.set(card.bookId, resolved);
            }
        }
        return lookup;
    }, [dailyCards, getBook, articles, feeds]);

    const handleComplete = useCallback(() => {
        markDailyReviewCompleted(undefined, dailyCards.map((c) => c.id));
    }, [dailyCards]);

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            size="xl"
            className="w-[calc(100vw-2rem)] sm:w-[42rem] md:w-[46rem] max-w-[var(--container-width-md)]"
            ariaLabel="Daily Review"
        >
            <ModalHeader title="Daily Review" onClose={onClose} showCloseButton />
            <ModalBody className="p-4 sm:p-8">
                <ReviewCardStack
                    cards={dailyCards}
                    sources={sources}
                    onComplete={handleComplete}
                    onGoToSource={onGoToSource}
                    onClose={onClose}
                />
            </ModalBody>
        </Modal>
    );
}
