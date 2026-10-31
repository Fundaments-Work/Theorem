# Reading rhythm, onboarding, and navigation

Date: 2026-10-31
Status: Implemented on `feat/reading-rhythm`; human usability study remains pending

## Outcome

Help readers return to a book consistently through an obvious resume action, a flexible weekly goal, and quiet recognition of progress. Improve onboarding and navigation together so that motivation never compensates for difficulty using the app.

Consistency supports finishing books; it does not establish comprehension or retention. Keep daily highlight review available without claiming that completing a deck proves learning.

## Decisions and scope

Agreed direction:

- Reading consistency is the primary outcome.
- Explore XP and levels as secondary recognition of reading habits.
- Improve first-run setup, navigation labels, icon clarity, and placement.
- Retain visible labels on mobile primary navigation.
- Preserve Theorem's design system, five primary destinations, and matching desktop/mobile order.

Proposals to validate before implementation:

- A weekly target of four reading days, adjustable from one to seven.
- Five recorded reading minutes qualify a day; minutes can accumulate across sessions and books.
- Quiet numbered levels rather than named ranks.
- Keep the current tab order initially; test terminology before moving destinations.

Exclude from the first release: leaderboards, currencies, paid streak protection, feature unlocks, competitive quests, and rewards for importing books, turning pages, or creating highlights. Reading and accessibility features remain available at every level.

## Current implementation

- `src/shell/layout/nav-items.ts` already defines the shared order: Library, Shelves, Discover, Feeds, Workbench. It also drives numbered navigation shortcuts. Workbench owns annotations, vocabulary, and bookmarks.
- `BottomNav.tsx` already renders labels; `Sidebar.tsx` uses an icon rail with accessible names and tooltips. Statistics and Settings are secondary utilities.
- `src/features/onboarding/OnboardingFlow.tsx` presents a five-screen feature tour. Completion is represented by a persisted setting and a local-storage marker; see [onboarding](../onboarding.md).
- Existing statistics include daily and yearly goals, streaks, achievements, and a heatmap. The settings store currently uses persistence version 13. Inspect the current version again when implementing; see [statistics](../statistics.md).
- `useReadingTime.ts` tracks visible reader time and flushes it to statistics and native reading-session storage. Visibility is a proxy for reading, not proof of attention.
- SQLite already has a `reading_sessions` table. Its recording operation adds minutes on conflict; retrying the same payload is therefore not inherently idempotent. Do not use it unmodified as an XP award ledger.
- In-memory daily activity is bounded. Lifetime XP must not be derived solely from the retained heatmap.
- Library already contains a daily review deck. A new motivation panel must not push the resume action below it.

## Proposed experience

### Library hierarchy

1. Existing page title, search, import, and collection controls.
2. Continue reading: current book, progress, and one action to resume. Preserve existing navigation-to-position behavior.
3. Compact weekly summary: “3 of 4 reading days this week.” Open Statistics for details.
4. Existing library content and optional daily review, with review visually subordinate to resuming reading.

Prototype placement with real cover sizes and small phone screens before choosing the final arrangement. Prefer integrating with existing resume UI over introducing another competing card. Empty libraries lead with Add a book, plus Discover as an alternative. Missing or unavailable files offer recovery rather than an action that silently fails.

Show XP and level inside Statistics and, optionally, a compact Library detail. Do not add another primary tab. Respect an appearance preference that hides motivational UI while leaving normal reading statistics intact. Clearly distinguish hiding UI from stopping reading-history collection.

### Weekly rhythm

- Default proposal: four days per week; allow one through seven, Skip, and disabling the goal.
- Use Monday–Sunday calendar weeks and display the date range. All dates follow existing local-day conventions; define time-zone behavior in the data contract below.
- Count a day after five recorded minutes; a one-minute session remains recorded but does not qualify yet.
- Preserve daily-minute goals and strict daily streaks as separate optional measures. A weekly goal must not silently redefine existing streaks.
- Apply goal edits from the next week after initial setup, with the effective date shown. This avoids retroactively changing a completed week's result or awarding multiple bonuses.
- Missing a week never removes earned XP or completed milestones. Returning copy is welcoming and factual.
- Keep reminders optional. Request notification permission only after the person enables reminders. Avoid duplicate daily and weekly reminder streams.

