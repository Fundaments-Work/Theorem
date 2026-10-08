import React from "react";

interface MomoIconProps extends React.SVGProps<SVGSVGElement> {
    className?: string;
}

/**
 * Momo (dumpling) icon matching Lucide SVG standards and Theorem design tokens.
 * Inherits `currentColor` for seamless theme adapting.
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
            {/* Dumpling pouch contour */}
            <path d="M3.5 14C3.5 18.5 8 20.5 12 20.5C16 20.5 20.5 18.5 20.5 14C20.5 8.5 16.5 5 12 5C7.5 5 3.5 8.5 3.5 14Z" />
            {/* Top pleat folds */}
            <path d="M12 5V13" />
            <path d="M8.5 6.8C9.5 9 10 11.2 10 13" />
            <path d="M15.5 6.8C14.5 9 14 11.2 14 13" />
            <path d="M5.8 10C7.2 11.5 8.2 13 8.5 14" />
            <path d="M18.2 10C16.8 11.5 15.8 13 15.5 14" />
        </svg>
    );
}
