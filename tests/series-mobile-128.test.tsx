import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { SeriesGroupHeader } from "../src/features/library/components/SeriesGroupHeader";
import { AssignSeriesModal } from "../src/features/library/components/modals/AssignSeriesModal";
import { useLibraryStore } from "../src/core/store";
import type { Book } from "../src/core/types";

// @ts-expect-error React act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function makeBook(over: Partial<Book> = {}): Book {
    return {
        id: "b1",
        title: "Dune",
        author: "Frank Herbert",
        format: "epub",
        fileSize: 1,
        readingTime: 0,
        addedAt: new Date(),
        tags: [],
        series: "Dune",
        seriesIndex: 1,
        ...over,
    } as unknown as Book;
}

const mounted: Root[] = [];

function render(ui: React.ReactElement) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push(root);
    act(() => {
        root.render(ui);
    });
    return container;
}

afterEach(() => {
    // Radix portals live on document.body, so unmounting is required to keep
    // later queries from seeing previous tests' markup.
    while (mounted.length) {
        const root = mounted.pop()!;
        act(() => root.unmount());
    }
    document.body.innerHTML = "";
});

/** Radix Dialog renders into a portal on document.body, so modal queries go there. */
function q<T extends Element = HTMLElement>(sel: string): T | null {
    return document.body.querySelector<T>(sel);
}

function qa<T extends Element = HTMLElement>(sel: string): T[] {
    return Array.from(document.body.querySelectorAll<T>(sel));
}

/** min-w-11 / min-h-11 in Tailwind = 2.75rem = 44px (the touch-target minimum). */
const TOUCH_MIN_PX = 44;

function hasTouchMin(cls: string) {
    return cls.includes("min-w-11") && cls.includes("min-h-11");
}

describe("series header touch targets (#128)", () => {
    it("keeps the Edit control at a 44px target when every volume is read", () => {
        // Regression: reading the last unread volume removes the Continue button,
        // leaving only a 26px pencil icon that reads as unresponsive on phones.
        const group = [makeBook({ id: "b1", completedAt: new Date() })];
        const container = render(
            <SeriesGroupHeader
                seriesName="Dune"
                group={group}
                onContinue={() => {}}
                onEdit={() => {}}
            />,
        );

        const edit = container.querySelector<HTMLButtonElement>('button[aria-label="Edit series Dune"]');
        expect(edit).toBeTruthy();
        expect(hasTouchMin(edit!.className)).toBe(true);
        expect(edit!.className).toContain("touch-manipulation");

        // The Continue button is gone in this state, confirming Edit is the sole target.
        const cont = container.querySelector<HTMLButtonElement>('button[aria-label^="Continue reading"]');
        expect(cont).toBeNull();
    });

    it("keeps Continue tappable at 44px height while volumes remain unread", () => {
        const group = [
            makeBook({ id: "b1", completedAt: new Date() }),
            makeBook({ id: "b2", title: "Dune Messiah", seriesIndex: 2 }),
        ];
        const onContinue = vi.fn();
        const container = render(
            <SeriesGroupHeader seriesName="Dune" group={group} onContinue={onContinue} onEdit={() => {}} />,
        );

        const cont = container.querySelector<HTMLButtonElement>('button[aria-label^="Continue reading"]');
        expect(cont).toBeTruthy();
        expect(cont!.className).toContain("min-h-11");
        // Desktop density restored from sm upwards.
        expect(cont!.className).toContain("sm:min-h-0");

        act(() => cont!.click());
        expect(onContinue).toHaveBeenCalledTimes(1);
        expect(onContinue.mock.calls[0][0].id).toBe("b2");
    });

    it("fires onEdit from the keyboard-accessible labelled button", () => {
        const onEdit = vi.fn();
        const group = [makeBook()];
        const container = render(
            <SeriesGroupHeader seriesName="Dune" group={group} onContinue={() => {}} onEdit={onEdit} />,
        );
        const edit = container.querySelector<HTMLButtonElement>('button[aria-label="Edit series Dune"]')!;
        act(() => edit.click());
        expect(onEdit).toHaveBeenCalledTimes(1);
    });

    it("handles an empty group without dividing by zero", () => {
        const container = render(
            <SeriesGroupHeader seriesName="Empty" group={[]} onContinue={() => {}} onEdit={() => {}} />,
        );
        expect(container.textContent).toContain("(0 vols.)");
        // No unread book -> no Continue button, but Edit is still reachable.
        expect(container.querySelector('button[aria-label^="Continue reading"]')).toBeNull();
        expect(container.querySelector('button[aria-label="Edit series Empty"]')).toBeTruthy();
    });

    it("pluralises the volume count and shows Completed only when all are read", () => {
        const single = render(
            <SeriesGroupHeader
                seriesName="Dune"
                group={[makeBook({ completedAt: new Date() })]}
                onContinue={() => {}}
                onEdit={() => {}}
            />,
        );
        expect(single.textContent).toContain("(1 vol.)");
        expect(single.textContent).toContain("Completed");

        const partial = render(
            <SeriesGroupHeader
                seriesName="Dune"
                group={[makeBook({ completedAt: new Date() }), makeBook({ id: "b2" })]}
                onContinue={() => {}}
                onEdit={() => {}}
            />,
        );
        expect(partial.textContent).toContain("(2 vols.)");
        expect(partial.textContent).toContain("1/2 read (50%)");
        expect(partial.textContent).not.toContain("Completed");
    });
});

