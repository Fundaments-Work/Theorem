# Statistics

## What's Tracked

Reading statistics are stored in `settingsStore.stats` (persisted alongside settings):

| Stat | How It's Calculated |
|------|---------------------|
| Total reading time | Sum of per-session reading durations |
| Books completed | `progress >= 0.99`, or `completedAt` set, or manual read state |
| Current streak | Consecutive days with reading time > 0 |
| Longest streak | Max consecutive days ever recorded |
| Daily goal progress | Today's reading minutes vs `dailyGoal` |
| Yearly book goal | Books completed this year vs `yearlyBookGoal` |
| Daily activity | Per-day reading minutes for heatmap |

## How Reading Time Is Tracked

The reader tracks active reading time (not wall-clock time). The timer runs while the document is visible; it pauses when:
- The document becomes hidden (backgrounded)
- The OS pauses the app (Tauri `tauri://on-pause`)

It resumes on `visibilitychange` / `tauri://on-resume`.

Time is reported as `readingTime: number` (minutes) on the `Book` object and aggregated into `stats.totalReadingTime`.

## Daily Activity Heatmap

The `dailyActivity` array stores per-day reading minutes. Each entry is `{ date: string, minutes: number, booksRead: string[] }`. The Statistics page renders this as a GitHub-style heatmap grid covering the last 12 weeks (84 days).

For performance, `dailyActivity` is pruned to the most recent 84 entries in memory.

## Goals

Two goals are user-configurable in Settings:
- **Daily minutes**: Target minutes per day (default: 30)
- **Yearly books**: Target books per year (default: 24)

Progress bars show completion percentage for both.

## Sharing Stats

The `ShareCardModal` generates a shareable image of the user's reading stats using `html-to-image` (dynamically imported). The image can be:
- Downloaded as PNG via `downloadImage` (desktop Downloads / Android MediaStore) or browser download (web)
- Shared via Web Share API (mobile browsers)

The share card renders `ShareCard` inline in the modal's React tree and captures the node with `html-to-image`'s `toBlob`.
