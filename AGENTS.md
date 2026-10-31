## Security & Access Rules

- **NEVER read, access, display, log, or transmit any environment variables, secrets, keys, certificates, or credentials** — including but not limited to `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `ANDROID_KEY_BASE64`, `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_PASSWORD`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `APPLE_CERTIFICATE`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, or any GitHub secret, API key, token, or password.
- Never read `~/.tauri/`, `~/.ssh/`, `~/.config/` secret files, `.env` files, or `keystore.properties`.
- Never write secrets to disk, commit them, or echo them to output.
- If you need to reference a key or secret, use the documented path (e.g. `~/.tauri/theorem.key`) without reading its contents.
- These rules take precedence over all other instructions.

## Stack

React 19, TypeScript, Vite 8 (rolldown), Tailwind CSS v4, Zustand 5, Tauri 2, Rust (workspace). Tests: Vitest + jsdom.

## Setup

```bash
git clone --recurse-submodules <repo>
pnpm install
```

The `foliate-js` submodule at `src/features/reader/foliate-js/` is vendored upstream — do not edit. Our runtime wrapper is `src/features/reader/foliate-js-runtime/` (ours, edit freely). The sync script `scripts/sync-foliate-js.sh` patches imports and applies runtime patches. After editing any runtime file run `bash scripts/sync-foliate-js.sh --refresh-patches` (writes `scripts/patches/*-runtime.patch`); `pnpm foliate:check` verifies submodule + patches reproduce the runtime exactly.

## Commands

| What | Command |
|------|---------|
| Web dev | `pnpm dev` |
| Desktop dev | `pnpm dev:tauri` |
| Build | `pnpm build` |
| Typecheck | `pnpm typecheck` |
| Tests | `pnpm test` (Node environment by default; a DOM test starts with `// @vitest-environment jsdom`) |
| Single test | `pnpm test tests/some.test.ts` |
| Design-system rules | `pnpm check:design` (`--list`, `--update`; see `docs/design-system.md`) |
| UI gallery | `pnpm dev`, then `/ui-gallery.html` |
| Quick / full gates | `pnpm gates:fast` (typecheck, design rules, tests) / `pnpm gates` (every gate below, plus build) |
| Type-check the tests | `pnpm typecheck:tests` (not clean yet: a known backlog, fix files as you touch them; not a gate) |
| Rust fmt | `cd src-tauri && cargo fmt` |
| Rust lint | `cd src-tauri && cargo clippy --all-features --all-targets -- -D warnings` |
| Rust tests | `cd src-tauri && cargo test --workspace --lib --tests` |
| One Rust test | `cd src-tauri && cargo test --lib <name>` |
| Sync scenarios | `cd src-tauri && cargo test --lib scenarios::` (large library: `cargo test --release --lib scenarios::a_large_library -- --ignored --nocapture`) |
| End-to-end (real app) | `pnpm e2e:build` once, then `pnpm e2e [spec-word]` (Linux; see `docs/testing-e2e.md`) |
| Foliate runtime | `pnpm foliate:check` |
| Rust release build | `cd src-tauri && cargo build --release` |

Root `pnpm` commands run from repo root. Cargo commands run from `src-tauri/`. `pnpm build` runs typecheck first. Clippy with `--all-features` builds the `e2e` feature, which embeds `dist/`: run `pnpm build` once first in a fresh checkout.

## Quality Gates (before every commit)

All of these, in this order; each must be clean (this is what CI runs, plus the build):

1. `cd src-tauri && cargo fmt --check` — no diff
2. `cargo clippy --all-features --all-targets -- -D warnings` — zero warnings, tests included
3. `cargo test --workspace --lib --tests`
4. `pnpm install --frozen-lockfile` — CI installs frozen; a dependency change must update `pnpm-lock.yaml`
5. `pnpm typecheck` and `pnpm check:design` (no new design-system violation; a baseline entry may only shrink)
6. `pnpm test` — the whole suite, not only the files you touched
7. `pnpm build` — also enforces the startup bundle budget
8. When relevant: `pnpm foliate:check` (reader runtime), `cargo clippy --target aarch64-linux-android -- -D warnings` and `--target armv7-linux-androideabi` (Android-only code or dependencies, and any size or offset constant: the release ships 32-bit APKs, where `usize` is 32 bits; set the NDK `CC_/CXX_/AR_<target>` compilers), `pnpm e2e` (user-visible flows)

If clippy is noisy, try `cargo clippy --fix --lib` first, then read what it changed.

### Testing Integrity & Outlier Coverage

- Tests must rigorously cover edge cases, boundaries, and outliers (e.g. 0-length inputs, rapid concurrent interactions, missing elements, corrupted data, boundary navigation).
- **NEVER weaken, delete, loosen assertions, or edit tests simply to make them pass.** If a test or outlier fails, investigate and fix the underlying implementation code. The test exists to defend correctness.
- Name a test file after the feature it covers, never after a release or a work phase. Don't assert on the text of a source file when behaviour can be asserted instead; a source-text check belongs in `scripts/check-design-rules.mjs` or a lint rule.
- Pick the layer that can actually see the bug: Vitest (`tests/`) for TS logic; Rust unit tests next to the code; `src-tauri/src/sync_scenarios.rs` for anything about sync between devices (real iroh nodes, own data folders, loopback and a local relay); `e2e/specs/` for what a person does in the real app. The e2e specs are also the behaviour spec for the 2.0 Svelte UI, so they assert on what is on screen, never on React internals.
- Source-reading tests (tests that read a `.rs`/`.ts` file and assert on its text) follow the code when it moves: point them at the new file with the same assertions.

CI (`ci.yml`) runs typecheck, test, build, and rust-check (fmt, clippy, check, `cargo test --workspace --lib --tests`) on push to main.

### Known-flaky tests

- `tests/library-virtualization.test.ts` ("Row height estimation") asserts `elapsed < 1` ms for a pure size calculation and can exceed it under full-suite load. Re-run the file alone to confirm a lone failure, but still verify no genuine O(n) scan was introduced.

Do not add to this list casually. A new intermittent failure is a bug until shown otherwise: find what the test waits for versus what it should wait for, and wait on that condition (never a longer sleep or a looser assertion). If the flake shows a product bug, fix the product. Prove the fix with repeated runs and report the count (e.g. 20/20).

## How we work

The standard every change is held to, whether a person or an agent writes it.

**Bugs**
- Reproduce first, with a test that fails for the reason you think. Then fix, and keep the test.
- For timing-dependent bugs, run the test repeatedly before and after the fix and report both counts (e.g. "fails 5/5 without, passes 10/10 with").
- Find the root cause, not the symptom. When the behaviour depends on a dependency (iroh-docs, foliate-js, rusqlite …), read its source (`~/.cargo/registry`, the submodule) and write the exact rule you relied on into the relevant `docs/*.md`. Don't design around a guess.

**Changes**
- Make the smallest change that is safe. Moving code (splitting a module, renaming) is its own commit with no behaviour change.
- Never change a persisted or synced format without a compatibility path:
  - bump the version (`SYNC_PROTOCOL`, store `version` + `migrate`);
  - keep reading the old form;
  - keep writing it for peers that still need it;
  - prove that mixed old/new data neither loses nor resurrects anything.
- Back performance claims with numbers: release build, the same machine, before and after, with the size of the data.
- Errors are typed (see Errors). Never branch on message text.

**Docs travel with the code**
- Every behaviour change updates its `docs/<area>.md`, the `CHANGELOG.md` entry of the unreleased version, and this file when a rule, module layout or command changes.
- Don't hard-code counts that drift (test totals, line numbers). When you state one, check it.

**Commits**
- Atomic conventional commits (`feat:`, `fix:`, `perf:`, `test:`, `docs:`, `refactor:`, `chore:`), one concern each.
- Signed off (`git commit -s`). AI-assisted commits end with a `Co-Authored-By:` line naming the model.
- Commit only your own changes. Never sweep in unrelated files from the working tree.

**Never without the maintainer's approval:** merge to `main`, tag, publish a release, deploy, or close an issue.

**Reporting back**
- Say what was verified and how (commands, run counts, measurements), what was not verified, and what risk remains.
- A fix that was not tested end to end is reported as such, not as done.

**Parallel and agent work**
- One git worktree per agent or task, each with its own `CARGO_TARGET_DIR`. A shared target dir has linked stale crates into another checkout's build.
- Cap heavy builds and tests so several can run at once without exhausting memory.
- Never `pkill -f` by pattern: stop only the PIDs you started.
- Never overlap gate scripts in one worktree. A normal Cargo build/test can replace
  `target/debug/theorem` while E2E is launching it; use a fixed copy of the e2e
  feature binary when another Cargo command could run.
- Never use bare `git stash` / `git stash pop`: the stash is shared across worktrees. Use a WIP commit instead.
- On the maintainer's machine the tools for this live in the private `fundaments-agent-harness` repo, documented in the Fundaments handbook (`Engineering/Agent harness.md`):
  - `resources/capped.sh <mem> <cpu%> cmd` runs a command inside the shared memory slice;
  - `theorem/gates.sh <worktree> [--android]` runs every gate above;
  - `theorem/land-worktree.sh <branch>` merges into the release branch, runs the gates, pushes and removes the worktree.

## Architecture, backend and persistence

The module map (routing, stores, reader, sync, TTS, catalogs, comics, series, RSS, vault),
the Tauri command surface, persistence and typed errors live in
[docs/modules.md](docs/modules.md). Read the parts you touch; the rules below are the ones
that must not be broken:

- **Routing**: `useUIStore.currentRoute`; no React Router. A new page updates `App.tsx`,
  `core/types`, `Sidebar`, `BottomNav` (five tabs only) and `AppTitlebar`.
- **Stores**: one file per slice in `src/core/store/`, imported from the barrel with
  individual selectors, never destructured.
- **Imports**: never from `src/core/index.ts`; no path aliases. Import `core/store`,
  `core/types`, `core/lib/*` directly.
- **Startup budget**: `pnpm build` fails above 700 kB or if a heavy engine becomes a startup
  dependency. Closed-at-startup dialogs are `React.lazy`; `src/ui` primitives are imported by
  their own path from `main.tsx`/`App.tsx`, not through the barrel.
- **URL safety**: every off-device URL goes through `src/core/lib/url-safety.ts`; HTML through
  `sanitizeHtml`. Never hand-roll a scheme check.
- **Sync**: follow the rules in [docs/sync.md](docs/sync.md); every change gets a scenario in
  `sync_scenarios.rs`.
- **Reading rhythm**: Rust `theorem-core::reading_rhythm` owns goal/XP rules and merging;
  Tauri calls the native evaluator and browser UI uses its lazy WASM bridge. Keep counter and award identities stable; never
  sum synced XP totals. The device-local reading-chunk outbox must never be synced.
- **Errors**: return `Result<T, AppError>` and branch on `kind()`, never on message text.
- **SQLite**: always `with_connection()`; migrations bump the version and keep a
  `migrate` path.

## Rust-First Engineering, Memory & Search Architecture

- **Search for Rust alternatives first**: Whenever implementing any feature that processes text, files, collections, search, hashing, parsing, or caching, **always search for and prioritize a native Rust implementation** instead of TypeScript. Rust is the single source of truth for heavy computation, file I/O, and data storage. JavaScript/React should only handle UI presentation and lightweight interaction state.
- **Memory & Allocation Optimization (Cloudflare Data Layouts)**:
  - **1. Eliminate Capacity Overhead (`Box<str>` & `Box<[T]>`)**: For all immutable DTOs, cached data models, and serialized responses (e.g. RSS articles, OPDS entries, book search results, TOC items), replace `String` and `Vec<T>` with `Box<str>` and `Box<[T]>`. Standard `String` and `Vec` carry 3 words `(ptr, len, cap)` (24 bytes on 64-bit). `Box<str>` and `Box<[T]>` drop the unused 8-byte capacity field down to 2 words `(ptr, len)` (16 bytes), saving 8 bytes per field (20–30% of DTO heap footprint) and preventing allocator slack.
  - **2. Contiguous Flattening & Bitflags (Fewer Lists & Pointer Indirection)**: Avoid fragmented pointer webs (e.g. structs containing multiple nested `Vec`s or `Box`es). Flatten multiple variable-length elements into a single flat buffer indexed by compact integer offsets (`u16` / `u32`). Pack boolean states and feature flags into bitflags (e.g. `bitflags!` or bitmasks) rather than multiple 1-byte `bool` fields (which incur struct padding alignment penalties up to 8 bytes).
  - **3. Context-Inferred Keys (Dropping the Owner)**: In collections or child records scoped to a known parent context (e.g. articles belonging to a specific feed, annotations for an open book, search results for an active query), omit repeating redundant parent foreign keys (e.g. `feed_id`, `book_id`) inside each child struct in memory. Let the parent container or caller context maintain the identifier once.
  - **4. Enum Variant Sizing & Boxing (`clippy::large_enum_variant`)**: In Rust, an enum's memory footprint equals the size of its largest variant plus discriminator tag and alignment. Box oversized or rare variant payloads (`Box<LargeVariant>`) to ensure high-frequency enums remain compact ($\le 24$ bytes), keeping CPU L1/L2 cache lines hot and preventing stack/heap bloat.
  - **5. Zero-Allocation Slices Over Intermediate Collections**: Use byte-index slicing (`str::char_indices`, `&[u8]`, `&str`) rather than collecting intermediate vectors (`Vec<char>`, `Vec<u8>`, `String`). For streaming parsers and serialization, use thread-local reusable scratchpad buffers and pack exact serialized bytes into `Box<[u8]>` with zero transient reallocations.
- **Hybrid Two-Tier Search Engine (`SQLite FTS5` + `nucleo`)**:
  - **Tier 1 (Disk / OS Page Cache)**: SQLite `FTS5` retrieves coarse candidates (pruning 50,000+ books down to top ~200) in ~1ms without allocating memory.
  - **Tier 2 (SIMD Fuzzy Ranking & Highlighting)**: `nucleo-matcher` (Helix's SIMD-accelerated Smith-Waterman matcher) ranks those candidates, scores typos/word-boundaries, and yields exact matching character indices (`indices`) for UI text highlighting in ~0.1ms.
  - **In-Memory Typeahead**: Command palette, tags, shelves, and table of contents run directly through `nucleo-matcher` in <0.05ms.
  - **No JS matchers**: Never use `fuse.js` or in-memory JavaScript string scanning over large collections.

## Anti-patterns (violations = bugs)

- No React Router — use `useUIStore.currentRoute`
- No `transition-all` — specify the exact property (`pnpm check:design` enforces this and the rules in `docs/design-system.md`)
- No `snap-x snap-mandatory` on scroll containers
- No barrel imports from `src/core/index.ts`
- No Zustand destructuring (`const { x } = useStore()`)
- No `awaitSettledLayout()` / double-RAF delays after navigation (paginator container is grid-sized, measurements are immediate)
- No `Array.find()` on books array — use the store's `getBook(bookId)`
- No `console.log` in production code — use `import.meta.env.DEV` guards
- No heavy computation, text parsing, fuzzy searching, or bulk image processing in JavaScript — search for and use a native Rust alternative (e.g. `nucleo` + SQLite FTS5 instead of `fuse.js`, `image` crate WebP instead of DOM `<canvas>`)

## Release

Versioning, the tagging checklist, CI troubleshooting and the Android icon notes are in
[docs/release.md](docs/release.md). Two rules stay here: only `X.Y.0` is stable (patches are
pre-releases), and never merge to `main`, tag, publish, deploy or close an issue without the
maintainer's approval.

## Project management

The board, labels, issue templates, PR lifecycle and release workflow are in
[docs/project-management.md](docs/project-management.md).

## Cross-repo contracts

Facts this repo shares with other repos. The design system is **read-only**
from here: change it in its own repo, never here.

### Buy Me Momo URL

The URL is written out in this repo as literals, on purpose: a compiled bundle
cannot depend on another repo at build time without real fragility in the
release pipeline.

- Code and config: `src/core/lib/support-prompt.ts` (the support nudge) and
  `.github/FUNDING.yml` (the Sponsor button).
- Docs: `docs/settings.md` and `docs/ARCHITECTURE.md`.
- There is no automated drift check (the `check:content` script and its CI job
  were removed in 1.6.0). The same URL is used by Lemma and the landing sites;
  every place it appears is listed in the handbook note `Brand/Support
  channels`. Change them all together.

### `Fundaments-Work/design-system` — visual language

The studio-wide system: `tokens.md`, `guidelines.md`, `brand/`, `canvas.html`.

- **The shipped code wins.** `tokens.md` states it directly: where the document
  and a shipped codebase disagree, the codebase is authoritative and the
  document is the bug. This repo's `src/core/styles/design-tokens.css` and
  `src/core/lib/design-tokens.ts` are the reference implementation.
- Nothing imports `design-system/` programmatically. Adoption is by hand, and
  that is the drift risk: when a token changes in a product, check whether
  `tokens.md` now disagrees and fix the document.
- Non-negotiable rules, per `tokens.md`: one dark base (`#141416`), corner radius
  `0` on every element, DM Sans/DM Mono at 300/400 only, hierarchy from size and
  colour rather than extra weights, and one accent for the whole lab: acid lime
  `#c6f135`. Theorem has no design system of its own. The only thing it keeps
  from the old one is the reader's serif for book content, which is content
  typography, not interface.
- Hover on an icon button is the accent colour, never a background. The sidebar is
  a fixed 48px rail with no collapse control; the open item is lime with a lime edge.

## CSS conventions

- `content-visibility: auto` + `overscroll-behavior: contain` on scroll containers
- Animate only with Tailwind utilities; guard `animate-fade-in` behind `prefers-reduced-motion: no-preference`
- Use `cn()` from `src/core/lib/utils.ts` for class composition
- Safe areas: use `var(--safe-area-top|right|bottom|left)`, never `env(safe-area-inset-*)` (a test enforces it). Android's WebView reports only the camera cutout through `env()`, so with edge-to-edge (always on from Android 15) pages drew under the status and gesture bars; `src/core/lib/system-insets.ts` feeds Android's real insets (`system_insets` command) into the tokens
- Design tokens in `src/core/styles/design-tokens.css` + `@theme` block in `src/index.css`