describe("AssignSeriesModal mobile layout (#128)", () => {
    beforeEach(() => {
        useLibraryStore.setState({
            books: [
                makeBook({ id: "b1", title: "Dune", seriesIndex: 1 }),
                makeBook({ id: "b2", title: "Dune Messiah", seriesIndex: 2 }),
            ],
            collections: [],
            readingProgress: {},
        } as never);
    });

    it("wraps content in a shrinkable flex column so the footer cannot be clipped", () => {
        // Without `flex h-full min-h-0 flex-col` the form is a block box: ModalBody's
        // `flex-1`/`overflow-y-auto` resolve against nothing, the body grows to full
        // content height, and the dialog's overflow-hidden clips the Save button away.
        render(<AssignSeriesModal isOpen onClose={() => {}} bookIds={["b1", "b2"]} />);
        const form = q("form")!;
        expect(form).toBeTruthy();
        expect(form.className).toContain("flex");
        expect(form.className).toContain("min-h-0");
        expect(form.className).toContain("flex-col");
        expect(form.className).toContain("h-full");
    });

    it("renders a submit control inside the form (never clipped out of the layout)", () => {
        render(<AssignSeriesModal isOpen onClose={() => {}} bookIds={["b1", "b2"]} />);
        const form = q("form")!;
        const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
        expect(submit).toBeTruthy();
        expect(submit!.textContent).toContain("Save Series");
    });

    it("renders a volume input per book", () => {
        render(<AssignSeriesModal isOpen onClose={() => {}} bookIds={["b1", "b2"]} />);
        expect(qa<HTMLInputElement>('input[type="number"]').length).toBe(2);
    });

    it("caps the volumes list by viewport height so tall lists stay scrollable", () => {
        render(<AssignSeriesModal isOpen onClose={() => {}} bookIds={["b1", "b2"]} />);
        const list = q(".overscroll-contain")!;
        expect(list).toBeTruthy();
        expect(list.className).toContain("max-h-[38vh]");
        expect(list.className).toContain("sm:max-h-[280px]");
    });

    it("stacks footer actions on phones so no control is squeezed", () => {
        render(<AssignSeriesModal isOpen onClose={() => {}} bookIds={["b1"]} />);
        const stack = qa<HTMLDivElement>('div[class*="flex-col-reverse"]')[0];
        expect(stack).toBeTruthy();
        expect(stack.className).toContain("sm:flex-row");
        for (const b of qa<HTMLButtonElement>("button")) {
            if (b.textContent?.includes("Save Series") || b.textContent?.trim() === "Cancel") {
                expect(b.className).toContain("touch-manipulation");
            }
        }
    });
});