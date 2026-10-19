interface TheoremLogoProps {
    className?: string;
    size?: number;
}

/** The official Theorem mark, on the 24-unit grid. Same path as the brand kit's `theorem-logo.svg`. */
export function TheoremLogo({ className, size = 32 }: TheoremLogoProps) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={className}
            aria-hidden="true"
            focusable="false"
        >
            <path
                d="M 4 4 H 20 V 8 L 14 8 V 16 H 18 V 20 H 14 L 10 20 V 8 L 4 8 V 4 Z M 10 16 H 14 V 20 H 10 V 16 Z"
                fill="currentColor"
                fillRule="evenodd"
            />
        </svg>
    );
}

export default TheoremLogo;
