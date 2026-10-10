import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { ChevronRight } from "lucide-react";

export interface ContextMenuItem {
    id: string;
    label: string;
    icon?: React.ReactNode;
    shortcut?: string;
    onClick?: () => void;
    disabled?: boolean;
    separator?: boolean;
    danger?: boolean;
    /** Renders this entry as a submenu of `items` instead of a leaf action. */
    items?: ContextMenuItem[];
}

interface ContextMenuProps {
    items: ContextMenuItem[];
    children: React.ReactNode;
    className?: string;
}

const CONTENT_CLASS =
    "min-w-[var(--layout-dropdown-menu-min-width)] max-w-[var(--layout-dropdown-menu-max-width)] border border-[var(--color-border)] bg-[var(--color-surface)] py-1";

/**
 * Never grow past the space Radix says is available.
 *
 * Radix publishes `--radix-context-menu-content-available-height` (and the same
 * for sub-content). Without this cap a long menu — or a submenu opened from a
 * row near the bottom edge — extends past the viewport and its items become
 * unreachable; `overflow-y-auto` then makes the overflow scrollable instead.
 */
const HEIGHT_CLASS =
    "max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto overscroll-contain";
const ITEM_CLASS =
    "flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-[color:var(--color-text-primary)] outline-none cursor-pointer data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-[var(--color-surface-muted)] aria-[current]:bg-[var(--color-surface-muted)]";

/**
 * Portalled context menu.
 *
 * `depth` marks whether this is the root menu or a nested submenu; Radix requires
 * each nested level to portal into its own wrapper so it can position against the
 * viewport independently.
 */
function MenuItems({ items, depth }: { items: ContextMenuItem[]; depth: number }) {
    return (
        <>
            {items.map((item) => {
                if (item.separator) {
                    return (
                        <ContextMenuPrimitive.Separator
                            key={item.id}
                            className="mx-3 my-1 h-px bg-[var(--color-border)]"
                        />
                    );
                }

                const body = (
                    <>
                        {item.icon && <span className="flex-shrink-0 w-4 h-4">{item.icon}</span>}
                        <span className="flex-1">{item.label}</span>
                        {item.shortcut && (
                            <span className="ml-auto text-[0.6875rem] text-[color:var(--color-text-muted)]">
                                {item.shortcut}
                            </span>
                        )}
                        {item.items && (
                            <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[color:var(--color-text-muted)]" />
                        )}
                    </>
                );

                const shared = {
                    disabled: item.disabled,
                    className: ITEM_CLASS,
                };

                if (item.items) {
                    return (
                        <ContextMenuPrimitive.Sub key={item.id}>
                            <ContextMenuPrimitive.SubTrigger {...shared}>
                                {body}
                            </ContextMenuPrimitive.SubTrigger>
                            <ContextMenuPrimitive.Portal>
                                <ContextMenuPrimitive.SubContent
                                    className={`${CONTENT_CLASS} ${HEIGHT_CLASS} ${depth > 0 ? "z-[calc(var(--z-popover)+1)]" : "z-[var(--z-popover)]"}`}
                                    sideOffset={4}
                                    // Radix omits `side`/`align` from these props on
                                    // purpose (sub-content already opens right-aligned
                                    // to its trigger); `collisionPadding` keeps it off
                                    // the viewport edge and the notch on every side.
                                    collisionPadding={12}
                                >
                                    <MenuItems items={item.items} depth={depth + 1} />
                                </ContextMenuPrimitive.SubContent>
                            </ContextMenuPrimitive.Portal>
                        </ContextMenuPrimitive.Sub>
                    );
                }

                return (
                    <ContextMenuPrimitive.Item
                        key={item.id}
                        onSelect={item.onClick}
                        {...shared}
                    >
                        {body}
                    </ContextMenuPrimitive.Item>
                );
            })}
        </>
    );
}

export function ContextMenu({ items, children, className }: ContextMenuProps) {
    return (
        <ContextMenuPrimitive.Root>
            <ContextMenuPrimitive.Trigger asChild>
                <div className={className}>{children}</div>
            </ContextMenuPrimitive.Trigger>

            <ContextMenuPrimitive.Portal>
                {/* Portalled to <body>, so this must clear every piece of page chrome.
                    It was on --z-dropdown (50) + 1 = 51 while the mobile bottom nav sits
                    at --z-nav (110), so long-pressing a library row opened the menu
                    underneath the bottom bar. --z-popover is the token that means
                    "floats above the page"; modals sit lower but cannot be open at the
                    same time (Radix traps focus). */}
                <ContextMenuPrimitive.Content
                    className={`${CONTENT_CLASS} ${HEIGHT_CLASS} z-[var(--z-popover)]`}
                    collisionPadding={12}
                >
                    <MenuItems items={items} depth={0} />
                </ContextMenuPrimitive.Content>
            </ContextMenuPrimitive.Portal>
        </ContextMenuPrimitive.Root>
    );
}