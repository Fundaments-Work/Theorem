
import { useState, useMemo, memo } from "react";
import { cn, normalizeAuthor, formatReadingTime } from "../../core/lib/utils";
import { HIGHLIGHT_SOLID_COLORS } from "../../core/lib/design-tokens";
import { PageHeader, TheoremBookCover } from "../../ui";
import { useLibraryStore, useSettingsStore, useUIStore } from "../../core/store";
import { countBooksReadThisYear, isBookCompleted } from "../../core/lib/statistics";
import type { DailyReadingActivity } from "../../core/types";
import {
    BookOpen,
    Clock,
    Target,
    Flame,
    Trophy,
    TrendingUp,
    ChevronRight,
    Star,
    Bookmark,
    Highlighter,
    Share2,
} from "lucide-react";
import { ShareCardModal } from "../share/ShareCardModal";
import { localDateKey } from "../../core/lib/date-keys";

interface StatCardProps {
    icon: React.ReactNode;
    label: string;
    value: string | number;
    subtext?: string;
    trend?: "up" | "down" | "neutral";
}

function StatCard({ icon, label, value, subtext }: StatCardProps) {
    return (
        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5 hover:border-[var(--color-text-muted)] transition-colors min-w-0">
            <div className="flex items-start justify-between">
                <div className="p-2 sm:p-2.5 bg-[var(--color-surface-muted)] text-[color:var(--color-text-primary)]">
                    {icon}
                </div>
            </div>
            <div className="mt-3 sm:mt-4">
                <p className="text-xl sm:text-2xl font-bold text-[color:var(--color-text-primary)] truncate">{value}</p>
                <p className="text-xs sm:text-sm text-[color:var(--color-text-muted)] mt-0.5">{label}</p>
                {subtext && (
                    <p className="text-xs text-[color:var(--color-text-secondary)] mt-1 sm:mt-2 leading-snug">{subtext}</p>
                )}
            </div>
        </div>
    );
}

function ProgressBar({
    current,
    target,
    label,
    unit,
}: {
    current: number;
    target: number;
    label: string;
    unit?: string;
}) {
    const percentage = Math.min(100, (current / Math.max(1, target)) * 100);

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between text-sm gap-2">
                <span className="text-[color:var(--color-text-secondary)] truncate">{label}</span>
                <span className="text-[color:var(--color-text-primary)] font-medium shrink-0">
                    {current} / {target}{unit ? ` ${unit}` : ""}
                </span>
            </div>
            <div className="h-2 bg-[var(--color-surface-muted)] overflow-hidden">
                <div
                    className="h-full bg-[var(--color-accent)] transition-colors duration-500"
                    style={{ width: `${percentage}%` }}
                />
            </div>
        </div>
    );
}

function getDateTimestamp(dateValue: unknown): number {
    if (!dateValue) return 0;
    const parsedDate = dateValue instanceof Date ? dateValue : new Date(dateValue as string | number);
    const timestamp = parsedDate.getTime();
    return Number.isNaN(timestamp) ? 0 : timestamp;
}

interface RecentBookCardProps {
    book: {
        id: string;
        title: string;
        author: string;
        coverPath?: string;
        progress: number;
        lastReadAt?: Date;
    };
    onClick: () => void;
}

const RecentBookCard = memo(function RecentBookCard({ book, onClick }: RecentBookCardProps) {
    return (
        <button
            onClick={onClick}
            className="flex items-center gap-3 sm:gap-4 p-3 border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-text-muted)] transition-colors text-left w-full min-w-0"
        >
            <div className="w-10 h-14 sm:w-12 sm:h-16 shrink-0 overflow-hidden shadow-sm">
                <TheoremBookCover
                    title={book.title}
                    author={book.author}
                    coverUrl={book.coverPath}
                />
            </div>
            <div className="flex-1 min-w-0">
                <h4 className="font-medium text-sm text-[color:var(--color-text-primary)] truncate">
                    {book.title}
                </h4>
                <p className="text-xs text-[color:var(--color-text-secondary)] truncate">
                    {normalizeAuthor(book.author) || "Unknown Author"}
                </p>
                <div className="flex items-center gap-2 mt-2">
                    <div className="flex-1 h-1.5 bg-[var(--color-surface-muted)] overflow-hidden">
                        <div
                            className="h-full bg-[var(--color-accent)]"
                            style={{ width: `${book.progress * 100}%` }}
                        />
                    </div>
                    <span className="text-xs text-[color:var(--color-text-muted)] shrink-0">
                        {Math.round(book.progress * 100)}%
                    </span>
                </div>
            </div>
            <ChevronRight className="w-4 h-4 text-[color:var(--color-text-muted)] shrink-0" />
        </button>
    );
});

