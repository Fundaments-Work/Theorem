import type { ComponentProps, ElementType } from "react";
import { cn } from "../core/lib/utils";

export interface CardProps extends ComponentProps<"div"> {
    /** Render as another element, e.g. `as="section"`. */
    as?: ElementType;
    /** `section` draws a framed block; `plain` only groups content. */
    variant?: "section" | "plain";
}

/** A framed surface (the `ui-section` class). The one shared container for grouped content. */
export function Card({ as: Tag = "div", variant = "section", className, ...props }: CardProps) {
    return <Tag className={cn(variant === "section" ? "ui-section" : "", className)} {...props} />;
}