### XP and levels: initial tuning proposal

| Event | Proposed award | Limit |
| --- | --- | --- |
| First qualifying reading day | 10 XP | Once per local calendar day across devices |
| Weekly target reached | 20 XP | Once per calendar week |
| Next level | Each 100 lifetime XP | Start at level 1; level = 1 + floor(XP / 100) |

Examples: three qualifying days earn 30 XP. A fourth day meeting a four-day goal earns 10 daily XP plus 20 weekly XP, for 60 total that week. Additional reading days still earn their daily award; additional minutes do not.

These numbers are a testable starting point, not a claim about motivation. No XP for merely opening the app, no negative XP, and no reward for review-card swipes. Keep achievements separate from the XP calculation in the first release.

Render progress inline after recording. Queue any milestone message for the next safe transition out of reading; never interrupt a page turn, selection, narration, or an open modal. Honor reduced motion and prevent repeat announcements after restart or sync.

### Onboarding

Replace the feature tour with a short, resumable setup:

1. **Welcome:** brief local-first explanation and Start reading / Skip setup.
2. **Choose a rhythm:** reading days per week, with a recommended default, Skip, and a brief explanation of qualifying days. Existing daily-minute preferences remain independent.
3. **Bring a book:** use the existing import flow, or open Discover. Successful import offers Open book immediately; discovery and import must not depend on completing a blocking onboarding overlay.

Persist completed setup choices independently so interruption never discards them. Mark initial onboarding complete before handing off to the normal import or Discover flow. Do not force existing users through setup again; offer a dismissible Library invitation to set a weekly rhythm.

Introduce highlighting, review, and sync contextually after the reader reaches the relevant feature. Keep contextual hints dismissible, keyboard accessible, and bounded to avoid repeated prompts. Do not request notifications, folders, or sync permissions merely to finish onboarding.

### Navigation and familiar behavior

| Destination | Initial treatment |
| --- | --- |
| Library | Keep first; owned books and resume reading |
| Shelves | Keep second initially; test distinction from Library |
| Discover | Keep third; books and catalogs to explore |
| Feeds | Keep fourth; subscribed articles |
| Workbench | Keep fifth initially; test “Workbench” against “Notes” and “Notebook” with highlights, notes, vocabulary, and bookmarks tasks |

Use the existing Lucide icons as the baseline. Test whether Library and Shelves are distinguishable and whether NotebookPen communicates saved reading material. Do not assume replacing every icon improves comprehension.

Keep mobile labels, accessible names, `aria-current`, visible focus, and at least 44×44 CSS-pixel touch targets. Mark decorative icons appropriately. Keep the fixed 48px desktop rail and its tooltips. Support large text, narrow screens, safe areas, light/dark themes, and reduced motion.

Review Android Back, Escape, modal dismissal, swipe-action undo, returning from a note to its source, and tab scroll/filter restoration. Preserve the shared destination configuration and synchronize any approved rename across titlebars, headers, shortcuts, translations, help, and empty states. Route IDs need not change when display labels change.

## Data and architecture

Implement computation and durable storage in Rust, with React handling presentation and interaction. First inspect the existing native session writer, schema migrations, restore, sync merge, and CLI paths; reuse appropriate native code rather than introduce a second source of reading truth.

Proposed flow:

`reader timing → durable idempotent session flush → native daily aggregation → award transaction → compact progress response → UI`

Before implementing XP, write a precise data contract covering:

