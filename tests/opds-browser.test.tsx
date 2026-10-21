// @vitest-environment jsdom
/**
 * Navigating a catalog: sections, the trail, Back, shelves, errors and signing in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import type { OpdsFeed } from "../src/core/types";

const load = vi.fn();

vi.mock("../src/core/services/OpdsService", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/core/services/OpdsService")>();
    return { ...actual, OpdsService: { ...actual.OpdsService, load: (...a: unknown[]) => load(...a), search: vi.fn(), loadDetail: vi.fn(), download: vi.fn() } };
});

import { OpdsError } from "../src/core/services/OpdsService";
import { useOpdsStore } from "../src/core/store";
import { resetOpdsBrowserSession } from "../src/features/catalogs/opds/useOpdsBrowser";
import { CATALOG, clickButton, flush, makeEntry, makeFeed, renderBrowser, setInputValue, shownTitles, stubLayout, unmountAll } from "./helpers/opds-browser-harness";

const ROOT = "https://example.com/opds";
const nav = (title: string, href: string, summary?: string, count?: number) => ({ title, href, rel: "subsection", summary, count });

function serve(map: Record<string, OpdsFeed | Error>) {
    load.mockImplementation(async (url: string, opts?: { auth?: unknown }) => {
        const hit = map[url];
        if (!hit) throw new OpdsError("notFound", "Not found (404).");
        if (hit instanceof Error) throw hit;
        return { feed: hit, finalUrl: url, opts };
    });
}
const label = (c: HTMLElement, text: string) => Array.from(c.querySelectorAll("button")).find((b) => b.textContent?.includes(text)) as HTMLElement;

describe("catalog navigation", () => {
    let unstub: () => void = () => {};
    beforeEach(() => {
        vi.clearAllMocks();
        resetOpdsBrowserSession();
        unstub = stubLayout();
        useOpdsStore.setState({ catalogs: [CATALOG], activeCatalogId: CATALOG.id });
    });
    afterEach(() => {
        unmountAll();
        unstub();
        unstub = () => {};
    });

    it("lists a catalog's sections with their summaries and counts", async () => {
        serve({ [ROOT]: makeFeed({ entries: [], navigation: [nav("Authors", `${ROOT}/authors`, "Browse by writer", 120), nav("Newest", `${ROOT}/new`)] }) });
        const c = renderBrowser();
        await flush();
        const rows = Array.from(c.querySelectorAll("[aria-label=Browse] li"));
        expect(rows).toHaveLength(2);
        expect(rows[0].textContent).toContain("Browse by writer");
        expect(rows[0].textContent).toContain("120");
    });

    it("opens a section, shows where you are, and goes Back", async () => {
        serve({
            [ROOT]: makeFeed({ entries: [], navigation: [nav("Fiction", `${ROOT}/fiction`)] }),
            [`${ROOT}/fiction`]: makeFeed({ title: "Fiction", entries: [makeEntry(1, { title: "A Novel" })] }),
        });
        const c = renderBrowser();
        await flush();
        act(() => label(c, "Fiction").click());
        await flush();
        expect(shownTitles(c)).toEqual(["A Novel"]);
        const trail = c.querySelector('nav[aria-label="Catalog trail"]')!;
        expect(trail.textContent).toContain(CATALOG.title);
        expect(trail.textContent).toContain("Fiction");
        act(() => (c.querySelector('[aria-label="Back"]') as HTMLElement).click());
        await flush();
        expect(c.querySelectorAll("[aria-label=Browse] li")).toHaveLength(1);
        expect(c.querySelector('[aria-label="Back"]')).toBeNull();
    });

    it("jumps straight to an earlier step from the trail", async () => {
        serve({
            [ROOT]: makeFeed({ entries: [], navigation: [nav("Fiction", `${ROOT}/fiction`)] }),
            [`${ROOT}/fiction`]: makeFeed({ title: "Fiction", entries: [], navigation: [nav("Sci-Fi", `${ROOT}/scifi`)] }),
            [`${ROOT}/scifi`]: makeFeed({ title: "Sci-Fi", entries: [makeEntry(1, { title: "Deep" })] }),
        });
        const c = renderBrowser();
        await flush();
        act(() => label(c, "Fiction").click());
        await flush();
        act(() => label(c, "Sci-Fi").click());
        await flush();
        expect(shownTitles(c)).toEqual(["Deep"]);
        const trailButtons = Array.from(c.querySelectorAll('nav[aria-label="Catalog trail"] button'));
        act(() => (trailButtons[0] as HTMLElement).click());
        await flush();
        expect(c.querySelector('nav[aria-label="Catalog trail"]')).toBeNull();
        expect(c.textContent).toContain("Fiction");
    });

    it("opens a list that is a single book as that book", async () => {
        serve({
            [ROOT]: makeFeed({ entries: [], navigation: [nav("Dracula", `${ROOT}/345`, "Bram Stoker")] }),
            [`${ROOT}/345`]: makeFeed({ title: "Dracula", entries: [makeEntry(345, { title: "Dracula" })] }),
        });
        const c = renderBrowser();
        await flush();
        act(() => label(c, "Dracula").click());
        await flush();
        // The detail sheet (a dialog in a portal) opens by itself.
        expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    });

    it("remembers where you were when you leave the catalog and come back", async () => {
        serve({
            [ROOT]: makeFeed({ entries: [], navigation: [nav("Fiction", `${ROOT}/fiction`)] }),
            [`${ROOT}/fiction`]: makeFeed({ title: "Fiction", entries: [makeEntry(1, { title: "A Novel" })] }),
        });
        let c = renderBrowser();
        await flush();
        act(() => label(c, "Fiction").click());
        await flush();
        unmountAll();
        c = renderBrowser();
        await flush();
        expect(shownTitles(c)).toEqual(["A Novel"]);
    });

    it("shows shelves as rows of books with a See all link", async () => {
        serve({
            [ROOT]: makeFeed({
                entries: [],
                groups: [{ title: "New arrivals", href: `${ROOT}/new`, navigation: [], entries: [makeEntry(1, { title: "Fresh" })] }],
            }),
            [`${ROOT}/new`]: makeFeed({ title: "New arrivals", entries: [makeEntry(1, { title: "Fresh" }), makeEntry(2, { title: "Fresher" })] }),
        });
        const c = renderBrowser();
        await flush();
        expect(c.textContent).toContain("New arrivals");
        expect(c.textContent).toContain("Fresh");
        clickButton(c, "See all");
        await flush();
        expect(shownTitles(c)).toEqual(["Fresh", "Fresher"]);
    });

    it("refreshing asks for a fresh copy, not the cache", async () => {
        serve({ [ROOT]: makeFeed({ entries: [makeEntry(1)] }) });
        const c = renderBrowser();
        await flush();
        expect(load.mock.calls[0][1]).toMatchObject({ force: undefined });
        act(() => (c.querySelector('[aria-label="Refresh"]') as HTMLElement).click());
        await flush();
        expect(load.mock.calls[load.mock.calls.length - 1][1]).toMatchObject({ force: true });
    });

    it("explains a failure plainly and lets you retry", async () => {
        serve({ [ROOT]: new OpdsError("network", "Could not reach the catalog. Check the address and your connection.") });
        const c = renderBrowser();
        await flush();
        expect(c.querySelector('[role="alert"]')!.textContent).toContain("Could not reach the catalog");
        expect(c.textContent).toContain(`Couldn't open ${CATALOG.title}`);
        serve({ [ROOT]: makeFeed({ entries: [makeEntry(1, { title: "Back Online" })] }) });
        clickButton(c, "Try again");
        await flush();
        expect(shownTitles(c)).toEqual(["Back Online"]);
    });

    it("an empty catalog says so instead of showing a blank page", async () => {
        serve({ [ROOT]: makeFeed({ entries: [] }) });
        const c = renderBrowser();
        await flush();
        expect(c.querySelector("[data-opds-empty]")!.textContent).toContain("Nothing here yet");
    });

    it("ignores a slow answer for a section you have already left", async () => {
        let resolveSlow: (v: unknown) => void = () => {};
        load.mockImplementation((url: string) => {
            if (url === ROOT) return Promise.resolve({ finalUrl: url, feed: makeFeed({ entries: [], navigation: [nav("Slow", `${ROOT}/slow`), nav("Fast", `${ROOT}/fast`)] }) });
            if (url.endsWith("/slow")) return new Promise((r) => (resolveSlow = r));
            return Promise.resolve({ finalUrl: url, feed: makeFeed({ title: "Fast", entries: [makeEntry(2, { title: "Fast Book" })] }) });
        });
        const c = renderBrowser();
        await flush();
        act(() => label(c, "Slow").click());
        await flush();
        act(() => (c.querySelector('[aria-label="Back"]') as HTMLElement).click());
        await flush();
        act(() => label(c, "Fast").click());
        await flush();
        expect(shownTitles(c)).toEqual(["Fast Book"]);
        await act(async () => resolveSlow({ finalUrl: `${ROOT}/slow`, feed: makeFeed({ entries: [makeEntry(1, { title: "Slow Book" })] }) }));
        await flush();
        expect(shownTitles(c)).toEqual(["Fast Book"]);
    });
});

describe("signing in to a catalog", () => {
    let unstub: () => void = () => {};
    beforeEach(() => {
        vi.clearAllMocks();
        resetOpdsBrowserSession();
        unstub = stubLayout();
        useOpdsStore.setState({ catalogs: [CATALOG], activeCatalogId: CATALOG.id });
    });
    afterEach(() => {
        unmountAll();
        unstub();
        unstub = () => {};
    });

    const challenge = () => new OpdsError("authRequired", "This catalog requires a sign-in.", { status: 401, realm: "Home Library" });
    const fill = (c: HTMLElement, user: string, pass: string) => {
        setInputValue(c, 'input[autocomplete="username"]', user);
        setInputValue(c, 'input[autocomplete="current-password"]', pass);
    };
    const submitForm = async (c: HTMLElement) => {
        await act(async () => {
            (c.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        });
        await flush();
    };

    it("asks for a login with the server's realm, then loads the catalog with it", async () => {
        load.mockImplementation(async (_url: string, opts?: { auth?: { username: string } }) => {
            if (!opts?.auth) throw challenge();
            return { finalUrl: ROOT, feed: makeFeed({ entries: [makeEntry(1, { title: "Private Book" })] }) };
        });
        const c = renderBrowser();
        await flush();
        expect(c.textContent).toContain("Sign in to Test Catalog");
        expect(c.textContent).toContain("Home Library");
        fill(c, "reader", "s3cret");
        await submitForm(c);
        expect(load).toHaveBeenLastCalledWith(ROOT, expect.objectContaining({ auth: { username: "reader", password: "s3cret" }, force: true }));
        expect(shownTitles(c)).toEqual(["Private Book"]);
    });

    it("remembers the login on the catalog when asked, and not otherwise", async () => {
        load.mockImplementation(async (_u: string, opts?: { auth?: unknown }) => {
            if (!opts?.auth) throw challenge();
            return { finalUrl: ROOT, feed: makeFeed({ entries: [makeEntry(1)] }) };
        });
        let c = renderBrowser();
        await flush();
        fill(c, "reader", "pw");
        await submitForm(c);
        expect(useOpdsStore.getState().catalogs[0].auth).toEqual({ username: "reader", password: "pw" });

        unmountAll();
        resetOpdsBrowserSession();
        useOpdsStore.setState({ catalogs: [CATALOG] });
        c = renderBrowser();
        await flush();
        fill(c, "guest", "pw2");
        (c.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
        await submitForm(c);
        expect(useOpdsStore.getState().catalogs[0].auth).toBeUndefined();
        expect(shownTitles(c)).toHaveLength(1);
    });

    it("never saves a password the server rejected, even when 'remember' is on, and keeps the username", async () => {
        load.mockRejectedValue(challenge());
        const c = renderBrowser();
        await flush();
        fill(c, "reader", "wrong");
        await submitForm(c);
        // Rejected: nothing is stored, so a working saved login can't be replaced by a typo.
        expect(useOpdsStore.getState().catalogs[0].auth).toBeUndefined();
        expect((c.querySelector('input[autocomplete="username"]') as HTMLInputElement).value).toBe("reader");
        expect((c.querySelector('input[autocomplete="current-password"]') as HTMLInputElement).value).toBe("");
    });

    it("says when the details were rejected", async () => {
        load.mockRejectedValue(challenge());
        const c = renderBrowser();
        await flush();
        fill(c, "reader", "wrong");
        await submitForm(c);
        expect(c.querySelector('[role="alert"]')!.textContent).toContain("did not accept");
    });

    it("says plainly when a server offers only a sign-in method Theorem lacks", async () => {
        load.mockRejectedValue(
            new OpdsError("authRequired", "Library card", {
                hint: { type: "authentication", title: "Library card", flows: [{ kind: "http://opds-spec.org/auth/oauth/implicit" }] },
            }),
        );
        const c = renderBrowser();
        await flush();
        expect(c.textContent).toContain("signs in with a method Theorem can't use yet");
        expect(c.querySelector("form")).toBeNull();
    });

    it("uses the server's own labels from an authentication document", async () => {
        load.mockRejectedValue(
            new OpdsError("authRequired", "Library card", {
                hint: {
                    type: "authentication",
                    title: "Library card",
                    description: "Sign in with your card",
                    flows: [{ kind: "http://opds-spec.org/auth/basic", loginLabel: "Card number", passwordLabel: "PIN" }],
                },
            }),
        );
        const c = renderBrowser();
        await flush();
        expect(c.textContent).toContain("Sign in with your card");
        expect(c.textContent).toContain("Card number");
        expect(c.textContent).toContain("PIN");
    });

    it("loads with saved credentials straight away", async () => {
        useOpdsStore.setState({ catalogs: [{ ...CATALOG, auth: { username: "saved", password: "pw" } }] });
        load.mockResolvedValue({ finalUrl: ROOT, feed: makeFeed({ entries: [makeEntry(1)] }) });
        renderBrowser({ ...CATALOG, auth: { username: "saved", password: "pw" } });
        await flush();
        expect(load).toHaveBeenCalledWith(ROOT, expect.objectContaining({ auth: { username: "saved", password: "pw" } }));
    });
});
