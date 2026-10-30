import { useId, type ReactNode } from "react";
import { cn } from "../core/lib/utils";

export interface TabItem<T extends string = string> {
    id: T;
    label: ReactNode;
    /** Optional count or badge shown after the label. */
    count?: number;
}

export interface TabsProps<T extends string = string> {
    items: readonly TabItem<T>[];
    value: T;
    onChange: (id: T) => void;
    /** Accessible name for the tab list, e.g. "Workbench sections". */
    label: string;
    className?: string;
    /** Base for the tab/panel ids; pass it to `TabPanel` so the two are wired together. */
    idBase?: string;
}

/** Ids a `TabPanel` must use to match the tab it belongs to. */
export function tabIds(idBase: string, tabId: string) {
    return { tabId: `${idBase}-tab-${tabId}`, panelId: `${idBase}-panel-${tabId}` };
}

/**
 * A row of tabs with the ARIA tab pattern: `role="tablist"`, arrow keys move between tabs,
 * Home/End jump to the ends. Screens that keep their panels mounted use this with `hidden`
 * panels; the panels themselves stay in the screen, not here.
 */
export function Tabs<T extends string = string>({ items, value, onChange, label, className, idBase }: TabsProps<T>) {
    const generated = useId();
    const id = idBase ?? generated;

    function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
        const index = items.findIndex((item) => item.id === value);
        if (index < 0) return;
        let next = index;
        if (event.key === "ArrowRight") next = (index + 1) % items.length;
        else if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = items.length - 1;
        else return;
        event.preventDefault();
        onChange(items[next].id);
        const tab = event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next];
        tab?.focus();
    }

    return (
        <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className={cn("flex items-center gap-1", className)}>
            {items.map((item) => {
                const selected = item.id === value;
                return (
                    <button
                        key={item.id}
                        id={`${id}-tab-${item.id}`}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        aria-controls={`${id}-panel-${item.id}`}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => onChange(item.id)}
                        className={cn(
                            "ui-tab-btn",
                            selected && "ui-selected",
                        )}
                    >
                        {item.label}
                        {item.count !== undefined && <span className="ml-1.5 font-mono text-[10px]">{item.count}</span>}
                    </button>
                );
            })}
        </div>
    );
}

/**
 * The panel a `Tabs` tab controls, wired by `tabIds()`. `hidden` keeps it mounted, so state
 * and scroll survive a tab switch (the app's route keep-alive relies on that).
 */
export function TabPanel({
    children,
    idBase,
    tab,
    active,
}: {
    children: ReactNode;
    idBase: string;
    tab: string;
    active: boolean;
}) {
    const ids = tabIds(idBase, tab);
    return (
        <div role="tabpanel" id={ids.panelId} aria-labelledby={ids.tabId} hidden={!active}>
            {children}
        </div>
    );
}
