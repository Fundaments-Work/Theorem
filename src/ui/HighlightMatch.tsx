import { memo } from "react";
import { cn } from "../core/lib/utils";

export interface HighlightMatchProps {
    text: string;
    indices?: number[];
    query?: string;
    className?: string;
    matchClassName?: string;
}

export const HighlightMatch = memo(function HighlightMatch({
    text,
    indices,
    query,
    className,
    matchClassName = "font-bold text-[color:var(--color-accent)]",
}: HighlightMatchProps) {
    let activeIndices = indices;
    if ((!activeIndices || activeIndices.length === 0) && query && query.trim() && text) {
        const lowerText = text.toLowerCase();
        const lowerQuery = query.trim().toLowerCase();
        const subIdx = lowerText.indexOf(lowerQuery);
        if (subIdx !== -1) {
            activeIndices = Array.from({ length: lowerQuery.length }, (_, i) => subIdx + i);
        } else {
            const computed: number[] = [];
            let qIdx = 0;
            const textChars = Array.from(text);
            const queryChars = Array.from(lowerQuery);
            for (let i = 0; i < textChars.length && qIdx < queryChars.length; i++) {
                if (textChars[i].toLowerCase() === queryChars[qIdx]) {
                    computed.push(i);
                    qIdx++;
                }
            }
            if (qIdx === queryChars.length) {
                activeIndices = computed;
            }
        }
    }

    if (!activeIndices || activeIndices.length === 0 || !text) {
        return <span className={className}>{text}</span>;
    }

    const indexSet = new Set(activeIndices);
    const chars = Array.from(text);
    const segments: { text: string; isMatch: boolean }[] = [];

    let currentSegment = "";
    let currentIsMatch = false;

    for (let i = 0; i < chars.length; i++) {
        const char = chars[i];
        const isMatch = indexSet.has(i);

        if (i === 0) {
            currentSegment = char;
            currentIsMatch = isMatch;
        } else if (isMatch === currentIsMatch) {
            currentSegment += char;
        } else {
            segments.push({ text: currentSegment, isMatch: currentIsMatch });
            currentSegment = char;
            currentIsMatch = isMatch;
        }
    }
    if (currentSegment) {
        segments.push({ text: currentSegment, isMatch: currentIsMatch });
    }

    return (
        <span className={className}>
            {segments.map((seg, idx) =>
                seg.isMatch ? (
                    <span
                        key={idx}
                        className={cn("bg-transparent", matchClassName)}
                    >
                        {seg.text}
                    </span>
                ) : (
                    <span key={idx}>{seg.text}</span>
                )
            )}
        </span>
    );
});