- Stable session IDs and monotonic cumulative duration or uniquely identified deltas. Retries, overlapping timers, restart, and duplicate events must not add reading twice. Use integer time units internally and convert existing fractional-minute inputs explicitly.
- Session boundaries split at local midnight. Assign each contribution its day at recording time; do not reassign historical days after travel. Time-zone changes and clock rollback must not create another award for an already awarded date.
- Versioned weekly-goal history and deterministic conflict resolution when two offline devices edit the same upcoming goal. Snapshot the effective target for each week.
- A versioned award ledger with deterministic identities such as `reading-day:<date>` and `reading-week:<week-start>`. A unique constraint and transaction make repeated award calculation harmless. Sync merges award sets, never sums peer XP totals.
- Stable source-session identities across sync. Two devices contributing different sessions on the same day combine their durations; duplicate sessions do not. Decide and document how simultaneous reading intervals are treated before implementation.
- Local reading that qualifies before it syncs may award immediately. Later sync can add missing awards but cannot revoke earned ones. Deleting a book does not remove awards or resurrect the book through award references.
- Explicit reward-rule versioning. Future tuning must not silently recalculate and lower past XP.
- A compact native progress response, typed `AppError`, `with_connection()`, appropriate `Box<str>`/`Box<[T]>` DTO fields, and individual Zustand selectors.
- A lightweight browser persistence adapter with the same contract for supported web use. No bulk JavaScript history aggregation; agree a shared native/WASM strategy if historical aggregation is required there.

Do not announce lifetime XP until persistence, sync, backup, and restore preserve it. Define metadata-only award sync so older peers can continue reading and syncing their existing data. Follow [sync rules](../sync.md): protocol/version migration, old-form reads and writes where required, and real-node mixed-version scenarios. An older peer must not erase new goal or award fields through a settings replacement.

Migration proposal: retain all existing statistics and preferences, start XP from the feature's activation date, and explain that earlier reading remains in Statistics. Do not fabricate lifetime awards from a truncated activity window. Backups must include the ledger; restoring or importing twice must not duplicate awards. An older backup cannot replace a newer award set during merge; document deliberate full-restore semantics separately.

## Delivery sequence

### 1. Baseline and interaction design

- Capture current Library, onboarding, navigation, and Statistics at phone and desktop sizes using non-sensitive fixtures.
- Prototype the Library hierarchy, weekly summary, setup flow, and label candidates.
- Run a formative test with five readers unfamiliar with Theorem: resume a book, import one, find a highlight, find vocabulary, organize a shelf, and change a goal.
- Record task completion, wrong destinations, assistance, and label interpretation. Treat this as qualitative evidence, not population-level proof. Revise ambiguous navigation before freezing labels; keep the existing order unless testing supports a change.
- Deliverable: validated screen flow, copy, navigation mapping, XP rules, and data contract. Resolve the proposals above before implementation.

### 2. Navigation clarity and resume flow

- Make narrowly scoped label/icon changes supported by the prototype test.
- Improve resume placement and empty/unavailable-file states.
- Keep mechanical refactors separate from behavior changes.
- Acceptance: all five destinations work on mobile and desktop, nested Workbench routes keep the correct item active, shortcuts match, and resuming returns to the saved position.

### 3. Reading records and weekly goals

- Add failing regression tests for recording edge cases before altering the timing pipeline.
- Implement idempotent native recording, day boundaries, weekly-goal persistence and aggregation, migration, backup, and sync compatibility.
- Add the compact Library summary and Statistics details without XP yet.
- Acceptance: multiple sessions and devices produce one correct daily total; crossing midnight credits both days; target changes obey their effective week; existing daily goals still behave as before.

### 4. Action-oriented onboarding

- Replace the tour with the setup flow, reusing existing import and Discover routes.
- Add optional adoption for existing users and contextual feature guidance.
- Acceptance: skip, Back, restart, canceled imports, permission denial, failed import, and empty Discover all leave the app usable. Successful import can lead straight into reading.

### 5. XP and levels

- Implement the transactional award ledger, deterministic sync merge, backup/restore coverage, and progress UI.
- Add level details to Statistics, the hide preference, and deferred milestone feedback.
- Acceptance: threshold crossing gives exactly one award; repeated flush, restart, restore, and sync give none extra; historical XP never drops because a week was missed or a book was deleted.

### 6. Validate and tune

- Repeat the task study with the revised flows and observe readers using weekly goals over several weeks.
- With consent, compare each reader's qualifying reading days and self-reported usefulness against their own baseline. Use local summaries or volunteered exports; do not introduce telemetry by default.
- Track first-book-to-first-read completion and resume task success as supporting outcomes. Do not optimize app opens or XP accumulation as the primary result.
- Tune copy and XP pacing from feedback. Keep reward-rule changes versioned. Treat cohort differences and novelty effects as limits on conclusions.

