import { useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { OpdsEntry } from "../../../core/types";
import { CatalogBookCard } from "./CatalogBookCard";

export interface DiscoverCarouselProps {
    title: string;
    subtitle?: string;
    books: OpdsEntry[];
    inLibrary: (title: string) => boolean;
    isBusy: (id: string) => boolean;
    onSelectBook: (entry: OpdsEntry) => void;
    onGetBook: (entry: OpdsEntry) => void;
    /** "See all" for shelves that link to a full list. */
    onSeeAll?: () => void;
}

/** A titled, horizontally scrolling shelf of books. Used by Discover and by catalog "groups". */
export function DiscoverCarousel({
    title,
    subtitle,
    books,
    inLibrary,
    isBusy,
    onSelectBook,
    onGetBook,
    onSeeAll,
}: DiscoverCarouselProps) {
    const scrollContainerRef = useRef<HTMLDivElement>(null);

    const scroll = (direction: "left" | "right") => {
        scrollContainerRef.current?.scrollBy({ left: direction === "left" ? -400 : 400, behavior: "smooth" });
    };

    if (books.length === 0) return null;

    return (
        <section className="flex flex-col space-y-3.5">
            <div className="flex items-end justify-between gap-3">
                <div className="min-w-0">
                    <h2 className="truncate text-base text-[color:var(--color-text-primary)]">{title}</h2>
                    {subtitle && <p className="mt-0.5 text-xs text-[color:var(--color-text-muted)]">{subtitle}</p>}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                    {onSeeAll && (
                        <button
                            type="button"
                            onClick={onSeeAll}
                            className="px-2 py-1 text-xs text-[color:var(--color-text-secondary)] transition-colors hover:text-[color:var(--color-accent)]"
                        >
                            See all
                        </button>
                    )}
                    <div className="hidden items-center gap-1 sm:flex">
                        <button
                            type="button"
                            onClick={() => scroll("left")}
                            className="inline-flex h-7 w-7 items-center justify-center text-[color:var(--color-text-secondary)] transition-colors hover:text-[color:var(--color-accent)]"
                            aria-label="Scroll left"
                        >
                            <ChevronLeft className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            onClick={() => scroll("right")}
                            className="inline-flex h-7 w-7 items-center justify-center text-[color:var(--color-text-secondary)] transition-colors hover:text-[color:var(--color-accent)]"
                            aria-label="Scroll right"
                        >
                            <ChevronRight className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            </div>

            <div
                ref={scrollContainerRef}
                className="scrollbar-none -mx-1 flex items-start gap-6 overflow-x-auto overscroll-x-contain px-1 pb-4 pt-1"
            >
                {books.map((book) => (
                    <div key={book.id} className="w-[155px] shrink-0 sm:w-[175px] md:w-[190px]">
                        <CatalogBookCard
                            entry={book}
                            inLibrary={inLibrary(book.title)}
                            isBusy={isBusy(book.id)}
                            onSelect={onSelectBook}
                            onGet={onGetBook}
                        />
                    </div>
                ))}
            </div>
        </section>
    );
}
