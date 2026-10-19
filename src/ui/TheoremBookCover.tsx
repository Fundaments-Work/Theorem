import { useState } from "react";
import { cn } from "../core/lib/utils";
import { isSafeImageUrl } from "../core/lib/url-safety";

export interface TheoremBookCoverProps {
    title: string;
    author?: string;
    coverUrl?: string | null;
    className?: string;
    badge?: string;
}

export function TheoremBookCover({
    title,
    author,
    coverUrl,
    className,
    badge,
}: TheoremBookCoverProps) {
    const [imageError, setImageError] = useState(false);

    // Filter out Gutenberg's tiny 16x16 / 22x22 placeholder base64 icons
    const isTinyPlaceholderIcon =
        typeof coverUrl === "string" &&
        coverUrl.startsWith("data:image/png;base64") &&
        coverUrl.length < 5000;

    // Only render image sources with a known-safe scheme; catalogs and book
    // metadata can hand us anything. Unsafe URLs fall back to the drawn cover.
    const imageSrc =
        typeof coverUrl === "string" && isSafeImageUrl(coverUrl) && !isTinyPlaceholderIcon && !imageError
            ? coverUrl
            : null;

    if (imageSrc) {
        return (
            <div className={cn("relative aspect-[2/3] w-full overflow-hidden bg-[var(--color-surface-muted)]", className)}>
                <img
                    src={imageSrc}
                    alt={title}
                    loading="lazy"
                    onError={() => setImageError(true)}
                    className="h-full w-full object-cover group-hover:scale-105 transition-transform duration-300 ease-out"
                />
            </div>
        );
    }

    const cleanTitle = (title || "Untitled").trim();
    const cleanAuthor = (author || "Public Domain").trim();

    return (
        <div
            className={cn(
                "relative aspect-[2/3] w-full overflow-hidden p-3.5 sm:p-4 select-none flex flex-col justify-between",
                "bg-[#0e0e11] text-[#f4f4f5] border border-[#27272a] transition-transform duration-200",
                className
            )}
        >
            {/* Matte spine accent & inner frame */}
            <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-[#27272a] opacity-80" />
            <div className="absolute inset-2 border border-[#27272a] pointer-events-none opacity-60" />

            {/* Top Series / Badge Header */}
            <div className="relative z-10 text-center pt-1 min-h-[14px]">
                {badge ? (
                    <span className="text-[8px] sm:text-[9px] text-[#71717a]">
                        {badge}
                    </span>
                ) : (
                    <div className="w-6 h-[1px] mx-auto mt-2 bg-[#3f3f46] opacity-40" />
                )}
            </div>

            {/* Centered Title & Author Block */}
            <div className="relative z-10 flex flex-col items-center justify-center my-auto py-2 text-center">
                <h3 className="font-serif text-xs sm:text-sm leading-snug line-clamp-4 px-1 text-white">
                    {cleanTitle}
                </h3>
                <div className="w-5 h-[1px] mx-auto my-2 bg-[#3f3f46] opacity-60" />
                <p className="text-[9px] sm:text-[10px] truncate max-w-[90%] text-[#a1a1aa]">
                    {cleanAuthor}
                </p>
            </div>

            {/* Bottom Emblem */}
            <div className="relative z-10 flex items-center justify-center gap-1.5 pb-1">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <rect x="0" y="0" width="3" height="24" fill="#71717a" opacity="0.8" />
                    <rect x="0" y="10.5" width="15" height="3" fill="#71717a" opacity="0.8" />
                </svg>
                <span className="text-[7px] text-[#71717a] opacity-80">
                    THEOREM
                </span>
            </div>
        </div>
    );
}
