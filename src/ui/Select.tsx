import type { ComponentProps } from "react";
import { cn } from "../core/lib/utils";

export interface SelectOption<T extends string = string> {
    value: T;
    label: string;
    disabled?: boolean;
}

export interface SelectProps<T extends string = string> extends Omit<ComponentProps<"select">, "onChange" | "value"> {
    value: T;
    options: readonly SelectOption<T>[];
    onChange: (value: T) => void;
}

/**
 * A native `<select>` with the `ui-input` border, so it keeps the platform picker (and its
 * accessibility) instead of re-implementing a listbox. Give it an `aria-label` or pair it with
 * a visible `<label>`.
 */
export function Select<T extends string = string>({ value, options, onChange, className, ...props }: SelectProps<T>) {
    return (
        <select
            value={value}
            onChange={(event) => onChange(event.target.value as T)}
            className={cn("ui-input", className)}
            {...props}
        >
            {options.map((option) => (
                <option key={option.value} value={option.value} disabled={option.disabled}>
                    {option.label}
                </option>
            ))}
        </select>
    );
}