function ActivityHeatmap({ dailyActivity }: { dailyActivity: DailyReadingActivity[] | undefined }) {
    const weeks = useMemo(() => {
        const data: { level: number; dateStr: string }[][] = [];
        const today = new Date();

        const activityMap = new Map<string, number>();
        (dailyActivity || []).forEach(activity => {
            activityMap.set(activity.date, activity.minutes);
        });

        for (let weekIndex = 0; weekIndex < 12; weekIndex++) {
            const week: { level: number; dateStr: string }[] = [];
            for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
                const dayOffset = (11 - weekIndex) * 7 + (6 - dayIndex);
                const date = new Date(today);
                date.setDate(date.getDate() - dayOffset);
                const dateStr = localDateKey(date);

                const minutes = activityMap.get(dateStr) || 0;
                let level = 0;
                if (minutes > 0) level = 1;
                if (minutes >= 15) level = 2;
                if (minutes >= 30) level = 3;
                if (minutes >= 60) level = 4;
                week.push({ level, dateStr });
            }
            data.push(week.reverse());
        }
        return data;
    }, [dailyActivity]);

    const getColor = (level: number) => {
        switch (level) {
            case 0: return "bg-[var(--color-surface-muted)]";
            case 1: return "bg-[var(--color-accent)]/20";
            case 2: return "bg-[var(--color-accent)]/40";
            case 3: return "bg-[var(--color-accent)]/60";
            case 4: return "bg-[var(--color-accent)]";
            default: return "bg-[var(--color-surface-muted)]";
        }
    };

    const todayStr = localDateKey();
    const todayMinutes = (dailyActivity || []).find(a => a.date === todayStr)?.minutes || 0;

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-[color:var(--color-text-primary)]">Reading Activity</span>
                <span className="text-xs text-[color:var(--color-text-muted)]">Last 12 weeks</span>
            </div>
            
            <div className="overflow-x-auto -mx-1 px-1 pb-1">
                <div className="flex gap-[3px] w-full justify-between" style={{ minWidth: "max-content" }}>
                    {weeks.map((week, weekIndex) => (
                        <div key={weekIndex} className="flex flex-col gap-[3px] flex-1">
                            {week.map((day, dayIndex) => (
                                <div
                                    key={dayIndex}
                                    className={cn("w-4 h-4 sm:w-[18px] sm:h-[18px]", getColor(day.level))}
                                    title={`${day.dateStr} — level ${day.level}`}
                                />
                            ))}
                        </div>
                    ))}
                </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-[color:var(--color-text-muted)]">
                <span>Less</span>
                {[0, 1, 2, 3, 4].map((level) => (
                    <div key={level} className={cn("w-4 h-4 sm:w-[18px] sm:h-[18px]", getColor(level))} />
                ))}
                <span>More</span>
            </div>
            <p className="text-xs text-[color:var(--color-text-muted)]">
                Today: {todayMinutes} minute{todayMinutes === 1 ? '' : 's'} read
            </p>
        </div>
    );
}

