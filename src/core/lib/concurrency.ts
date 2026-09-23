/**
 * Run `task` over `items` with at most `limit` in flight. Settles like
 * Promise.allSettled (one failure does not stop the rest), results in input order.
 */
export async function mapSettledWithConcurrency<T, R>(
    items: ReadonlyArray<T>,
    limit: number,
    task: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
    const results: PromiseSettledResult<R>[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            try {
                results[index] = { status: "fulfilled", value: await task(items[index], index) };
            } catch (reason) {
                results[index] = { status: "rejected", reason };
            }
        }
    };
    const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
    await Promise.all(Array.from({ length: workers }, worker));
    return results;
}