## Verification and documentation

Tests must assert behavior, not component source text:

- Rust: zero/negative/nonfinite duration rejection, threshold boundaries, fractional accumulation, retries, concurrent updates, crashes between recording and awarding, midnight/week/year boundaries, DST, travel, clock rollback, goal conflicts, integer limits, migration, deleted books, and backup/restore.
- Sync scenarios: three devices, one offline, both exchange orders, duplicate/overlapping sessions, repeated merge, partial week on different devices, mixed protocol versions, and settings updates from old peers. Prove convergence and no duplicate awards or resurrected records.
- Vitest/jsdom: accessible navigation names, active destinations, goal UI, onboarding resume/skip/import handoff, hidden motivation UI, and deferred/deduplicated milestone feedback.
- Real app e2e: fresh install → setup → import → read → exit/relaunch → resume; existing-user adoption; Android Back and safe areas; permission denial; progress across a simulated date boundary; keyboard, large text, and reduced motion.
- For timing bugs, report repeated failing runs before the fix and passing runs after it. Use controllable clocks and conditions, never longer sleeps to conceal races.

Before each implementation commit run the ordered quality gates in [AGENTS.md](../../AGENTS.md), including the full Rust and frontend suites and build. Build `dist/` first in a fresh checkout when all-feature Clippy needs it. Run Android target checks for relevant native changes and integer-size/offset assumptions. Run `pnpm foliate:check` only if the reader runtime is touched; avoid touching it for this feature.

Update `docs/statistics.md`, `docs/onboarding.md`, `docs/user/statistics.md`, `docs/user/getting-started.md`, `docs/modules.md`, `docs/sync.md`, and the unreleased changelog alongside actual behavior changes. Update AGENTS.md only if rules, commands, or module layout change. Do not describe planned functionality as shipped.

No implementation date, release version, commit, deployment, or merge is authorized by this plan alone. Implementation can proceed when the proposed experience and data contract have been reviewed.

## Design references

- [Jakob's Law, Nielsen Norman Group](https://www.nngroup.com/videos/jakobs-law-internet-ux/): familiar interaction conventions inform the usability review; this does not require copying another product's appearance.
- [Duolingo's streak experiment](https://blog.duolingo.com/improving-the-streak/): daily goals and streak participation can behave differently. This is evidence from language learning, not proof that the same mechanics improve reading.

## Implementation decisions

The first implementation retains tab order and names pending reader testing. It
uses the existing recent-book cache for Resume and removes the duplicate review
deck above the Library header. The feature guide stays available on demand.
Setup explicitly opens Library before adding a book, keeping platform file-pickers
in their established flow and outside the blocking overlay.

The versioned counter and award maps share one settings snapshot rather than
introducing a second SQLite ledger table. This reuses atomic KV-row replacement,
existing browser IndexedDB persistence, and native backup/restore. Unique map
identities implement replay-safe awards; the native chunk command separately
uses a primary-key constraint. Computation is shared Rust, called through a native command on Tauri, compiled
to lazy WASM in the browser, and used natively for doc-copy merging. Device-local
pending counters survive reader exit while native IPC is in flight. The hide preference
applies to Library, with explicit progress still available in Statistics.

No human usability study or multi-week habit study has been performed. Automated
checks do not establish whether the chosen XP pacing improves reading habits.

## Verification

The ordered pre-commit gates in AGENTS.md passed, including Rust formatting,
all-feature Clippy, the complete workspace tests, frozen dependency installation,
frontend typecheck/design rules/tests, and the production build. The complete
Linux WebKitGTK E2E suite passed against a fixed copy of the e2e-feature binary.
Both aarch64 and armv7 Android Clippy checks passed with the installed NDK.

The visible-reading timing regressions failed in 5/5 runs with the original hook
and passed in 10/10 runs with the corrected hook. Real-app validation also caught
and fixed missing Resume history on a short open, invisible selection controls,
and the missing populated-library folder-import entry point. Workbench E2E
checks retain highlight, book, author, and Notes-filtering coverage against the
current section labels.

Android device interaction and the proposed human/multi-week usability studies
have not been performed. Automated checks do not establish motivational efficacy.
