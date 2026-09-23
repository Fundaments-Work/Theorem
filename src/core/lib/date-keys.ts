/**
 * Calendar-day keys in the reader's local time zone ("YYYY-MM-DD").
 *
 * Reading stats, streaks and goals are about the reader's day. Keys derived
 * from toISOString() are UTC days, so evening reading west of UTC (or early
 * morning east of it) landed on the wrong day and goals reset at the wrong
 * hour.
 */
export function localDateKey(date: Date = new Date()): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

/** `date` shifted by whole calendar days (DST-safe: uses setDate, not 24h math). */
export function addLocalDays(date: Date, days: number): Date {
    const shifted = new Date(date.getTime());
    shifted.setDate(shifted.getDate() + days);
    return shifted;
}
