import { useMemo } from "react";
import type { Annotation, HighlightColor } from "../../core/types";
import { HIGHLIGHT_SOLID_COLORS } from "../../core/lib/design-tokens";
import { useSettingsStore } from "../../core/store";
import { TheoremLogo } from "../../shell/TheoremLogo";
import { TheoremBookCover } from "../../ui/TheoremBookCover";

export interface BookInfo {
    title: string;
    author: string;
}

export interface RecentlyReadBook {
    title: string;
    author: string;
    progress: number;
    coverUrl?: string;
    isCompleted?: boolean;
}

export interface StatsData {
    totalBooks: number;
    completedBooks: number;
    totalReadingTime: number;
    currentStreak: number;
    longestStreak: number;
    booksReadThisYear: number;
    yearlyBookGoal: number;
    totalHighlights: number;
    dailyActivity?: Array<{ date: string; minutes: number }>;
    recentlyReading?: RecentlyReadBook | RecentlyReadBook[];
}

export type CardFormat = "square" | "story";
export type CardTheme = "match" | "dark" | "tinted" | "sepia";

interface ShareCardProps {
    kind: "annotation" | "stats";
    annotation?: Annotation;
    book?: BookInfo;
    statsData?: StatsData;
    format: CardFormat;
    theme: CardTheme;
    showNote: boolean;
}

const CARD_WIDTH_PX = 1080;
const CARD_HEIGHTS = { square: 1080, story: 1920 };

function formatTime(minutes: number): string {
    if (minutes < 60) return `${minutes}m`;
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function getThemeStyles(
    theme: CardTheme,
    appTheme: "light" | "dark" | "system",
    appAccent: string,
    accent?: HighlightColor,
) {
    const defaultAccent = appAccent || "#c6f135";
    const tintAccent = accent ? HIGHLIGHT_SOLID_COLORS[accent] : defaultAccent;

    if (theme === "match") {
        const isDark = typeof document !== "undefined"
            ? document.body.classList.contains("theme-dark") ||
              appTheme === "dark" ||
              (appTheme === "system" && Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches))
            : appTheme === "dark";

        const customAccent = isDark || (appAccent && appAccent !== "#c6f135") ? (appAccent || "#c6f135") : "#1c1c1c";

        if (isDark) {
            return {
                bg: "#121316",
                fg: "#f2f0eb",
                subtext: "#a8a59e",
                accent: customAccent,
                cardBg: "rgba(255,255,255,0.06)",
                border: "rgba(255,255,255,0.12)",
                progressTrack: "rgba(255,255,255,0.14)",
            };
        }
        return {
            bg: "#faf8f5",
            fg: "#1a1918",
            subtext: "#57544f",
            accent: customAccent,
            cardBg: "rgba(0,0,0,0.04)",
            border: "rgba(0,0,0,0.1)",
            progressTrack: "rgba(0,0,0,0.1)",
        };
    }

    switch (theme) {
        case "dark":
            return {
                bg: "#121316",
                fg: "#f2f0eb",
                subtext: "#a8a59e",
                accent: "#c6f135",
                cardBg: "rgba(255,255,255,0.06)",
                border: "rgba(255,255,255,0.12)",
                progressTrack: "rgba(255,255,255,0.14)",
            };
        case "tinted":
            // Deep rich dark forest/obsidian tint with glowing accent borders & badges, high-contrast crisp text!
            return {
                bg: "#0d140e",
                fg: "#f4f8f4",
                subtext: "rgba(244,248,244,0.78)",
                accent: tintAccent,
                cardBg: "rgba(198,241,53,0.06)",
                border: "rgba(198,241,53,0.18)",
                progressTrack: "rgba(198,241,53,0.15)",
            };
        case "sepia":
            // Warm vintage paper with elevated cream stationery cards and rich espresso/bistre ink
            return {
                bg: "#f4ede2",
                fg: "#1a120b",
                subtext: "#594231",
                accent: "#9a3c08",
                cardBg: "rgba(255, 255, 255, 0.76)",
                border: "rgba(100, 70, 45, 0.16)",
                progressTrack: "rgba(100, 70, 45, 0.14)",
            };
        default:
            return {
                bg: "#faf8f5",
                fg: "#1a1918",
                subtext: "#57544f",
                accent: "#1a1918",
                cardBg: "rgba(0,0,0,0.04)",
                border: "rgba(0,0,0,0.1)",
                progressTrack: "rgba(0,0,0,0.1)",
            };
    }
}

