import { useMemo } from "react";
import type { Annotation, HighlightColor } from "../../core/types";
import { HIGHLIGHT_SOLID_COLORS } from "../../core/lib/design-tokens";
import { useSettingsStore } from "../../core/store";

export interface BookInfo {
    title: string;
    author: string;
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
    recentlyReading?: {
        title: string;
        author: string;
        progress: number;
    };
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
    const tintBg = accent ? HIGHLIGHT_SOLID_COLORS[accent] : defaultAccent;

    if (theme === "match") {
        const isDark = typeof document !== "undefined"
            ? document.body.classList.contains("theme-dark") ||
              appTheme === "dark" ||
              (appTheme === "system" && Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches))
            : appTheme === "dark";

        // Lime fails contrast on paper (1.24:1), so light cards set the accent in ink.
        const customAccent = isDark || (appAccent && appAccent !== "#c6f135") ? (appAccent || "#c6f135") : "#1c1c1c";

        if (isDark) {
            return {
                bg: "#141416",
                fg: "#e8e6e1",
                accent: customAccent,
                cardBg: "rgba(255,255,255,0.06)",
                border: "rgba(255,255,255,0.1)",
            };
        }
        return {
            bg: "#faf9f7",
            fg: "#1c1c1c",
            accent: customAccent,
            cardBg: "rgba(0,0,0,0.04)",
            border: "rgba(0,0,0,0.08)",
        };
    }

    switch (theme) {
        case "dark":
            return { bg: "#141416", fg: "#e8e6e1", accent: "#c6f135", cardBg: "rgba(255,255,255,0.06)", border:"rgba(255,255,255,0.1)" };
        case "tinted":
            return { bg: tintBg, fg: "#ffffff", accent: "#ffffff", cardBg: "rgba(255,255,255,0.15)", border:"rgba(255,255,255,0.2)" };
        case "sepia":
            return { bg: "#f6ede0", fg: "#38291a", accent: "#8c532b", cardBg: "rgba(56,41,26,0.06)", border:"rgba(56,41,26,0.1)" };
        default:
            return { bg: "#faf9f7", fg: "#1c1c1c", accent: "#1c1c1c", cardBg: "rgba(0,0,0,0.04)", border:"rgba(0,0,0,0.08)" };
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
                    <div style={{ fontSize: 26, fontWeight: 400, color: colors.fg, lineHeight: 1.3 }}>
                        {book?.title || "Untitled"}
                    </div>
                    {book?.author && (
                        <div style={{ fontSize: 20, color: colors.fg, opacity: 0.7, marginTop: 6, lineHeight: 1.3 }}>
                            {book.author}
                        </div>
                    )}
                    {formattedDate && (
                        <div style={{ fontSize: 18, color: colors.fg, opacity: 0.5, marginTop: 6, lineHeight: 1.3 }}>
                            {formattedDate}
                        </div>
                    )}
                </div>
                <div style={{ fontSize: 18, fontWeight: 400, color: colors.fg, opacity: 0.35 }}>
                    Theorem
                </div>
            </div>
        </div>
    ) : statsData ? (
        <div style={{
            display: "flex",
            flexDirection: "column",
            height: "100%",
            fontFamily: "system-ui, -apple-system, sans-serif",
            padding: isStory ? "108px 84px" : "80px 84px",
            position: "relative",
            boxSizing: "border-box",
            justifyContent: "space-between",
        }}>
            {/* Header */}
            <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: isStory ? 36 : 28 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ width: 12, height: 12, borderRadius: "50%", background: colors.accent }} />
                        <span style={{ fontSize: 18, fontWeight: 400, color: colors.accent }}>
                            Reading Stats
                        </span>
                    </div>
                    <span style={{ fontSize: 18, color: colors.fg, opacity: 0.5, fontWeight: 400 }}>
                        {new Date().toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                    </span>
                </div>

                {/* Hero Stat: Total Reading Time */}
                <div style={{ marginBottom: isStory ? 48 : 36 }}>
                    <div style={{
                        fontSize: isStory ? 104 : 92,
                        fontWeight: 400,
                        color: colors.fg,
                        
                        lineHeight: 1,
                        marginBottom: 10,
                    }}>
                        {statsData.totalReadingTime > 0 ? formatTime(statsData.totalReadingTime) : "0m"}
                    </div>
                    <div style={{ fontSize: 22, color: colors.fg, opacity: 0.55, fontWeight: 400 }}>
                        Total time spent reading
                    </div>
                </div>

                {/* 3 Metric Cards Grid */}
                <div style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 1fr",
                    gap: 16,
                    padding: "28px 24px",
                    background: colors.cardBg,
                    border: `1px solid ${colors.border}`,
                    borderRadius: 20,
                    marginBottom: isStory ? 40 : 32,
                }}>
                    <div>
                        <div style={{ fontSize: 44, fontWeight: 400, color: colors.fg, lineHeight: 1.1 }}>
                            {statsData.completedBooks}
                        </div>
                        <div style={{ fontSize: 18, color: colors.fg, opacity: 0.6, marginTop: 6, fontWeight: 400 }}>
                            Books Read
                        </div>
                    </div>
                    <div>
                        <div style={{ fontSize: 44, fontWeight: 400, color: colors.accent, lineHeight: 1.1 }}>
                            {statsData.currentStreak}d
                        </div>
                        <div style={{ fontSize: 18, color: colors.fg, opacity: 0.6, marginTop: 6, fontWeight: 400 }}>
                            Current Streak
                        </div>
                    </div>
                    <div>
                        <div style={{ fontSize: 44, fontWeight: 400, color: colors.fg, lineHeight: 1.1 }}>
                            {statsData.booksReadThisYear}/{statsData.yearlyBookGoal}
                        </div>
                        <div style={{ fontSize: 18, color: colors.fg, opacity: 0.6, marginTop: 6, fontWeight: 400 }}>
                            Yearly Goal
                        </div>
                    </div>
                </div>

                {/* Best Streak & Highlights */}
                {statsData.longestStreak > 0 && (
                    <div style={{ marginBottom: isStory ? 36 : 28 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 19, color: colors.fg, opacity: 0.7, marginBottom: 12, fontWeight: 400 }}>
                            <span>Best Streak: <strong style={{ color: colors.accent, fontWeight: 400 }}>{statsData.longestStreak} days</strong></span>
                            <span>{statsData.totalHighlights} highlights taken</span>
                        </div>
                        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap:"wrap" }}>
                            {Array.from({ length: Math.min(statsData.currentStreak, 24) }).map((_, i) => (
                                <div
                                    key={i}
                                    style={{
                                        width: 16,
                                        height: 16,
                                        borderRadius: "50%",
                                        background: colors.accent,
                                        opacity: 0.35 + (i / Math.min(statsData.currentStreak, 24)) * 0.65,
                                    }}
                                />
                            ))}
                            {statsData.currentStreak > 24 && (
                                <span style={{ fontSize: 16, color: colors.fg, opacity: 0.5, marginLeft: 4, fontWeight: 400 }}>
                                    +{statsData.currentStreak - 24}
                                </span>
                            )}
                        </div>
                    </div>
                )}

                {/* Yearly Goal Progress Bar */}
                {statsData.yearlyBookGoal > 0 && (
                    <div style={{ marginBottom: isStory ? 36 : 28 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 18, color: colors.fg, opacity: 0.7, marginBottom: 10, fontWeight: 400 }}>
                            <span>Yearly Reading Challenge</span>
                            <span>{Math.round((statsData.booksReadThisYear / Math.max(1, statsData.yearlyBookGoal)) * 100)}%</span>
                        </div>
                        <div style={{ height: 12, background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 6, overflow: "hidden" }}>
                            <div
                                style={{
                                    height: "100%",
                                    width: `${Math.min(100, (statsData.booksReadThisYear / Math.max(1, statsData.yearlyBookGoal)) * 100)}%`,
                                    background: colors.accent,
                                    borderRadius: 6,
                                }}
                            />
                        </div>
                    </div>
                )}
            </div>

            {/* Footer */}
            <div style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                paddingTop: 24,
                borderTop: `1px solid ${colors.border}`,
            }}>
                {statsData.recentlyReading ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flex: 1, paddingRight: 16 }}>
                        <div style={{ width: 4, height: 36, background: colors.accent, borderRadius: 2, flexShrink: 0 }} />
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 14, color: colors.fg, opacity: 0.5, fontWeight: 400 }}>
                                Currently Reading
                            </div>
                            <div style={{ fontSize: 20, color: colors.fg, fontWeight: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {statsData.recentlyReading.title}
                            </div>
                        </div>
                    </div>
                ) : <div />}
                <div style={{ fontSize: 18, fontWeight: 400, color: colors.fg, opacity: 0.35, flexShrink: 0 }}>
                    Theorem
                </div>
            </div>
        </div>
    ) : null;

    return (
        <div style={{ width: CARD_WIDTH_PX, height, background: colors.bg, overflow: "hidden", position: "relative", boxSizing: "border-box" }}>
            {cardContent}
        </div>
    );
}
