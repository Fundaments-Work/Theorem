import type { ComponentProps } from "react";
import { cn } from "../core/lib/utils";

export interface ChipProps extends ComponentProps<"button"> {
    /** Selected state. Rendered as `aria-pressed`, which the design tokens style as selected. */
    active?: boolean;
}

/** A filter or option chip. Selected is a tonal step with an accent rule, never a lime fill. */
export function Chip({ active = false, className, type = "button", ...props }: ChipProps) {
    return (
        <button
            type={type}
            aria-pressed={active}
            className={cn("ui-chip-btn", className)}
            {...props}
        />
    );
}
