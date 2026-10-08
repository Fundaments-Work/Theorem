import React from "react";

interface MomoIconProps extends React.SVGProps<SVGSVGElement> {
    className?: string;
}

/**
 * Momo (dumpling steamer) icon based on Flaticon asset 18805151.
 * Matches Lucide icon grid standards (24x24, 2px stroke, round caps/joins)
 * to ensure crisp, bold readability at 16x16 (w-4 h-4) and seamless theme styling.
 */
export function MomoIcon({ className, ...props }: MomoIconProps) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            aria-hidden="true"
            {...props}
        >
            {/* Steamer lid with handle tilted open */}
            <path d="M9.5 2a2 2 0 0 1 2.5.2" />
            <ellipse cx="12" cy="5.2" rx="8.5" ry="2" transform="rotate(-15 12 5.2)" />
            {/* Two plump momos with gathered top knots */}
            <path d="M5.5 13.5c0-2.5 1.8-4 3.8-4 1.5 0 2.8.9 3.2 2.3" />
            <path d="M11.5 12.5c.4-1.8 1.7-3 3.5-3 2 0 3.8 1.5 3.8 4" />
            {/* Top pleat folds */}
            <path d="M9.3 9.5v2" />
            <path d="M15 9.5v2" />
            {/* Steam puffs */}
            <path d="M19.5 6.5c.8-.4 1.6-.3 2.2.2" />
            <path d="M20 8.8c.6-.2 1.4 0 1.8.5" />
            {/* Steamer basket base and rim */}
            <path d="M3 14v4.5c0 2 4 3.5 9 3.5s9-1.5 9-3.5V14" />
            <path d="M3 14c0 1.6 4 2.8 9 2.8s9-1.2 9-2.8" />
        </svg>
    );
}
