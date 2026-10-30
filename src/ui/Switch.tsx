import { cn } from "../core/lib/utils";

export interface SwitchProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    /** The setting's name. Required: the switch itself has no text. */
    label: string;
    disabled?: boolean;
    id?: string;
}

/**
 * An on/off setting. It is a native checkbox with `role="switch"`, so it keeps keyboard
 * behaviour and is announced as a switch. The track is square (radius 0) like everything else.
 */
export function Switch({ checked, onChange, label, disabled, id }: SwitchProps) {
    const switchId = id ?? `switch-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    return (
        <button
            id={switchId}
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={cn(
                "relative inline-flex h-6 w-11 shrink-0 items-center border transition-colors disabled:opacity-50",
                checked
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)]"
                    : "border-[var(--color-border-strong)] bg-[var(--color-surface-muted)]",
            )}
        >
            <span
                aria-hidden="true"
                className={cn(
                    "block h-4 w-4 transition-transform",
                    checked
                        ? "translate-x-6 bg-[var(--color-accent-contrast)]"
                        : "translate-x-1 bg-[var(--color-text-muted)]",
                )}
            />
        </button>
    );
}
