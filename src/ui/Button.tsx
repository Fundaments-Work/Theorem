import type { ComponentProps } from "react";
import { cn } from "../core/lib/utils";

export type ButtonVariant = "default" | "primary" | "ghost" | "danger";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
    default: "ui-btn",
    primary: "ui-btn-primary",
    ghost: "ui-btn-ghost",
    danger: "ui-btn-danger",
};

export interface ButtonProps extends ComponentProps<"button"> {
    /** `primary` is the single accent action on a screen; use it at most once per view. */
    variant?: ButtonVariant;
}

/**
 * The text button. Wraps the `ui-btn*` classes from design-tokens.css so a screen never
 * re-types them, and defaults `type="button"` so a button inside a form never submits it
 * by accident.
 */
export function Button({ variant = "default", className, type = "button", ...props }: ButtonProps) {
    return (
        <button
            type={type}
            className={cn(VARIANT_CLASS[variant], "disabled:opacity-50", className)}
            {...props}
        />
    );
}
