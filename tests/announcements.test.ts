import { describe, it, expect, beforeEach, vi } from "vitest";
import {
    isSafeHttpUrl,
    linkifySegments,
    renderInlineBold,
    parseAnnouncements,
    selectActive,
    getDismissedAnnouncementIds,
    dismissAnnouncement,
    fetchAnnouncements,
    ANNOUNCEMENT_ENDPOINT,
    ANNOUNCEMENTS_DISMISSED_KEY,
    ANNOUNCEMENTS_CACHE_KEY,
    Announcement,
} from "../src/core/lib/announcements";

describe("announcements library", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    describe("isSafeHttpUrl", () => {
        it("accepts valid https URLs", () => {
            expect(isSafeHttpUrl("https://github.com/fundaments-work/theorem")).toBe(true);
            expect(isSafeHttpUrl("https://example.com/path?query=1#hash")).toBe(true);
        });

        it("rejects http URLs", () => {
            expect(isSafeHttpUrl("http://example.com")).toBe(false);
        });

        it("rejects javascript: and data: schemes", () => {
            expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
            expect(isSafeHttpUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
        });

        it("rejects credentialed URLs", () => {
            expect(isSafeHttpUrl("https://user:pass@example.com")).toBe(false);
            expect(isSafeHttpUrl("https://admin@example.com")).toBe(false);
        });

        it("rejects invalid URL strings", () => {
            expect(isSafeHttpUrl("")).toBe(false);
            expect(isSafeHttpUrl("not a url")).toBe(false);
            expect(isSafeHttpUrl(null as unknown as string)).toBe(false);
        });
    });

    describe("linkifySegments", () => {
        it("returns empty array for empty string", () => {
            expect(linkifySegments("")).toEqual([]);
        });

        it("returns single text segment when no URL exists", () => {
            const segs = linkifySegments("This is plain announcement text.");
            expect(segs).toEqual([
                { kind: "text", value: "This is plain announcement text." }
            ]);
        });

        it("splits one URL in the middle into text, link, text", () => {
            const segs = linkifySegments("Check https://example.com for details");
            expect(segs).toEqual([
                { kind: "text", value: "Check " },
                { kind: "link", value: "https://example.com", href: "https://example.com" },
                { kind: "text", value: " for details" },
            ]);
        });

        it("handles URL at start and end without empty text segments", () => {
            const startSegs = linkifySegments("https://example.com is great");
            expect(startSegs).toEqual([
                { kind: "link", value: "https://example.com", href: "https://example.com" },
                { kind: "text", value: " is great" },
            ]);

            const endSegs = linkifySegments("Visit https://example.com");
            expect(endSegs).toEqual([
                { kind: "text", value: "Visit " },
                { kind: "link", value: "https://example.com", href: "https://example.com" },
            ]);
        });

        it("trims trailing punctuation and unparenthesized closing parenthesis", () => {
            const segs = linkifySegments("See https://example.com/test. Also (https://example.com/paren)!");
            expect(segs).toEqual([
                { kind: "text", value: "See " },
                { kind: "link", value: "https://example.com/test", href: "https://example.com/test" },
                { kind: "text", value: ". Also (" },
                { kind: "link", value: "https://example.com/paren", href: "https://example.com/paren" },
                { kind: "text", value: ")!" },
            ]);
        });

        it("preserves balanced parentheses in URLs (such as Wikipedia)", () => {
            const segs = linkifySegments("Read https://en.wikipedia.org/wiki/Momo_(food) today");
            expect(segs).toEqual([
                { kind: "text", value: "Read " },
                { kind: "link", value: "https://en.wikipedia.org/wiki/Momo_(food)", href: "https://en.wikipedia.org/wiki/Momo_(food)" },
                { kind: "text", value: " today" },
            ]);
        });

        it("enforces max link cap, keeping subsequent URLs as plain text", () => {
            const body = "1: https://a.com 2: https://b.com 3: https://c.com 4: https://d.com 5: https://e.com 6: https://f.com";
            const segs = linkifySegments(body, 5);
            const links = segs.filter(s => s.kind === "link");
            expect(links).toHaveLength(5);
            expect(segs.some(s => s.kind === "text" && s.value.includes("https://f.com"))).toBe(true);
        });

        it("leaves unsafe or non-https URLs as plain text", () => {
            const body = "Insecure: http://example.com and script: javascript:alert(1) and cred: https://user:pass@example.com";
            const segs = linkifySegments(body);
            expect(segs.filter(s => s.kind === "link")).toHaveLength(0);
            expect(segs).toHaveLength(1);
            expect(segs[0].kind).toBe("text");
        });

        it("passes raw markup verbatim without HTML evaluation", () => {
            const body = "Alert <script>alert(1)</script> and <img src=x onerror=alert(2) />";
            const segs = linkifySegments(body);
            expect(segs).toEqual([
                { kind: "text", value: body }
            ]);
        });
    });

    describe("renderInlineBold", () => {
        it("returns empty array for empty string", () => {
            expect(renderInlineBold("")).toEqual([]);
        });

        it("returns single non-bold node when no ** delimiter exists", () => {
            expect(renderInlineBold("Simple message")).toEqual([
                { bold: false, value: "Simple message" }
            ]);
        });

        it("parses bold tokens correctly", () => {
            const nodes = renderInlineBold("Welcome to **Theorem 1.6.0** today!");
            expect(nodes).toEqual([
                { bold: false, value: "Welcome to " },
                { bold: true, value: "Theorem 1.6.0" },
                { bold: false, value: " today!" },
            ]);
        });

        it("leaves unpaired ** as literal text", () => {
            const nodes = renderInlineBold("Unpaired ** stars here");
            expect(nodes).toEqual([
                { bold: false, value: "Unpaired ** stars here" }
            ]);
        });

        it("handles adjacent bold tokens", () => {
            const nodes = renderInlineBold("**First****Second**");
            expect(nodes).toEqual([
                { bold: true, value: "First" },
                { bold: true, value: "Second" },
            ]);
        });
    });

    describe("parseAnnouncements", () => {
        it("returns empty array for null, non-objects, or empty lists", () => {
            expect(parseAnnouncements(null)).toEqual([]);
            expect(parseAnnouncements("invalid")).toEqual([]);
            expect(parseAnnouncements({})).toEqual([]);
            expect(parseAnnouncements({ announcements: [] })).toEqual([]);
        });

        it("parses valid announcement array and preserves custom properties", () => {
            const raw = {
                announcements: [
                    {
                        id: "release-1.6.0",
                        severity: "info",
                        title: "Theorem 1.6.0 Released",
                        body: "New features available at https://fundaments.work",
                        link: "https://fundaments.work",
                        linkLabel: "Read More",
                        publishedAt: "2026-10-08T00:00:00Z",
                        expiresAt: null,
                        channel: "stable",
                    }
                ]
            };

            const parsed = parseAnnouncements(raw);
            expect(parsed).toHaveLength(1);
            expect(parsed[0].id).toBe("release-1.6.0");
            expect(parsed[0].severity).toBe("info");
            expect(parsed[0].channel).toBe("stable");
        });

        it("drops malformed announcements", () => {
            const raw = [
                { id: "", title: "No ID", severity: "info", publishedAt: "2026-10-08T00:00:00Z" },
                { id: "1", title: "", severity: "info", publishedAt: "2026-10-08T00:00:00Z" },
                { id: "2", title: "Bad severity", severity: "unknown", publishedAt: "2026-10-08T00:00:00Z" },
                { id: "3", title: "Bad date", severity: "info", publishedAt: "not-a-date" },
            ];

            expect(parseAnnouncements(raw)).toEqual([]);
        });

        it("drops non-https link while preserving valid announcement", () => {
            const raw = [
                {
                    id: "warn-1",
                    severity: "warning",
                    title: "Notice",
                    body: "Warning text",
                    link: "http://insecure.com",
                    publishedAt: "2026-10-08T00:00:00Z",
                }
            ];

            const parsed = parseAnnouncements(raw);
            expect(parsed).toHaveLength(1);
            expect(parsed[0].link).toBeUndefined();
        });
    });

    describe("selectActive", () => {
        const baseTime = Date.parse("2026-10-08T12:00:00Z");

        const sampleAnnouncements: Announcement[] = [
            {
                id: "info-older",
                severity: "info",
                title: "Older Info",
                body: "Body",
                publishedAt: "2026-10-07T00:00:00Z",
            },
            {
                id: "info-newer",
                severity: "info",
                title: "Newer Info",
                body: "Body",
                publishedAt: "2026-10-08T06:00:00Z",
            },
            {
                id: "warning-active",
                severity: "warning",
                title: "Active Warning",
                body: "Body",
                publishedAt: "2026-10-08T01:00:00Z",
            },
            {
                id: "critical-active",
                severity: "critical",
                title: "Critical Alert",
                body: "Emergency maintenance",
                publishedAt: "2026-10-08T02:00:00Z",
            },
            {
                id: "future-notice",
                severity: "critical",
                title: "Future scheduled",
                body: "Body",
                publishedAt: "2026-10-09T00:00:00Z",
            },
            {
                id: "expired-notice",
                severity: "critical",
                title: "Expired",
                body: "Body",
                publishedAt: "2026-10-07T00:00:00Z",
                expiresAt: "2026-10-08T10:00:00Z",
            },
        ];

        it("returns null for empty lists", () => {
            expect(selectActive([])).toBeNull();
        });

        it("selects critical over warning and info", () => {
            const active = selectActive(sampleAnnouncements, baseTime);
            expect(active).not.toBeNull();
            expect(active?.id).toBe("critical-active");
        });

        it("skips dismissed items and falls back to warning", () => {
            const dismissed = new Set(["critical-active"]);
            const active = selectActive(sampleAnnouncements, baseTime, dismissed);
            expect(active?.id).toBe("warning-active");
        });

        it("tiebreaks same severity by latest publishedAt timestamp", () => {
            const dismissed = new Set(["critical-active", "warning-active"]);
            const active = selectActive(sampleAnnouncements, baseTime, dismissed);
            expect(active?.id).toBe("info-newer");
        });

        it("ignores future scheduled items and expired items", () => {
            const list: Announcement[] = [
                {
                    id: "future",
                    severity: "critical",
                    title: "Future",
                    body: "Body",
                    publishedAt: "2026-10-10T00:00:00Z",
                },
                {
                    id: "expired",
                    severity: "critical",
                    title: "Expired",
                    body: "Body",
                    publishedAt: "2026-10-01T00:00:00Z",
                    expiresAt: "2026-10-05T00:00:00Z",
                },
            ];

            expect(selectActive(list, baseTime)).toBeNull();
        });
    });

    describe("dismissal persistence", () => {
        it("saves and retrieves dismissed announcement IDs", () => {
            expect(getDismissedAnnouncementIds().size).toBe(0);

            dismissAnnouncement("anno-1");
            dismissAnnouncement("anno-2");

            const set = getDismissedAnnouncementIds();
            expect(set.has("anno-1")).toBe(true);
            expect(set.has("anno-2")).toBe(true);
            expect(set.has("anno-3")).toBe(false);
        });

        it("handles corrupted localStorage gracefully", () => {
            localStorage.setItem(ANNOUNCEMENTS_DISMISSED_KEY, "invalid-json");
            expect(getDismissedAnnouncementIds().size).toBe(0);
        });
    });

    describe("fetchAnnouncements", () => {
        const originalFetch = globalThis.fetch;

        beforeEach(() => {
            globalThis.fetch = originalFetch;
        });

        it("uses announcements.fundaments.work by default", () => {
            expect(ANNOUNCEMENT_ENDPOINT).toBe("https://announcements.fundaments.work/api/announcements");
        });

        it("parses and caches valid JSON announcements", async () => {
            const mockList = [
                {
                    id: "anno-fetched-1",
                    severity: "info",
                    title: "Fetched",
                    body: "Content",
                    publishedAt: "2026-10-08T00:00:00Z",
                },
            ];

            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                headers: new Headers({ "content-type": "application/json; charset=utf-8" }),
                json: async () => ({ announcements: mockList }),
            });

            const result = await fetchAnnouncements(2000);
            expect(result.length).toBe(1);
            expect(result[0].id).toBe("anno-fetched-1");

            // Cache is written
            const cached = JSON.parse(localStorage.getItem(ANNOUNCEMENTS_CACHE_KEY) || "{}");
            expect(cached.data[0].id).toBe("anno-fetched-1");
        });

        it("ignores non-JSON (e.g. text/html fallback) and falls back to cache", async () => {
            // Seed cache
            localStorage.setItem(
                ANNOUNCEMENTS_CACHE_KEY,
                JSON.stringify({
                    data: [
                        {
                            id: "cached-anno",
                            severity: "warning",
                            title: "Cached",
                            body: "Cached body",
                            publishedAt: "2026-10-08T00:00:00Z",
                        },
                    ],
                    timestamp: Date.now(),
                })
            );

            // Server returns HTML (SPA fallback)
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
                json: async () => {
                    throw new Error("SyntaxError: Unexpected token < in JSON");
                },
            });

            const result = await fetchAnnouncements(2000);
            expect(result.length).toBe(1);
            expect(result[0].id).toBe("cached-anno");
        });

        it("handles network error gracefully and returns cache", async () => {
            globalThis.fetch = vi.fn().mockRejectedValue(new Error("NetworkError: Failed to fetch"));

            const result = await fetchAnnouncements(2000);
            expect(result).toEqual([]);
        });
    });
});
