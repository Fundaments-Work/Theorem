/**
 * Moving records that older store versions kept in the persisted KV copy into
 * their own SQLite tables. The KV copy may only be dropped once every record
 * is confirmed in SQLite, so the write result has to be known, not assumed.
 */

/**
 * Write every item, wait for all of them, and report the failures. Returns
 * `true` only when every write succeeded; one failing write never stops the
 * others.
 */
export async function writeAllReportingFailures<T>(
    label: string,
    items: readonly T[],
    write: (item: T) => Promise<unknown>,
): Promise<boolean> {
    const results = await Promise.allSettled(items.map((item) => {
        try {
            return write(item);
        } catch (error) {
            return Promise.reject(error);
        }
    }));
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failures.length > 0) {
        console.error(
            `[legacy-move] ${failures.length} of ${items.length} ${label} could not be written to SQLite; `
            + "they stay in the saved copy and are retried on the next launch:",
            failures[0].reason,
        );
    }
    return failures.length === 0;
}
