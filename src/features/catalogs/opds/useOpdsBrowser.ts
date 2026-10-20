import { useCallback, useEffect, useRef, useState } from "react";
import { OpdsError, OpdsService } from "../../../core/services/OpdsService";
import { useOpdsStore } from "../../../core/store";
import type {
    OpdsCatalog,
    OpdsCredentials,
    OpdsEntry,
    OpdsFeed,
    OpdsGroup,
    OpdsNavItem,
    OpdsSearchRef,
} from "../../../core/types";

export interface Crumb {
    url: string;
    title: string;
}

export type BrowserStatus = "loading" | "ready" | "error" | "auth";

export interface BrowserState {
    crumbs: Crumb[];
    /** Metadata (links, facets, title) of the page currently shown. */
    feed: OpdsFeed | null;
    /** Books across every page loaded so far. */
    entries: OpdsEntry[];
    navigation: OpdsNavItem[];
    groups: OpdsGroup[];
    status: BrowserStatus;
    error: OpdsError | null;
    /** The credentials were sent and rejected. */
    signInFailed: boolean;
    loadingMore: boolean;
    moreError: string | null;
    /** Set while the shown feed is the result of a search. */
    searchQuery: string | null;
}

// Where the user was in each catalog this session, so switching sources and coming back is seamless.
const sessionCrumbs = new Map<string, Crumb[]>();

const EMPTY: Omit<BrowserState, "crumbs"> = {
    feed: null,
    entries: [],
    navigation: [],
    groups: [],
    status: "loading",
    error: null,
    signInFailed: false,
    loadingMore: false,
    moreError: null,
    searchQuery: null,
};

