// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ShareCard, type StatsData } from "../src/features/share/ShareCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockStats: StatsData = {
    totalBooks: 12,
    completedBooks: 5,
    totalReadingTime: 3653, // ~60h 53m
    currentStreak: 4,
    longestStreak: 11,
    booksReadThisYear: 5,
    yearlyBookGoal: 24,
    totalHighlights: 337,
    dailyActivity: [
        { date: "2026-10-28", minutes: 45 },
        { date: "2026-10-29", minutes: 70 },
        { date: "2026-10-30", minutes: 20 },
    ],
    recentlyReading: {
        title: "A Mind at Play",
        author: "Jimmy Soni",
        progress: 0.42,
    },
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => {
        root?.unmount();
    });
    root = null;
    host?.remove();
    host = null;
});

describe("ShareCard Component", () => {
    it("renders Bento Grid metrics accurately in Story format", async () => {
        await act(async () => {
            root!.render(
                <ShareCard
                    kind="stats"
                    statsData={mockStats}
                    format="story"
                    theme="dark"
                    showNote={false}
                />
            );
        });

        // Header (Reading Report removed, date present)
        expect(host?.textContent).not.toContain("Reading Report");
        // Hero Time (Clean, prominent reading time without redundant label)
        expect(host?.textContent).toContain("60h 53m");
        expect(host?.textContent).not.toContain("Total time spent reading");

        // 4 Bento Cards (Optimized, no redundant obvious labels)
        expect(host?.textContent).toContain("Books Read");
        expect(host?.textContent).toContain("5");
        expect(host?.textContent).not.toContain("of 12 total");

        expect(host?.textContent).toContain("Streak");
        expect(host?.textContent).toContain("4d");
        expect(host?.textContent).toContain("best 11d");

        expect(host?.textContent).toContain("Yearly Goal");
        expect(host?.textContent).toContain("21%"); // 5/24 = 21%
        expect(host?.textContent).toContain("5 / 24");

        expect(host?.textContent).toContain("Highlights");
        expect(host?.textContent).toContain("337");

        // Activity Heatmap
        expect(host?.textContent).toContain("Reading Consistency");
        expect(host?.textContent).toContain("• Last 4 Weeks");

        // Recently Read
        expect(host?.textContent).toContain("Recently Read");
        expect(host?.textContent).toContain("A Mind at Play");
        expect(host?.textContent).toContain("Jimmy Soni");
        expect(host?.textContent).toContain("42%");
        expect(host?.textContent).not.toContain("CURRENT");

        // Footer
        expect(host?.textContent).toContain("Theorem");
        expect(host?.textContent).not.toContain("Theorem Reader");
        expect(host?.textContent).toContain("theorem.fundaments.work");
    });

    it("renders accurately in Square format with high-contrast Sepia theme and TheoremLogo", async () => {
        await act(async () => {
            root!.render(
                <ShareCard
                    kind="stats"
                    statsData={mockStats}
                    format="square"
                    theme="sepia"
                    showNote={false}
                />
            );
        });

        const card = host?.firstElementChild as HTMLElement;
        expect(card).not.toBeNull();
        // Sepia theme background is warm paper (#f4ede2 -> rgb(244, 237, 226))
        expect(card.style.background).toBe("rgb(244, 237, 226)");

        expect(host?.textContent).not.toContain("Reading Report");
        expect(host?.textContent).toContain("60h 53m");
        expect(host?.textContent).toContain("A Mind at Play");
        expect(host?.textContent).toContain("Theorem");
        expect(host?.textContent).not.toContain("Theorem Reader");

        // Asserts TheoremLogo SVG is rendered in footer
        const svgs = host?.querySelectorAll("svg");
        expect(svgs?.length).toBeGreaterThanOrEqual(1);
        const logoSvg = Array.from(svgs || []).find((s) => s.getAttribute("viewBox") === "0 0 24 24");
        expect(logoSvg).toBeDefined();
    });

    it("uses dark obsidian background for tinted theme to ensure high contrast", async () => {
        await act(async () => {
            root!.render(
                <ShareCard
                    kind="stats"
                    statsData={mockStats}
                    format="story"
                    theme="tinted"
                    showNote={false}
                />
            );
        });

        const card = host?.firstElementChild as HTMLElement;
        expect(card).not.toBeNull();
        // The background must be deep forest/obsidian (#0d140e), not electric neon lime (#c6f135)
        expect(card.style.background).not.toBe("#c6f135");
        expect(card.style.background).toBe("rgb(13, 20, 14)"); // #0d140e in rgb
    });

    it("renders TheoremLogo and Theorem Reader in annotation card footer", async () => {
        await act(async () => {
            root!.render(
                <ShareCard
                    kind="annotation"
                    annotation={{
                        id: "anno-1",
                        bookId: "book-1",
                        location: "epubcfi(/6/2[chap1]!/4/2)",
                        type: "highlight",
                        selectedText: "The essence of information is surprise.",
                        color: "yellow",
                        createdAt: new Date(1700000000000),
                    }}
                    book={{
                        title: "The Information",
                        author: "James Gleick",
                    }}
                    format="square"
                    theme="sepia"
                    showNote={false}
                />
            );
        });

        expect(host?.textContent).toContain("The essence of information is surprise.");
        expect(host?.textContent).toContain("The Information");
        expect(host?.textContent).toContain("James Gleick");
        expect(host?.textContent).toContain("Theorem Reader");

        const svgs = host?.querySelectorAll("svg");
        const logoSvg = Array.from(svgs || []).find((s) => s.getAttribute("viewBox") === "0 0 24 24");
        expect(logoSvg).toBeDefined();
    });

    it("renders top 3 recently read books with sharp geometric styling", async () => {
        const statsWith3Books: StatsData = {
            ...mockStats,
            recentlyReading: [
                { title: "A Mind at Play", author: "Jimmy Soni", progress: 0.42 },
                { title: "Sapiens", author: "Yuval Noah Harari", progress: 1.0, isCompleted: true },
                { title: "Atomic Habits", author: "James Clear", progress: 1.0, isCompleted: true },
            ],
        };

        await act(async () => {
            root!.render(
                <ShareCard
                    kind="stats"
                    statsData={statsWith3Books}
                    format="story"
                    theme="sepia"
                    showNote={false}
                />
            );
        });

        expect(host?.textContent).toContain("Recently Read");

        expect(host?.textContent).not.toContain("CURRENT");
        expect(host?.textContent).not.toContain("In Progress");
        expect(host?.textContent).toContain("A Mind at Play");
        expect(host?.textContent).toContain("Jimmy Soni");
        expect(host?.textContent).toContain("42%");

        expect(host?.textContent).toContain("Sapiens");
        expect(host?.textContent).toContain("Yuval Noah Harari");
        expect(host?.textContent).toContain("✓ 100%");

        expect(host?.textContent).toContain("Atomic Habits");
        expect(host?.textContent).toContain("James Clear");
    });
});
