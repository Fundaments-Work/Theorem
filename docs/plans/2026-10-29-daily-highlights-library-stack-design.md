# Design: Upgrading Daily Highlights to Interactive Card Stack in Library

**Date:** 2026-10-29  
**Status:** Approved  
**Author:** Pair programming with Antigravity  

## Context & Objectives

Currently, Theorem has two disconnected mechanisms for highlight reflection:
1. A static single-quote banner (`DailyHighlightBanner`) in the Library showing 1 random highlight.
2. A full-page Daily Review takeover modal/view inside the Workbench.

Users spend most of their time on the **Library** screen rather than digging into the Workbench. Having a full-page takeover in the Workbench interrupts workspace tasks (browsing highlights, notes, words, bookmarks), while the Library only offered a static 1-line quote banner.

This design upgrades the Library's Daily Highlight feature into an interactive **Daily Highlights Card Stack** directly embedded at the top of the Library feed, while refocusing the Workbench purely as a reference workspace.

---

## Architecture & Components

### 1. `LibraryDailyReviewDeck` (`src/features/library/components/LibraryDailyReviewDeck.tsx`)
- Replaces `DailyHighlightBanner` in `src/features/library/Library.tsx`.
- Embeds the existing `ReviewCardStack` component within a centered, responsive container (`max-w-[38rem] sm:max-w-[42rem] mx-auto mb-6`).
- Loads today's curated highlights via `selectDailyReviewCards(annotations, books)`.
- Renders a clean deck header:
  - Title: "Daily Reflection"
  - Deck counter & source info
  - Dismiss button (`✕`) to snooze the deck for the current session (`sessionStorage.setItem("theorem-dismiss-daily-deck", localDateKey())`).
- Guard conditions (deck only appears when all match):
  1. `settings.showDailyHighlight` is `true`.
  2. `!dailyReviewStatus.completed` (not already reviewed today).
  3. `!isDismissed` (not snoozed for the session).
  4. `dailyCards.length > 0`.
  5. Library is in normal browsing mode (`!selectedShelf && !showFavoritesOnly && !isSelecting`).

### 2. Completion & Collapse
- When the user finishes the last card in the deck:
  - `markDailyReviewCompleted()` records today's date in local storage (`theorem:daily-review:v1`).
  - The deck smoothly animates out and collapses completely, leaving the library book grid clear and uninterrupted.

### 3. Workbench Refocus
- Remove the Daily Review takeover state (`isDailyReviewActive`, `showDailyReview`, `handleDismissDailyReview`) from `src/features/library/Annotations.tsx`.
- Remove the `Daily Review (N)` badge and links from `Annotations.tsx` and `Bookmarks.tsx`.
- Workbench remains 100% dedicated to browsing and organizing Highlights, Notes, Vocabulary, and Bookmarks.
- The on-demand Card View toggle (`viewMode === "cards"` vs `"list"`) remains available in Workbench for browsing all highlights as decks whenever requested.

### 4. Settings
- In `src/features/settings/Settings.tsx`:
  - Label: "Daily Highlights"
  - Description: "Review a curated deck of daily highlights at the top of your library"
  - Controls `settings.showDailyHighlight`.

---

## Testing & Verification
1. **Unit & Component Tests**:
   - Verify `LibraryDailyReviewDeck` renders cards when `showDailyHighlight` is enabled and review is uncompleted.
   - Verify `LibraryDailyReviewDeck` hides when dismissed or marked completed.
   - Verify Workbench renders without Daily Review takeover.
   - Update `tests/workbench-daily-review.test.tsx` to reflect the Library placement and Workbench card view mode.
2. **Quality Gates**:
   - `pnpm typecheck`
   - `pnpm test`
   - `pnpm build` (ensuring startup bundle < 700 kB)