function mergeBy<T>(existing: T[], incoming: T[], key: (item: T) => string): T[] {
    const seen = new Set(existing.map(key));
    const added = incoming.filter((item) => {
        const k = key(item);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
    return added.length === 0 ? existing : [...existing, ...added];
}

export function useOpdsBrowser(catalog: OpdsCatalog) {
    const setCredentials = useOpdsStore((s) => s.setCredentials);
    const [state, setState] = useState<BrowserState>(() => ({
        ...EMPTY,
        crumbs: sessionCrumbs.get(catalog.id) ?? [{ url: catalog.url, title: catalog.title }],
    }));

    // Credentials entered for this visit only ("remember" was off).
    const sessionAuth = useRef<OpdsCredentials | undefined>(undefined);
    const auth = catalog.auth ?? sessionAuth.current;
    const authRef = useRef(auth);
    authRef.current = auth;

    // The catalog's search, found on its first page and kept for deeper pages that do not repeat it.
    const rootSearch = useRef<OpdsSearchRef | undefined>(undefined);
    const requestId = useRef(0);
    const loadedFor = useRef<string | null>(null);
    // Pages of the current list already fetched. A server whose `next` points back at a page we
    // have (or at itself) must end the list rather than be asked for forever.
    const visitedPages = useRef<Set<string>>(new Set());
    // Credentials the user asked us to remember. They are written to the catalog only once the
    // server accepts them, so a mistyped password never replaces a working one.
    const pendingSave = useRef<OpdsCredentials | undefined>(undefined);

    const apply = useCallback((crumbs: Crumb[], feed: OpdsFeed, searchQuery: string | null) => {
        if (!rootSearch.current && feed.search) rootSearch.current = feed.search;
        sessionCrumbs.set(catalog.id, crumbs);
        visitedPages.current = new Set([crumbs[crumbs.length - 1].url, feed.selfUrl].filter(Boolean) as string[]);
        setState({
            crumbs,
            feed,
            entries: feed.entries,
            navigation: feed.navigation,
            groups: feed.groups,
            status: "ready",
            error: null,
            signInFailed: false,
            loadingMore: false,
            moreError: null,
            searchQuery,
        });
    }, [catalog.id]);

    const fail = useCallback((crumbs: Crumb[], error: unknown, hadCredentials: boolean) => {
        const err = error instanceof OpdsError ? error : new OpdsError("network", error instanceof Error ? error.message : "Could not load the catalog.");
        setState((prev) => ({
            ...prev,
            crumbs,
            status: err.kind === "authRequired" ? "auth" : "error",
            error: err,
            signInFailed: err.kind === "authRequired" && hadCredentials,
            loadingMore: false,
        }));
    }, []);

    /** Load the last crumb of `crumbs`. Older, still-running loads are ignored when it resolves. */
    const go = useCallback(
        async (crumbs: Crumb[], opts: { force?: boolean; searchQuery?: string | null } = {}) => {
            const id = ++requestId.current;
            const target = crumbs[crumbs.length - 1];
            // Keep the old page on screen (dimmed by `status`) rather than blanking it.
            setState((prev) => ({ ...prev, crumbs, status: "loading", error: null, moreError: null }));
            const creds = authRef.current;
            try {
                const { feed } = await OpdsService.load(target.url, { auth: creds, force: opts.force });
                if (id !== requestId.current) return;
                const save = pendingSave.current;
                if (save && creds && save.username === creds.username && save.password === creds.password) {
                    pendingSave.current = undefined;
                    // The saved login changes `auth`; mark it as already loaded so it does not reload.
                    loadedFor.current = `${catalog.id}|${save.username}:${save.password}`;
                    setCredentials(catalog.id, save);
                }
                apply(crumbs, feed, opts.searchQuery ?? null);
            } catch (error) {
                if (id !== requestId.current) return;
                pendingSave.current = undefined;
                fail(crumbs, error, Boolean(creds));
            }
        },
        [apply, fail, catalog.id, setCredentials],
    );

    // First load, and a reload when sign-in details change (saved from the sign-in panel).
    const authKey = auth ? `${auth.username}:${auth.password}` : "";
    useEffect(() => {
        const key = `${catalog.id}|${authKey}`;
        if (loadedFor.current === key) return;
        loadedFor.current = key;
        void go(state.crumbs);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [catalog.id, authKey]);

    const open = useCallback(
        (url: string, title: string) => {
            void go([...state.crumbs, { url, title }]);
        },
        [go, state.crumbs],
    );

    const openAt = useCallback(
        (index: number) => {
            if (index < 0 || index >= state.crumbs.length - 1) return;
            void go(state.crumbs.slice(0, index + 1));
        },
        [go, state.crumbs],
    );

    const back = useCallback(() => {
        if (state.crumbs.length > 1) void go(state.crumbs.slice(0, -1));
    }, [go, state.crumbs]);

    const refresh = useCallback(() => void go(state.crumbs, { force: true }), [go, state.crumbs]);

    /** Switch to another facet of the same list (replaces the current step; Back is unaffected). */
    const facet = useCallback(
        (href: string) => {
            const current = state.crumbs[state.crumbs.length - 1];
            void go([...state.crumbs.slice(0, -1), { url: href, title: current.title }]);
        },
        [go, state.crumbs],
    );

    const loadMore = useCallback(async () => {
        const next = state.feed?.nextUrl;
        if (!next || state.loadingMore || state.status !== "ready") return;
        const endList = () =>
            setState((prev) => ({ ...prev, loadingMore: false, feed: prev.feed ? { ...prev.feed, nextUrl: undefined } : prev.feed }));
        if (visitedPages.current.has(next)) {
            endList();
            return;
        }
        visitedPages.current.add(next);
        const id = requestId.current;
        setState((prev) => ({ ...prev, loadingMore: true, moreError: null }));
        try {
            const { feed } = await OpdsService.load(next, { auth: authRef.current });
            if (id !== requestId.current) return;
            setState((prev) => {
                const entries = mergeBy(prev.entries, feed.entries, (e) => e.id);
                const navigation = mergeBy(prev.navigation, feed.navigation, (n) => n.href);
                // A page that adds nothing means the server has run out (or is repeating itself), and a
                // `next` that leads back to a page we already have would only loop.
                const grew = entries !== prev.entries || navigation !== prev.navigation;
                const loops = feed.nextUrl ? visitedPages.current.has(feed.nextUrl) : false;
                return {
                    ...prev,
                    // Pagination links come from the newest page; facets and search stay from the first.
                    feed: {
                        ...feed,
                        facets: prev.feed?.facets ?? feed.facets,
                        search: prev.feed?.search ?? feed.search,
                        nextUrl: grew && !loops ? feed.nextUrl : undefined,
                    },
                    entries,
                    navigation,
                    groups: prev.groups,
                    loadingMore: false,
                };
            });
        } catch (error) {
            if (id !== requestId.current) return;
            // Allow a retry of the same page.
            visitedPages.current.delete(next);
            setState((prev) => ({
                ...prev,
                loadingMore: false,
                moreError: error instanceof Error ? error.message : "Could not load more.",
            }));
        }
    }, [state.feed, state.loadingMore, state.status]);

    const canSearch = Boolean(state.feed?.search ?? rootSearch.current);

    /**
     * Run the catalog's own search. Resolves `true` when results are showing; on failure the page
     * the user was on stays as it was (so the caller can fall back to filtering it locally).
     * A sign-in challenge is the exception: that replaces the page with the sign-in panel.
     */
    const search = useCallback(
        async (query: string): Promise<boolean> => {
            const ref = state.feed?.search ?? rootSearch.current;
            const q = query.trim();
            if (!ref || !q) return false;
            const id = ++requestId.current;
            setState((prev) => ({ ...prev, status: "loading", error: null }));
            try {
                const { feed, finalUrl } = await OpdsService.search(ref, q, authRef.current);
                if (id !== requestId.current) return false;
                // Searching from a search replaces it instead of stacking results on results.
                const base = state.searchQuery ? state.crumbs.slice(0, -1) : state.crumbs;
                apply([...base, { url: finalUrl, title: `Search: ${q}` }], feed, q);
                return true;
            } catch (error) {
                if (id !== requestId.current) return false;
                if (error instanceof OpdsError && error.kind === "authRequired") {
                    fail(state.crumbs, error, Boolean(authRef.current));
                } else {
                    setState((prev) => ({ ...prev, status: prev.feed ? "ready" : "error" }));
                }
                return false;
            }
        },
        [apply, fail, state.crumbs, state.feed, state.searchQuery],
    );

    const clearSearch = useCallback(() => {
        if (state.searchQuery && state.crumbs.length > 1) void go(state.crumbs.slice(0, -1));
    }, [go, state.crumbs, state.searchQuery]);

    const signIn = useCallback(
        (creds: OpdsCredentials, remember: boolean) => {
            sessionAuth.current = creds;
            pendingSave.current = remember ? creds : undefined;
            authRef.current = creds;
            loadedFor.current = `${catalog.id}|${creds.username}:${creds.password}`;
            void go(state.crumbs, { force: true });
        },
        [catalog.id, go, state.crumbs],
    );

    const signOut = useCallback(() => {
        sessionAuth.current = undefined;
        pendingSave.current = undefined;
        authRef.current = undefined;
        setCredentials(catalog.id, undefined);
        loadedFor.current = `${catalog.id}|`;
        void go(state.crumbs, { force: true });
    }, [catalog.id, go, setCredentials, state.crumbs]);

    return { state, auth, canSearch, open, openAt, back, refresh, facet, loadMore, search, clearSearch, signIn, signOut };
}

/** Test hook: forget remembered positions. */
export function resetOpdsBrowserSession(): void {
    sessionCrumbs.clear();
}
