import type { ComponentProps } from "react";
import { cn } from "../core/lib/utils";

export type TextInputProps = ComponentProps<"input">;

/**
 * A single-line text field. The `ui-input` border clears 3:1 contrast (WCAG 1.4.11), so keep
 * it rather than drawing a lighter one. Pair it with a visible `<label>` or an `aria-label`.
 */
export function TextInput({ className, type = "text", ...props }: TextInputProps) {
    return <input type={type} className={cn("ui-input", className)} {...props} />;
}
