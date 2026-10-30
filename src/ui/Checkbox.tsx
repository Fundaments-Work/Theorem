import type { ComponentProps } from "react";
import { cn } from "../core/lib/utils";

export interface CheckboxProps extends Omit<ComponentProps<"input">, "type"> {
    /** The visible text. Required: a bare box is not a name for a screen reader. */
    label: string;
}

/** A labelled checkbox. The input keeps native semantics; the label is the click target. */
export function Checkbox({ label, className, id, ...props }: CheckboxProps) {
    const checkboxId = id ?? `checkbox-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    return (
        <label htmlFor={checkboxId} className={cn("inline-flex cursor-pointer items-center gap-2 text-sm text-[color:var(--color-text-secondary)]", className)}>
            <input id={checkboxId} type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" {...props} />
            {label}
        </label>
    );
}
