
import { useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { cn } from "../core/lib/utils";

export interface DropdownOption<T = string> {
    value: T;
    label: string;
    disabled?: boolean;
}

export interface DropdownProps<T = string> {
    id?: string;
    "aria-label"?: string;
    options: DropdownOption<T>[];
    value?: T;
    defaultValue?: T;
    onChange?: (value: T) => void;
    placeholder?: string;
    disabled?: boolean;
    size?: "sm" | "md" | "lg";
    variant?: "default" | "filled" | "outlined";
    className?: string;
    dropdownClassName?: string;
    align?: "left" | "right";
    openUp?: boolean;
    showCheckmark?: boolean;
}

const sizeClasses: Record<string, string> = {
    sm: "px-3 py-1.5 text-sm",
    md: "px-4 py-2 text-sm",
    lg: "px-4 py-2.5 text-base",
};

const variantClasses: Record<string, string> = {
    default: "bg-[var(--color-surface)] border-2 border-[var(--color-border)]",
    filled: "bg-[var(--color-surface-muted)] border-2 border-[var(--color-border)]",
    outlined: "bg-transparent border-2 border-[var(--color-border)]",
};

export function Dropdown<T extends string = string>({
    id,
    "aria-label": ariaLabel,
    options,
    value,
    defaultValue,
    onChange,
    placeholder = "Select...",
    disabled = false,
    size = "md",
    variant = "default",
    className,
    dropdownClassName,
    align = "left",
    openUp = false,
    showCheckmark = true,
}: DropdownProps<T>) {
    const [internalValue, setInternalValue] = useState<T | undefined>(defaultValue);
    const selectedValue = value !== undefined ? value : internalValue;
    const selectedOption = options.find((opt) => opt.value === selectedValue);

    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild disabled={disabled}>
                <button
                    id={id}
                    aria-label={ariaLabel}
                    type="button"
                    className={cn(
                        "flex items-center justify-between gap-2 w-full cursor-pointer",
                        "focus-visible:outline-2 focus-visible:outline-[color:var(--color-focus-ring)] focus-visible:outline-offset-2",
                        "text-[color:var(--color-text-primary)]",
                        "transition-colors duration-200",
                        "disabled:opacity-50 disabled:cursor-not-allowed",
                        sizeClasses[size],
                        variantClasses[variant],
                        className,
                    )}
                >
                    <span className={cn("truncate", !selectedOption && "text-[color:var(--color-text-muted)]")}>
                        {selectedOption?.label || placeholder}
                    </span>
                    <ChevronDown className="w-4 h-4 text-[color:var(--color-text-muted)] flex-shrink-0 transition-transform duration-200 data-[state=open]:rotate-180" />
                </button>
            </DropdownMenu.Trigger>

            <DropdownMenu.Portal>
                <DropdownMenu.Content
                    side={openUp ? "top" : "bottom"}
                    align={align === "right" ? "end" : "start"}
                    sideOffset={4}
                    collisionPadding={16}
                    className={cn(
                        "z-[calc(var(--z-dropdown)+1)] min-w-[--radix-dropdown-menu-trigger-width]",
                        "border border-[var(--color-border)] bg-[var(--color-surface)] shadow-md",
                        "py-1 max-h-60 overflow-y-auto",
                        dropdownClassName,
                    )}
                >
                    {options.map((option) => {
                        const isSelected = selectedValue === option.value;
                        return (
                            <DropdownMenu.Item
                                key={String(option.value)}
                                disabled={option.disabled}
                                onSelect={() => {
                                    if (!(value !== undefined)) setInternalValue(option.value);
                                    onChange?.(option.value);
                                }}
                                className={cn(
                                    "flex items-center justify-between gap-3 px-3 py-2 text-left text-sm",
                                    "outline-none cursor-pointer transition-colors",
                                    "data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed",
                                    isSelected
                                        ? "bg-[var(--color-accent-light)] text-[color:var(--color-accent)]"
                                        : "text-[color:var(--color-text-secondary)] data-[highlighted]:bg-[var(--color-surface-muted)] data-[highlighted]:text-[color:var(--color-text-primary)]",
                                )}
                            >
                                <span className="truncate">{option.label}</span>
                                {showCheckmark && isSelected && <Check className="w-4 h-4 flex-shrink-0" />}
                            </DropdownMenu.Item>
                        );
                    })}
                    {options.length === 0 && (
                        <div className="px-3 py-2 text-sm text-[color:var(--color-text-muted)]">No options available</div>
                    )}
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}
