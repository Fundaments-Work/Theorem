import { describe, expect, it, vi } from "vitest";

const { toastMock, dismissMock } = vi.hoisted(() => ({
    toastMock: vi.fn((_message: string, _options: unknown) => "series-next-toast"),
    dismissMock: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: Object.assign(toastMock, { dismiss: dismissMock }) }));

import { notifyNextSeriesBook } from "../src/features/reader/series-completion-notification";

describe("next-book series notification", () => {
    it("dismisses its own notification before opening the next unread book", () => {
        const openBook = vi.fn();
        notifyNextSeriesBook(
            { title: "Dune", series: "Dune" },
            { id: "messiah", title: "Dune Messiah", seriesIndex: 2 },
            openBook,
        );

        const options = toastMock.mock.calls[0]?.[1] as {
            action: { label: string; onClick: () => void };
        };
        expect(options.action.label).toBe("Read Next");
        options.action.onClick();

        expect(dismissMock).toHaveBeenCalledWith("series-next-toast");
        expect(openBook).toHaveBeenCalledWith("messiah");
        expect(dismissMock.mock.invocationCallOrder[0]).toBeLessThan(openBook.mock.invocationCallOrder[0]);
    });
});
