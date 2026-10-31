import { localDateKey } from "../../../core/lib/date-keys";

/** Split visible time at local midnight. Calendar boundaries also handle DST days. */
export function splitReadingInterval(start: number, end: number): Array<{ date: string; milliseconds: number }> {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    const parts: Array<{ date: string; milliseconds: number }> = [];
    let cursor = start;
    while (cursor < end) {
        const day = new Date(cursor);
        const midnight = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
        const boundary = Math.min(midnight, end);
        if (!Number.isFinite(boundary) || boundary <= cursor) return parts;
        parts.push({ date: localDateKey(day), milliseconds: boundary - cursor });
        cursor = boundary;
    }
    return parts;
}
