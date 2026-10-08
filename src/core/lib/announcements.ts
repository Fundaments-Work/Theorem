/**
 * Remote Announcement Engine for Theorem.
 *
 * Implements client-side fetching, schema validation, active announcement selection,
 * local caching (24h TTL), dismiss tracking, and zero-HTML text linkification.
 */

export type AnnouncementSeverity = "info" | "warning" | "critical";

export interface Announcement {
    id: string;
    severity: AnnouncementSeverity;
    title: string;
    body: string;
    link?: string;
    linkLabel?: string;
    publishedAt: string;
    expiresAt?: string | null;
    [key: string]: unknown;
}

export type TextSegment =
    | { kind: "text"; value: string }
    | { kind: "link"; value: string; href: string };

export interface InlineNode {
    bold: boolean;
    value: string;
}

export const ANNOUNCEMENT_ENDPOINT = "https://announcements.fundaments.work/api/announcements";
export const ANNOUNCEMENTS_CACHE_KEY = "theorem-announcements-cache";
export const ANNOUNCEMENTS_DISMISSED_KEY = "theorem-announcements:dismissed";
export const ANNOUNCEMENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const SEVERITY_WEIGHTS: Record<AnnouncementSeverity, number> = {
    critical: 3,
    warning: 2,
    info: 1,
};

/**
 * Validates that a string is a safe HTTPS URL with no user/password credentials.
 */
export function isSafeHttpUrl(raw: string): boolean {
    if (!raw || typeof raw !== "string") return false;
    try {
        const parsed = new URL(raw);
        return parsed.protocol === "https:" && !parsed.username && !parsed.password;
    } catch {
        return false;
    }
}

/**
 * Parses announcement body text into text and link segments.
 *
 * - Only bare https:// URLs are linkified.
 * - Non-https or credentialed URLs remain plain text.
 * - Trailing sentence punctuation (.,;:!?)]}') is excluded from the href unless part of balanced parentheses.
 * - At most `max` (default 5) links are converted; subsequent URLs remain plain text.
 */
export function linkifySegments(body: string, max = 5): TextSegment[] {
    if (!body) return [];

    // Match potential https:// URLs
    const urlPattern = /https:\/\/[^\s]+/g;
    const segments: TextSegment[] = [];
    const pushText = (text: string) => {
        if (!text) return;
        const last = segments[segments.length - 1];
        if (last && last.kind === "text") {
            last.value += text;
        } else {
            segments.push({ kind: "text", value: text });
        }
    };

    let lastIndex = 0;
    let linkCount = 0;
    let match: RegExpExecArray | null;

    while ((match = urlPattern.exec(body)) !== null) {
        const rawUrl = match[0];
        const matchIndex = match.index;

        // Any text before the URL
        if (matchIndex > lastIndex) {
            pushText(body.slice(lastIndex, matchIndex));
        }

        // Split potential trailing punctuation from rawUrl
        let cleanUrl = rawUrl;
        let trailingPunctuation = "";

        while (cleanUrl.length > 0) {
            const lastChar = cleanUrl.slice(-1);
            if (/[.,;:!?'"\]}]/.test(lastChar)) {
                trailingPunctuation = lastChar + trailingPunctuation;
                cleanUrl = cleanUrl.slice(0, -1);
            } else if (lastChar === ")") {
                // If closing parenthesis is unbalanced in the URL, it belongs to surrounding text
                const openCount = (cleanUrl.match(/\(/g) || []).length;
                const closeCount = (cleanUrl.match(/\)/g) || []).length;
                if (closeCount > openCount) {
                    trailingPunctuation = lastChar + trailingPunctuation;
                    cleanUrl = cleanUrl.slice(0, -1);
                } else {
                    break;
                }
            } else {
                break;
            }
        }

        if (linkCount < max && isSafeHttpUrl(cleanUrl)) {
            segments.push({ kind: "link", value: cleanUrl, href: cleanUrl });
            linkCount++;
            if (trailingPunctuation) {
                pushText(trailingPunctuation);
            }
        } else {
            // Demote to plain text if max reached or not safe
            pushText(rawUrl);
        }

        lastIndex = matchIndex + rawUrl.length;
    }

    if (lastIndex < body.length) {
        pushText(body.slice(lastIndex));
    }

    return segments;
}

/**
 * Parses bold markdown tokens (**text**) into structured inline nodes.
 * Unpaired ** delimiters are preserved verbatim as non-bold text.
 */
export function renderInlineBold(text: string): InlineNode[] {
    if (!text) return [];
    if (!text.includes("**")) {
        return [{ bold: false, value: text }];
    }

    const nodes: InlineNode[] = [];
    const parts = text.split("**");

    // If an odd number of delimiters exists (even number of parts), the last ** is unpaired
    const hasUnpaired = parts.length % 2 === 0;

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (hasUnpaired && i === parts.length - 1) {
            // Append literal ** and remaining text to the previous node or as a new node
            const literalValue = "**" + part;
            if (nodes.length > 0 && !nodes[nodes.length - 1].bold) {
                nodes[nodes.length - 1].value += literalValue;
            } else {
                nodes.push({ bold: false, value: literalValue });
            }
            break;
        }

        const isBold = i % 2 === 1;
        if (part.length > 0) {
            nodes.push({ bold: isBold, value: part });
        }
    }

    return nodes;
}

/**
 * Validates and sanitizes a raw server response into typed Announcement items.
 * Drops malformed entries rather than throwing.
 */