export function ShareCard({ kind, annotation, book, statsData, format, theme, showNote }: ShareCardProps) {
    const appTheme = useSettingsStore((s) => s.settings.theme);
    const appAccent = useSettingsStore((s) => s.settings.accentColor);
    const height = CARD_HEIGHTS[format];
    const isStory = format === "story";
    const colors = useMemo(
        () => getThemeStyles(theme, appTheme, appAccent, annotation?.color),
        [theme, appTheme, appAccent, annotation?.color]
    );

    const text = annotation?.selectedText || "";
    const charCount = text.length;

    const quoteFontSize = useMemo(() => {
        if (!text) return 52;
        const isStory = format === "story";
        const maxWidth = 1080 - 160;
        const avgCharWidth = 0.55;
        const charsPerLine = Math.floor(maxWidth / (avgCharWidth * 48));
        const noteLines = (showNote && annotation?.noteContent) ? 4 : 0;
        const availableLines = isStory ? 20 - noteLines : 10 - noteLines;
        const maxChars = charsPerLine * availableLines;
        const minSize = 32;
        const maxSize = isStory ? 60 : 54;

        if (charCount <= 0) return maxSize;
        const ratio = Math.min(1, maxChars / Math.max(1, charCount));
        const size = minSize + (maxSize - minSize) * Math.pow(ratio, 0.7);
        return Math.round(Math.max(minSize, Math.min(maxSize, size)));
    }, [text, format, showNote, annotation?.noteContent]);

    const formattedDate = annotation?.createdAt
        ? new Date(annotation.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : null;

    const heatmapDays = useMemo(() => {
        const activityMap = new Map<string, number>();
        if (statsData?.dailyActivity) {
            for (const act of statsData.dailyActivity) {
                activityMap.set(act.date, act.minutes);
            }
        }
        const today = new Date();
        const days: Array<{ date: string; minutes: number; level: number }> = [];
        // 28 days: 4 weeks of 7 days
        for (let i = 27; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split("T")[0];
            const minutes = activityMap.get(dateStr) || 0;
            let level = 0;
            if (minutes > 0) level = 1;
            if (minutes >= 15) level = 2;
            if (minutes >= 30) level = 3;
            if (minutes >= 60) level = 4;
            days.push({ date: dateStr, minutes, level });
        }
        return days;
    }, [statsData?.dailyActivity]);

    const recentBooks: RecentlyReadBook[] = useMemo(() => {
        if (!statsData?.recentlyReading) return [];
        if (Array.isArray(statsData.recentlyReading)) {
            return statsData.recentlyReading.slice(0, 3);
        }
        return [statsData.recentlyReading];
    }, [statsData?.recentlyReading]);

    const cardContent = kind === "annotation" && annotation ? (
        <div style={{
            display: "flex",
            flexDirection: "column",
            height: "100%",
            fontFamily: "EB Garamond, Georgia, serif",
            padding: isStory ? "120px 88px" : "88px 88px",
            boxSizing: "border-box",
        }}>
            <div style={{ color: colors.accent, fontSize: 56, lineHeight: 1, marginBottom: 32, userSelect: "none" }}>
                &#10033;
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection:"column", justifyContent: "center" }}>
                {annotation.selectedText && (
                    <div style={{
                        fontSize: quoteFontSize,
                        lineHeight: 1.5,
                        color: colors.fg,
                        textAlign: "justify",
                        textJustify: "inter-word",
                        hyphens: "auto",
                    }}>
                        {annotation.selectedText}
                    </div>
                )}
                {showNote && annotation.noteContent && (
                    <div style={{
                        marginTop: annotation.selectedText ? 44 : 0,
                        paddingTop: annotation.selectedText ? 32 : 0,
                        borderTop: `1px solid ${colors.border}`,
                        fontSize: 26,
                        lineHeight: 1.6,
                        color: colors.fg,
                        opacity: 0.8,
                        fontFamily: "system-ui, -apple-system, sans-serif",
                    }}>
                        {annotation.noteContent}
                    </div>
                )}
            </div>
            <div style={{
                marginTop: 48,
                paddingTop: 28,
                borderTop: `1px solid ${colors.border}`,
                display: "flex",
                alignItems: "flex-end",
                justifyContent: "space-between",
                fontFamily: "system-ui, -apple-system, sans-serif",
            }}>
                <div>
                    <div style={{ fontSize: 26, fontWeight: 600, color: colors.fg, lineHeight: 1.3 }}>
                        {book?.title || "Untitled"}
                    </div>
                    {book?.author && (
                        <div style={{ fontSize: 20, color: colors.subtext, marginTop: 6, lineHeight: 1.3 }}>
                            {book.author}
                        </div>
                    )}
                    {formattedDate && (
                        <div style={{ fontSize: 18, color: colors.subtext, marginTop: 6, lineHeight: 1.3 }}>
                            {formattedDate}
                        </div>
                    )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ color: colors.accent, display: "flex", alignItems: "center" }}>
                        <TheoremLogo size={isStory ? 36 : 30} />
                    </div>
                    <span style={{ fontSize: isStory ? 24 : 20, fontWeight: 700, color: colors.fg, letterSpacing: "-0.01em" }}>
                        Theorem Reader
                    </span>
                </div>
            </div>
        </div>
    ) : statsData ? (
        <div style={{
            display: "flex",
            flexDirection: "column",
            height: "100%",
            fontFamily: "system-ui, -apple-system, sans-serif",
            padding: isStory ? "88px 84px 64px 84px" : "36px 56px 32px 56px",
            position: "relative",
            boxSizing: "border-box",
            justifyContent: "space-between",
        }}>
            {/* 1. Header Row */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
                <span style={{ fontSize: isStory ? 20 : 16, color: colors.subtext, fontWeight: 600 }}>
                    {new Date().toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                </span>
            </div>

            {/* 2. Hero Section: Total Reading Time (Clean, confident, no redundant label) */}
            <div style={{ marginTop: isStory ? 24 : 8, marginBottom: isStory ? 20 : 8 }}>
                <div style={{
                    fontSize: isStory ? 124 : 82,
                    fontWeight: 300,
                    color: colors.fg,
                    lineHeight: 0.95,
                    letterSpacing: "-0.03em",
                }}>
                    {statsData.totalReadingTime > 0 ? formatTime(statsData.totalReadingTime) : "0m"}
                </div>
            </div>

            {/* 3. Bento Metric Grid: 2x2 in Story, 1x4 in Square (Optimized without obvious redundant labels) */}
            <div style={{
                display: "grid",
                gridTemplateColumns: isStory ? "1fr 1fr" : "repeat(4, 1fr)",
                gap: isStory ? 20 : 12,
            }}>
                {/* Metric 1: Books Completed */}
                <div style={{
                    background: colors.cardBg,
                    border: `1px solid ${colors.border}`,
                    borderRadius: 0,
                    padding: isStory ? "24px 26px" : "12px 14px",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                }}>
                    <div style={{ fontSize: isStory ? 18 : 13, color: colors.subtext, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                        Books Read
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: isStory ? 10 : 6, marginTop: isStory ? 10 : 4 }}>
                        <span style={{ fontSize: isStory ? 52 : 34, fontWeight: 700, color: colors.fg, lineHeight: 1 }}>
                            {statsData.completedBooks}
                        </span>
                    </div>
                </div>

                {/* Metric 2: Streak */}
                <div style={{
                    background: colors.cardBg,
                    border: `1px solid ${colors.border}`,
                    borderRadius: 0,
                    padding: isStory ? "24px 26px" : "12px 14px",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                }}>
                    <div style={{ fontSize: isStory ? 18 : 13, color: colors.subtext, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                        Streak
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: isStory ? 8 : 4, marginTop: isStory ? 10 : 4 }}>
                        <span style={{ fontSize: isStory ? 52 : 34, fontWeight: 700, color: colors.accent, lineHeight: 1 }}>
                            {statsData.currentStreak}d
                        </span>
                        {statsData.longestStreak > 0 && (
                            <span style={{ fontSize: isStory ? 18 : 13, color: colors.subtext, fontWeight: 500 }}>
                                best {statsData.longestStreak}d
                            </span>
                        )}
                    </div>
                </div>

                {/* Metric 3: Yearly Goal */}
                <div style={{
                    background: colors.cardBg,
                    border: `1px solid ${colors.border}`,
                    borderRadius: 0,
                    padding: isStory ? "24px 26px" : "12px 14px",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                }}>
                    <div style={{ fontSize: isStory ? 18 : 13, color: colors.subtext, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                        Yearly Goal
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: isStory ? 8 : 4, marginTop: isStory ? 10 : 4 }}>
                        <span style={{ fontSize: isStory ? 44 : 26, fontWeight: 700, color: colors.fg, lineHeight: 1 }}>
                            {statsData.booksReadThisYear} <span style={{ fontSize: isStory ? 22 : 15, fontWeight: 500, color: colors.subtext }}>/ {statsData.yearlyBookGoal}</span>
                        </span>
                        <span style={{ fontSize: isStory ? 18 : 13, fontWeight: 700, color: colors.accent }}>
                            {Math.round((statsData.booksReadThisYear / Math.max(1, statsData.yearlyBookGoal)) * 100)}%
                        </span>
                    </div>
                </div>

                {/* Metric 4: Highlights */}
                <div style={{
                    background: colors.cardBg,
                    border: `1px solid ${colors.border}`,
                    borderRadius: 0,
                    padding: isStory ? "24px 26px" : "12px 14px",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                }}>
                    <div style={{ fontSize: isStory ? 18 : 13, color: colors.subtext, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                        Highlights
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: isStory ? 10 : 6, marginTop: isStory ? 10 : 4 }}>
                        <span style={{ fontSize: isStory ? 52 : 34, fontWeight: 700, color: colors.fg, lineHeight: 1 }}>
                            {statsData.totalHighlights}
                        </span>
                    </div>
                </div>
            </div>

            {/* 4. Activity Heatmap */}
            <div style={{
                background: colors.cardBg,
                border: `1px solid ${colors.border}`,
                borderRadius: 0,
                padding: isStory ? "28px 30px" : "14px 18px",
                display: "flex",
                flexDirection: "column",
                gap: isStory ? 16 : 8,
            }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: isStory ? 18 : 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: colors.subtext }}>
                            Reading Consistency
                        </span>
                        <span style={{ fontSize: isStory ? 17 : 13, color: colors.subtext, fontWeight: 500 }}>
                            • Last 4 Weeks
                        </span>
                    </div>
                    {/* Intensity Legend */}
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: isStory ? 15 : 12, color: colors.subtext, fontWeight: 500 }}>Less</span>
                        {[0, 1, 2, 3, 4].map((lvl) => (
                            <div
                                key={lvl}
                                style={{
                                    width: isStory ? 14 : 10,
                                    height: isStory ? 14 : 10,
                                    borderRadius: 0,
                                    background: lvl === 0 ? colors.border : colors.accent,
                                    opacity: lvl === 0 ? 0.35 : 0.3 + lvl * 0.175,
                                }}
                            />
                        ))}
                        <span style={{ fontSize: isStory ? 15 : 12, color: colors.subtext, fontWeight: 500 }}>More</span>
                    </div>
                </div>

                {/* 7 Columns x 4 Rows Grid */}
                <div style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(7, 1fr)",
                    gap: isStory ? 10 : 6,
                }}>
                    {heatmapDays.map((day, idx) => (
                        <div
                            key={idx}
                            style={{
                                height: isStory ? 44 : 20,
                                borderRadius: 0,
                                background: day.level === 0 ? colors.border : colors.accent,
                                opacity: day.level === 0 ? 0.3 : 0.3 + day.level * 0.175,
                                transition: "all 0.2s ease",
                            }}
                        />
                    ))}
                </div>
            </div>

            {/* 5. Recently Read (Top 3 with Cover Artworks, Clean, Direct on Canvas) */}
            {recentBooks.length > 0 ? (
                <div>
                    <div style={{
                        fontSize: isStory ? 17 : 14,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.12em",
                        color: colors.accent,
                        marginBottom: isStory ? 14 : 10,
                    }}>
                        Recently Read
                    </div>
                    <div style={{
                        display: "grid",
                        gridTemplateColumns: `repeat(${Math.min(3, recentBooks.length)}, 1fr)`,
                        gap: isStory ? 24 : 18,
                    }}>
                        {recentBooks.map((book, idx) => {
                            const isCompleted = Boolean(book.isCompleted || book.progress >= 0.99);
                            const progressPercent = Math.min(100, Math.round(book.progress * 100));
                            const cleanTitle = (book.title || "Untitled").replace(/_/g, " ").trim();

                            return (
                                <div key={idx} style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                                    {/* Cover Image Container (Clean, exact artwork, full width) */}
                                    <div style={{
                                        position: "relative",
                                        width: "100%",
                                        aspectRatio: "2 / 3",
                                        overflow: "hidden",
                                        border: `1px solid ${colors.border}`,
                                        background: colors.cardBg,
                                        boxShadow: "0 6px 18px rgba(0, 0, 0, 0.22)",
                                    }}>
                                        <TheoremBookCover
                                            title={cleanTitle}
                                            author={book.author}
                                            coverUrl={book.coverUrl}
                                            className="w-full h-full"
                                        />
                                    </div>

                                    {/* Metadata Row 1: Title */}
                                    <div style={{
                                        marginTop: isStory ? 12 : 8,
                                        fontSize: isStory ? 19 : 14,
                                        fontWeight: 700,
                                        color: colors.fg,
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                        lineHeight: 1.25,
                                    }}>
                                        {cleanTitle}
                                    </div>

                                    {/* Metadata Row 2: Author & Status (% or checkmark) */}
                                    <div style={{
                                        marginTop: 3,
                                        display: "flex",
                                        alignItems: "baseline",
                                        justifyContent: "space-between",
                                        gap: 6,
                                    }}>
                                        <div style={{
                                            fontSize: isStory ? 15 : 12,
                                            color: colors.subtext,
                                            fontWeight: 500,
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                            flex: 1,
                                        }}>
                                            {book.author || "Unknown"}
                                        </div>
                                        <span style={{
                                            fontSize: isStory ? 15 : 12,
                                            fontWeight: 700,
                                            color: colors.accent,
                                            flexShrink: 0,
                                            whiteSpace: "nowrap",
                                        }}>
                                            {isCompleted ? "✓ 100%" : `${progressPercent}%`}
                                        </span>
                                    </div>

                                    {/* Progress Bar */}
                                    <div style={{
                                        marginTop: isStory ? 8 : 5,
                                        height: isStory ? 5 : 4,
                                        background: colors.progressTrack,
                                        borderRadius: 0,
                                        overflow: "hidden",
                                    }}>
                                        <div style={{
                                            height: "100%",
                                            width: `${isCompleted ? 100 : progressPercent}%`,
                                            background: colors.accent,
                                            borderRadius: 0,
                                        }} />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ) : null}

            {/* 6. Footer Watermark */}
            <div style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                paddingTop: isStory ? 24 : 14,
                borderTop: `1px solid ${colors.border}`,
            }}>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    <div style={{ color: colors.accent, display: "flex", alignItems: "center" }}>
                        <TheoremLogo size={isStory ? 40 : 30} />
                    </div>
                    <span style={{
                        fontSize: isStory ? 24 : 19,
                        fontWeight: 700,
                        color: colors.fg,
                        letterSpacing: "-0.01em",
                    }}>
                        Theorem Reader
                    </span>
                </div>
                <span style={{ fontSize: isStory ? 18 : 14, color: colors.subtext, fontWeight: 500 }}>
                    theorem.fundaments.work
                </span>
            </div>
        </div>
    ) : null;

    return (
        <div style={{ width: CARD_WIDTH_PX, height, background: colors.bg, overflow: "hidden", position: "relative", boxSizing: "border-box" }}>
            {cardContent}
        </div>
    );
}
