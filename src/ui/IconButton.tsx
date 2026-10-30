import type { ComponentProps } from "react";
import { cn } from "../core/lib/utils";

export interface IconButtonProps extends Omit<ComponentProps<"button">, "aria-label" | "children"> {
    /** What the button does. Required: an icon alone is not a name for a screen reader. */
    label: string;
    /** The icon element, e.g. `<Search className="h-4 w-4" />`. */
    icon: React.ReactNode;
}

/**
 * A bare icon: no box, no fill. Hover and the pressed state are the accent colour, never a
 * background (design-system rule). The visible tooltip comes from `title`.
 */
export function IconButton({ label, icon, className, type = "button", title, ...props }: IconButtonProps) {
    return (
        <button
            type={type}
            aria-label={label}
            title={title ?? label}
            className={cn("ui-icon-btn", className)}
            {...props}
        >
            {icon}
        </button>
    );
}