export function parseAnnouncements(raw: unknown): Announcement[] {
    if (!raw || typeof raw !== "object") {
        return [];
    }

    let items: unknown[];
    if (Array.isArray(raw)) {
        items = raw;
    } else if (Array.isArray((raw as { announcements?: unknown[] }).announcements)) {
        items = (raw as { announcements: unknown[] }).announcements;
    } else {
        return [];
    }

    const valid: Announcement[] = [];

    for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const candidate = item as Record<string, unknown>;

        const id = candidate.id;
        const title = candidate.title;
        const body = candidate.body;
        const severity = candidate.severity;
        const publishedAt = candidate.publishedAt;
        const expiresAt = candidate.expiresAt;
        const link = candidate.link;
        const linkLabel = candidate.linkLabel;

        if (typeof id !== "string" || !id.trim()) continue;
        if (typeof title !== "string" || !title.trim()) continue;
        if (typeof body !== "string") continue;
        if (severity !== "info" && severity !== "warning" && severity !== "critical") continue;

        if (typeof publishedAt !== "string" || isNaN(Date.parse(publishedAt))) continue;

        let validExpiresAt: string | null | undefined = undefined;
        if (expiresAt !== null && expiresAt !== undefined) {
            if (typeof expiresAt !== "string" || isNaN(Date.parse(expiresAt))) continue;
            validExpiresAt = expiresAt;
        } else if (expiresAt === null) {
            validExpiresAt = null;
        }

        let validLink: string | undefined = undefined;
        if (typeof link === "string" && isSafeHttpUrl(link)) {
            validLink = link;
        }

        valid.push({
            ...candidate,
            id,
            severity,
            title,
            body,
            link: validLink,
            linkLabel: typeof linkLabel === "string" ? linkLabel : undefined,
            publishedAt,
            expiresAt: validExpiresAt,
        });
    }

    return valid;
}

/**
 * Pure selection rule: selects the highest-priority active announcement.
 *
 * Precedence:
 * 1. Filter out dismissed IDs.
 * 2. Filter out future publishedAt timestamps.
 * 3. Filter out expired items (expiresAt <= now).
 * 4. Rank by severity: critical > warning > info.
 * 5. Tiebreak by most recent publishedAt date.
 */
export function selectActive(
    announcements: Announcement[],
    now = Date.now(),
    dismissedIds?: Set<string> | string[]
): Announcement | null {
    if (!Array.isArray(announcements) || announcements.length === 0) {
        return null;
    }

    const dismissedSet = dismissedIds instanceof Set
        ? dismissedIds
        : new Set(Array.isArray(dismissedIds) ? dismissedIds : []);

    const eligible = announcements.filter((a) => {
        if (dismissedSet.has(a.id)) return false;

        const pubTime = Date.parse(a.publishedAt);
        if (isNaN(pubTime) || pubTime > now) return false;

        if (a.expiresAt) {
            const expTime = Date.parse(a.expiresAt);
            if (!isNaN(expTime) && expTime <= now) return false;
        }

        return true;
    });

    if (eligible.length === 0) return null;

    eligible.sort((a, b) => {
        const severityDiff = (SEVERITY_WEIGHTS[b.severity] || 0) - (SEVERITY_WEIGHTS[a.severity] || 0);
        if (severityDiff !== 0) return severityDiff;

        return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
    });

    return eligible[0] ?? null;
}

/**
 * Retrieves the set of dismissed announcement IDs from localStorage.
 */
export function getDismissedAnnouncementIds(): Set<string> {
    if (typeof localStorage === "undefined") return new Set();
    try {
        const raw = localStorage.getItem(ANNOUNCEMENTS_DISMISSED_KEY);
        if (!raw) return new Set();
        const parsed = JSON.parse(raw);
        return new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
        return new Set();
    }
}

/**
 * Persists a dismissed announcement ID to localStorage.
 */
export function dismissAnnouncement(id: string): void {
    if (!id || typeof localStorage === "undefined") return;
    try {
        const current = getDismissedAnnouncementIds();
        current.add(id);
        localStorage.setItem(ANNOUNCEMENTS_DISMISSED_KEY, JSON.stringify(Array.from(current)));
    } catch {
        // Storage failure or quota exceeded — fail gracefully
    }
}

/**
 * Fetches announcements from the remote worker endpoint with timeout and local cache fallback.
 */
export async function fetchAnnouncements(
    timeoutMs = 8000,
    endpoint = ANNOUNCEMENT_ENDPOINT
): Promise<Announcement[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(endpoint, {
            signal: controller.signal,
            headers: {
                Accept: "application/json",
            },
        });

        if (response.ok) {
            const data = await response.json();
            const parsed = parseAnnouncements(data);

            if (typeof localStorage !== "undefined") {
                try {
                    localStorage.setItem(
                        ANNOUNCEMENTS_CACHE_KEY,
                        JSON.stringify({ data: parsed, timestamp: Date.now() })
                    );
                } catch {
                    /* ignore storage errors */
                }
            }

            return parsed;
        }
    } catch {
        /* network error or timeout — fallback to cached data */
    } finally {
        clearTimeout(timer);
    }

    // Attempt cache read
    if (typeof localStorage !== "undefined") {
        try {
            const cachedRaw = localStorage.getItem(ANNOUNCEMENTS_CACHE_KEY);
            if (cachedRaw) {
                const cached = JSON.parse(cachedRaw);
                if (cached && Array.isArray(cached.data)) {
                    return parseAnnouncements(cached.data);
                }
            }
        } catch {
            /* ignore corrupted cache */
        }
    }

    return [];
}
