import { useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { DiscoverSection } from "../../../core/services/DiscoverService";
import type { OpdsEntry } from "../../../core/types";
import { DiscoverBookCard } from "./DiscoverBookCard";

export interface DiscoverCarouselProps {
    section: DiscoverSection;
    onSelectBook?: (entry: OpdsEntry) => void;
}

export function DiscoverCarousel({
    section,
    onSelectBook,
}: DiscoverCarouselProps) {
    const scrollContainerRef = useRef<HTMLDivElement>(null);

    const scroll = (direction: "left" | "right") => {
        if (!scrollContainerRef.current) return;
        const offset = direction === "left" ? -400 : 400;
        scrollContainerRef.current.scrollBy({ left: offset, behavior: "smooth" });
    };

    if (!section.books || section.books.length === 0) return null;

    return (
        <section className="flex flex-col space-y-3.5">
            {/* Section Header with Title, Subtitle, and Arrows */}
            <div className="flex items-end justify-between">
                <div>
                    <h2 className="text-base text-[color:var(--color-text-primary)]">
                        {section.title}
                    </h2>
                    {section.subtitle && (
                        <p className="text-xs text-[color:var(--color-text-muted)] mt-0.5">
                            {section.subtitle}
                        </p>
                    )}
                </div>

                <div className="hidden sm:flex items-center gap-1 shrink-0">
                    <button
                        onClick={() => scroll("left")}
                        className="h-7 w-7 inline-flex items-center justify-center text-[color:var(--color-text-secondary)] transition-colors hover:text-[color:var(--color-accent)]"
                        aria-label="Scroll left"
                    >
                        <ChevronLeft className="h-4 w-4" />
                    </button>
                    <button
                        onClick={() => scroll("right")}
                        className="h-7 w-7 inline-flex items-center justify-center text-[color:var(--color-text-secondary)] transition-colors hover:text-[color:var(--color-accent)]"
                        aria-label="Scroll right"
                    >
                        <ChevronRight className="h-4 w-4" />
                    </button>
                </div>
            </div>

            {/* Horizontal Scroll Track */}
            <div
                ref={scrollContainerRef}
                className="flex items-start gap-6 overflow-x-auto pb-4 pt-1 -mx-1 px-1 scrollbar-none overscroll-x-contain"
            >
                {section.books.map((book) => (
                    <div key={book.id} className="w-[155px] sm:w-[175px] md:w-[190px] shrink-0">
                        <DiscoverBookCard entry={book} onSelect={onSelectBook} />
                    </div>
                ))}
            </div>
        </section>
    );
}
