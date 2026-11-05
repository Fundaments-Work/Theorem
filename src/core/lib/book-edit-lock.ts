/** Keep a local editor and an incoming cover from writing the same book at once. */
const pending = new Map<string, Promise<void>>();

export async function acquireBookEditLock(bookId: string): Promise<() => void> {
    const previous = pending.get(bookId) ?? Promise.resolve();
    let unlock!: () => void;
    const held = new Promise<void>(resolve => { unlock = resolve; });
    const tail = previous.then(() => held);
    pending.set(bookId, tail);
    await previous;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        unlock();
        if (pending.get(bookId) === tail) pending.delete(bookId);
    };
}

export async function withBookEditLock<T>(bookId: string, edit: () => Promise<T>): Promise<T> {
    const release = await acquireBookEditLock(bookId);
    try {
        return await edit();
    } finally {
        release();
    }
}
