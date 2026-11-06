import { toast } from "sonner";
import type { Book } from "../../core/types";

type CompletedSeriesBook = Pick<Book, "title" | "series">;
type NextSeriesBook = Pick<Book, "id" | "title" | "seriesIndex">;

export function notifyNextSeriesBook(
    completedBook: CompletedSeriesBook,
    nextBook: NextSeriesBook,
    openBook: (bookId: string) => void,
): void {
    const series = completedBook.series?.trim();
    if (!series) return;

    let notificationId: string | number;
    notificationId = toast(`Finished ${completedBook.title}!`, {
        description: `Next up in ${series}: ${nextBook.title}${nextBook.seriesIndex != null ? ` (Vol. ${nextBook.seriesIndex})` : ""}`,
        action: {
            label: "Read Next",
            onClick: () => {
                toast.dismiss(notificationId);
                openBook(nextBook.id);
            },
        },
        duration: 10000,
    });
}