export function StatisticsPage() {
    const books = useLibraryStore((state) => state.books);
    const annotations = useLibraryStore((state) => state.annotations);
    const stats = useSettingsStore((state) => state.stats);
    const setRoute = useUIStore((state) => state.setRoute);
    const [showShareModal, setShowShareModal] = useState(false);

    const todayStr = useMemo(() => localDateKey(), []);
    const todayMinutes = useMemo(() => {
        return (stats.dailyActivity || []).find((a) => a.date === todayStr)?.minutes || 0;
    }, [stats.dailyActivity, todayStr]);

    const booksReadThisYear = useMemo(() => countBooksReadThisYear(books), [books]);

    const shareStatsData = useMemo(() => {
        const completedBooks = books.filter((book) => {
            if (book.manualCompletionState === "read") return true;
            if (book.manualCompletionState === "unread") return false;
            return !!book.completedAt || book.progress >= 0.99;
        });

        const currentlyReading = [...books]
            .filter((b) => b.lastReadAt && b.progress > 0 && b.progress < 0.99 && b.manualCompletionState !== "read")
            .sort((a, b) => getDateTimestamp(b.lastReadAt) - getDateTimestamp(a.lastReadAt))[0];

        return {
            totalBooks: books.length,
            completedBooks: completedBooks.length,
            totalReadingTime: stats.totalReadingTime,
            currentStreak: stats.currentStreak,
            longestStreak: stats.longestStreak,
            booksReadThisYear,
            yearlyBookGoal: stats.yearlyBookGoal,
            totalHighlights: annotations.filter((a) => a.type === "highlight").length,
            recentlyReading: currentlyReading
                ? {
                      title: currentlyReading.title,
                      author: currentlyReading.author || "",
                      progress: currentlyReading.progress,
                  }
                : undefined,
        };
    }, [books, stats, annotations]);

    const totalBooks = books.length;
    const completedBooks = useMemo(() => books.filter((book) => isBookCompleted(book)).length, [books]);
    const inProgressBooks = useMemo(() => books.filter((book) => !isBookCompleted(book) && book.progress > 0).length, [books]);
    const totalHighlights = useMemo(() => annotations.filter((a) => a.type === "highlight").length, [annotations]);
    const totalNotes = useMemo(() => annotations.filter((a) => a.type === "note").length, [annotations]);
    const totalBookmarks = useMemo(() => annotations.filter((a) => a.type === "bookmark").length, [annotations]);

    const recentBooks = useMemo(() => {
        return [...books]
            .filter((b) => b.lastReadAt)
            .sort((a, b) => getDateTimestamp(b.lastReadAt) - getDateTimestamp(a.lastReadAt))
            .slice(0, 5);
    }, [books]);

    const favoriteBooks = useMemo(() => {
        return books.filter((b) => b.isFavorite).slice(0, 5);
    }, [books]);

    const handleBookClick = (bookId: string) => {
        setRoute("reader", bookId);
    };

    return (
        <div className="mx-auto w-full max-w-[var(--layout-content-max-width)] px-4 py-6 pb-0 sm:px-6 lg:px-8 lg:py-8 animate-fade-in overflow-x-hidden">
            
            <PageHeader
                title="Statistics"
                description="Track your reading progress and achievements"
            >
                <button
                    onClick={() => setShowShareModal(true)}
                    className="ui-btn flex items-center justify-center gap-2 text-xs font-semibold px-3.5 py-2 w-full sm:w-auto hover:bg-[color:var(--color-surface-muted)] active:scale-95 transition-colors"
                >
                    <Share2 className="w-3.5 h-3.5 text-[color:var(--color-text-secondary)]" />
                    <span>Share Stats</span>
                </button>
            </PageHeader>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 mb-8 sm:mb-10">
                <StatCard
                    icon={<BookOpen className="w-5 h-5" />}
                    label="Total Books"
                    value={totalBooks}
                    subtext={`${completedBooks} completed, ${inProgressBooks} in progress`}
                />
                <StatCard
                    icon={<Clock className="w-5 h-5" />}
                    label="Reading Time"
                    value={formatReadingTime(stats.totalReadingTime)}
                    subtext="Total hours spent reading"
                />
                <StatCard
                    icon={<Target className="w-5 h-5" />}
                    label="Today's Reading"
                    value={`${todayMinutes} / ${stats.dailyGoal} min`}
                    subtext={todayMinutes >= stats.dailyGoal ? "Daily goal achieved! 🎉" : `${Math.max(0, stats.dailyGoal - todayMinutes)} min remaining today`}
                />
                <StatCard
                    icon={<Flame className="w-5 h-5" />}
                    label="Streak"
                    value={`${stats.currentStreak} days`}
                    subtext={`Best: ${stats.longestStreak} days`}
                />
            </div>

            {(() => {
                const now = new Date();
                const weekAgo = new Date(now);
                weekAgo.setDate(weekAgo.getDate() - 7);
                const weekAgoStr = localDateKey(weekAgo);
                const thisWeek = (stats.dailyActivity || []).filter((d) => d.date >= weekAgoStr);
                const weekMinutes = thisWeek.reduce((s, d) => s + d.minutes, 0);
                const prevWeekEnd = new Date(weekAgo);
                prevWeekEnd.setDate(prevWeekEnd.getDate() - 1);
                const prevWeekStart = new Date(prevWeekEnd);
                prevWeekStart.setDate(prevWeekStart.getDate() - 6);
                const prevWeek = (stats.dailyActivity || []).filter((d) => d.date >= localDateKey(prevWeekStart) && d.date <= localDateKey(prevWeekEnd));
                const prevMinutes = prevWeek.reduce((s, d) => s + d.minutes, 0);
                const change = prevMinutes > 0 ? Math.round((weekMinutes - prevMinutes) / prevMinutes * 100) : 0;

                if (weekMinutes === 0 && prevMinutes === 0) return null;

                return (
                    <section className="mb-6 bg-[var(--color-surface)]">
                        <div className="px-5 py-4 flex items-center justify-between">
                            <div className="flex items-center gap-4">
                                <div>
                                    <div className="text-[10px] font-medium text-[color:var(--color-text-muted)] uppercase tracking-wider">This Week</div>
                                    <div className="text-2xl font-semibold text-[color:var(--color-text-primary)] mt-1">{formatReadingTime(weekMinutes)}</div>
                                </div>
                                {prevMinutes > 0 && (
                                    <div className={`text-xs font-medium ${change >= 0 ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`}>
                                        {change >= 0 ? '↑' : '↓'} {Math.abs(change)}%
                                    </div>
                                )}
                            </div>
                            <div className="text-xs text-[color:var(--color-text-secondary)] text-right leading-relaxed">
                                <div>{thisWeek.filter((d) => d.minutes > 0).length} days read</div>
                                {stats.booksCompleted > 0 && <div>{stats.booksCompleted} book{stats.booksCompleted !== 1 ? 's' : ''}</div>}
                            </div>
                        </div>
                    </section>
                );
            })()}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 sm:gap-8">
                
                <div className="lg:col-span-2 space-y-6 sm:space-y-8">
                    
                    <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-6">
                        <div className="flex items-center gap-3 mb-5 sm:mb-6">
                            <div className="p-2 bg-[var(--color-surface-muted)]">
                                <Target className="w-5 h-5 text-[color:var(--color-text-primary)]" />
                            </div>
                            <h2 className="font-semibold text-[color:var(--color-text-primary)]">Reading Goals</h2>
                        </div>
                        <div className="space-y-5 sm:space-y-6">
                            <div>
                                <ProgressBar
                                    label="Today's Reading Goal"
                                    current={todayMinutes}
                                    target={stats.dailyGoal}
                                    unit="min"
                                />
                                <div className="flex items-center justify-between text-xs text-[color:var(--color-text-muted)] mt-1.5">
                                    <span>
                                        {todayMinutes >= stats.dailyGoal
                                            ? "Daily goal completed! 🎉"
                                            : `${Math.max(0, stats.dailyGoal - todayMinutes)} min to reach daily goal`}
                                    </span>
                                    <span className="font-medium text-[color:var(--color-text-primary)]">
                                        {Math.round((todayMinutes / Math.max(1, stats.dailyGoal)) * 100)}%
                                    </span>
                                </div>
                            </div>

                            <div>
                                <ProgressBar
                                    label="Yearly Book Goal"
                                    current={booksReadThisYear}
                                    target={stats.yearlyBookGoal}
                                    unit="books"
                                />
                                <div className="flex items-center justify-between text-xs text-[color:var(--color-text-muted)] mt-1.5">
                                    <span>{completedBooks} total books finished</span>
                                    <span className="font-medium text-[color:var(--color-text-primary)]">
                                        {Math.round((booksReadThisYear / Math.max(1, stats.yearlyBookGoal)) * 100)}%
                                    </span>
                                </div>
                            </div>
                        </div>
                    </section>

                    <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-6">
                        <ActivityHeatmap dailyActivity={stats.dailyActivity} />
                    </section>

                    {recentBooks.length > 0 && (
                        <section>
                            <div className="flex items-center justify-between mb-4">
                                <h2 className="font-semibold text-[color:var(--color-text-primary)]">Recently Read</h2>
                                <button
                                    onClick={() => setRoute("library")}
                                    className="text-sm text-[color:var(--color-text-muted)] hover:text-[color:var(--color-accent)] transition-colors flex items-center gap-1"
                                >
                                    View All
                                    <ChevronRight className="w-4 h-4" />
                                </button>
                            </div>
                            <div className="space-y-3">
                                {recentBooks.map((book) => (
                                    <RecentBookCard
                                        key={book.id}
                                        book={book}
                                        onClick={() => handleBookClick(book.id)}
                                    />
                                ))}
                            </div>
                        </section>
                    )}
                </div>

                <div className="space-y-6 sm:space-y-8">
                    
                    <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-6">
                        <div className="flex items-center gap-3 mb-5 sm:mb-6">
                            <div className="p-2 bg-[var(--color-surface-muted)]">
                                <Highlighter className="w-5 h-5 text-[color:var(--color-text-primary)]" />
                            </div>
                            <h2 className="font-semibold text-[color:var(--color-text-primary)]">Annotations</h2>
                        </div>
                        <div className="space-y-3">
                            {[
                                { icon: <Highlighter className="w-4 h-4 text-[color:var(--color-text-muted)]" />, label: "Highlights", count: totalHighlights },
                                { icon: <BookOpen className="w-4 h-4 text-[color:var(--color-text-muted)]" />, label: "Notes", count: totalNotes },
                                { icon: <Bookmark className="w-4 h-4 text-[color:var(--color-text-muted)]" />, label: "Bookmarks", count: totalBookmarks },
                            ].map(({ icon, label, count }) => (
                                <div key={label} className="flex items-center justify-between p-3 bg-[var(--color-surface-muted)]">
                                    <div className="flex items-center gap-2 min-w-0">
                                        {icon}
                                        <span className="text-sm text-[color:var(--color-text-primary)] truncate">{label}</span>
                                    </div>
                                    <span className="font-medium text-[color:var(--color-text-primary)] shrink-0 ml-2">{count}</span>
                                </div>
                            ))}
                        </div>
                    </section>

                    {favoriteBooks.length > 0 && (
                        <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-6">
                            <div className="flex items-center gap-3 mb-5 sm:mb-6">
                                <div className="p-2 bg-[var(--color-surface-muted)]">
                                    <Star className="w-5 h-5 text-[color:var(--color-text-primary)]" />
                                </div>
                                <h2 className="font-semibold text-[color:var(--color-text-primary)]">Favorites</h2>
                            </div>
                            <div className="space-y-3">
                                {favoriteBooks.map((book) => (
                                    <button
                                        key={book.id}
                                        onClick={() => handleBookClick(book.id)}
                                        className="flex items-center gap-3 w-full text-left group min-w-0"
                                    >
                                        <div className="w-10 h-14 shrink-0 overflow-hidden shadow-sm">
                                            <TheoremBookCover
                                                title={book.title}
                                                author={book.author}
                                                coverUrl={book.coverPath}
                                            />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <h4 className="text-sm font-medium text-[color:var(--color-text-primary)] truncate group-hover:text-[color:var(--color-accent)] transition-colors">
                                                {book.title}
                                            </h4>
                                            <p className="text-xs text-[color:var(--color-text-secondary)] truncate">
                                                {normalizeAuthor(book.author) || "Unknown Author"}
                                            </p>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </section>
                    )}

                    {annotations.filter(a => a.type !== "bookmark").length > 0 && (
                        <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-6">
                            <div className="flex items-center gap-3 mb-4 sm:mb-5">
                                <div className="p-2 bg-[var(--color-surface-muted)]">
                                    <Highlighter className="w-5 h-5 text-[color:var(--color-text-primary)]" />
                                </div>
                                <h2 className="font-semibold text-[color:var(--color-text-primary)]">Highlights</h2>
                            </div>
                            <div className="space-y-2">
                                {(["yellow", "green", "blue", "red", "orange", "purple"] as const).map((color) => {
                                    const count = annotations.filter((a) => a.type !== "bookmark" && a.color === color).length;
                                    if (count === 0) return null;
                                    const label = color === "yellow" ? "Important" : color === "green" ? "Key Idea" : color === "blue" ? "Interesting" : color === "red" ? "Critical" : color === "orange" ? "Action" : "Beautiful";
                                    return (
                                        <div key={color} className="flex items-center gap-2">
                                            <span className="w-3 h-3 border border-[var(--color-border-subtle)]" style={{ backgroundColor: HIGHLIGHT_SOLID_COLORS[color] }} />
                                            <span className="flex-1 text-sm text-[color:var(--color-text-primary)]">{label}</span>
                                            <span className="text-sm font-medium text-[color:var(--color-text-secondary)]">{count}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        </section>
                    )}

                    <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-6">
                        <div className="flex items-center gap-3 mb-5 sm:mb-6">
                            <div className="p-2 bg-[var(--color-surface-muted)]">
                                <Trophy className="w-5 h-5 text-[color:var(--color-text-primary)]" />
                            </div>
                            <h2 className="font-semibold text-[color:var(--color-text-primary)]">Achievements</h2>
                        </div>
                        <div className="space-y-3">
                            {completedBooks >= 1 && (
                                <div className="flex items-center gap-3 p-3 bg-[var(--color-accent-light)]">
                                    <div className="w-8 h-8 bg-[var(--color-accent)] flex items-center justify-center shrink-0">
                                        <BookOpen className="w-4 h-4 text-[color:var(--color-text-inverse)]" />
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium text-[color:var(--color-text-primary)]">First Book</p>
                                        <p className="text-xs text-[color:var(--color-text-muted)]">Completed your first book</p>
                                    </div>
                                </div>
                            )}
                            {completedBooks >= 5 && (
                                <div className="flex items-center gap-3 p-3 bg-[var(--color-accent-light)]">
                                    <div className="w-8 h-8 bg-[var(--color-accent)] flex items-center justify-center shrink-0">
                                        <TrendingUp className="w-4 h-4 text-[color:var(--color-text-inverse)]" />
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium text-[color:var(--color-text-primary)]">Bookworm</p>
                                        <p className="text-xs text-[color:var(--color-text-muted)]">Completed 5 books</p>
                                    </div>
                                </div>
                            )}
                            {stats.currentStreak >= 7 && (
                                <div className="flex items-center gap-3 p-3 bg-[var(--color-accent-light)]">
                                    <div className="w-8 h-8 bg-[var(--color-accent)] flex items-center justify-center shrink-0">
                                        <Flame className="w-4 h-4 text-[color:var(--color-text-inverse)]" />
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium text-[color:var(--color-text-primary)]">On Fire</p>
                                        <p className="text-xs text-[color:var(--color-text-muted)]">7 day reading streak</p>
                                    </div>
                                </div>
                            )}
                            {totalHighlights >= 10 && (
                                <div className="flex items-center gap-3 p-3 bg-[var(--color-accent-light)]">
                                    <div className="w-8 h-8 bg-[var(--color-accent)] flex items-center justify-center shrink-0">
                                        <Highlighter className="w-4 h-4 text-[color:var(--color-text-inverse)]" />
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium text-[color:var(--color-text-primary)]">Highlighter</p>
                                        <p className="text-xs text-[color:var(--color-text-muted)]">Created 10 highlights</p>
                                    </div>
                                </div>
                            )}
                            {completedBooks < 1 && totalHighlights < 10 && stats.currentStreak < 7 && (
                                <p className="text-sm text-[color:var(--color-text-muted)] text-center py-4">
                                    Keep reading to unlock achievements!
                                </p>
                            )}
                        </div>
                    </section>
                </div>
            </div>
            {showShareModal && (
                <ShareCardModal
                    kind="stats"
                    statsData={shareStatsData}
                    onClose={() => setShowShareModal(false)}
                />
            )}
        </div>
    );
}