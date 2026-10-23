// User-level building blocks shared by specs. Each step is phrased the way a
// person would do it ("press Skip", "pick these files") so the same steps can
// be re-implemented against the Svelte UI without changing the specs.
import { sleep } from "./app.mjs";

export async function skipOnboarding(app) {
    await app.click({ role: "button", name: "Skip" }, { timeout: 20000 });
    await app.find({ role: "heading", name: "Library" });
}

/** Launch a fresh sandbox and land on the (empty) library. */
export async function launchFresh(box, opts) {
    const app = await box.launch(opts);
    await skipOnboarding(app);
    return app;
}

export const bookButton = (title) => ({ role: "button", name: `Open ${title}` });

/** Import files through Library → Import/Add Books, answering the file picker with `paths`. */
export async function importBooks(app, paths, { expectTitles = [] } = {}) {
    app.queueDialog("open", paths);
    // Empty library: "Import Books"; otherwise the toolbar's "Add Books".
    await app.click({ role: "button", name: /^(Import Books|Add Books)/ });
    for (const title of expectTitles) await app.find(bookButton(title), { timeout: 30000 });
    // Done when the button stops saying "Importing..." (metadata and covers are filled in by then).
    await app.find({ role: "button", name: /^(Import Books|Add Books)/ }, { timeout: 30000 });
}

export async function goTo(app, section) {
    await app.click({ role: "button", name: section });
    await app.find({ role: "heading", name: section });
}

/** The reader shows "Page N / M" in its title bar. */
export async function readerPage(app) {
    const text = await app.text();
    const m = /Page (\d+) \/ (\d+)/.exec(text);
    return m ? { page: Number(m[1]), total: Number(m[2]) } : null;
}

export async function openBook(app, title) {
    const reader = { role: "main", name: "Reader" };
    await app.click(bookButton(title));
    // Observed in 1.6.0: a click on a book seconds after it was imported is
    // occasionally ignored (no reader, no error). Click once more, loudly, so
    // the flow under test continues; see docs/testing-e2e.md "Known failures".
    if (!(await app.find(reader, { timeout: 6000 }).catch(() => null))) {
        console.warn(`[e2e] first click on "${title}" did not open the reader; clicking again`);
        await app.click(bookButton(title));
        await app.find(reader, { timeout: 20000 });
    }
    return app.waitFor(() => readerPage(app), { timeout: 20000, what: "page counter" });
}

export async function nextPage(app) {
    const before = await readerPage(app);
    await app.revealReaderChrome();
    await app.click({ role: "button", name: "Next page" });
    return app.waitFor(async () => {
        const now = await readerPage(app);
        return now && now.page > before.page ? now : null;
    }, { what: "the page to advance" });
}

export async function backToLibrary(app) {
    await app.revealReaderChrome();
    await app.click({ role: "button", name: "Back to Library" });
    await app.find({ role: "heading", name: "Library" });
}

/**
 * Select a word on the first page by double-clicking it (a real mouse gesture
 * in the book frame), then press a highlight colour in the selection menu.
 * The generated books start with "Marker sentence…" at this spot.
 */
export async function highlightFirstWord(app, { x = 90, y = 141, colour = "Select Important" } = {}) {
    const menu = { role: "button", name: colour };
    // The book frame may still be laying out right after opening; retry the gesture.
    for (let attempt = 0; attempt < 4 && !(await app.exists(menu)); attempt++) {
        await sleep(attempt === 0 ? 300 : 1000);
        await app.session.pointer([{ type: "move", x, y }, { type: "down" }, { type: "up" }, { type: "down" }, { type: "up" }]);
        await app.waitFor(() => app.exists(menu), { timeout: 2000, what: "selection menu" }).catch(() => {});
    }
    await app.click(menu);
    await app.waitGone(menu);
    await sleep(300);
}

export async function openSettingsTab(app, tab) {
    await goTo(app, "Settings");
    await app.click({ role: "button", name: tab });
    await app.find({ role: "button", name: tab, checked: true });
}
