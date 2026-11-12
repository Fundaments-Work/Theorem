# Road to the Plugin System: 1.6 → 2.0

**Date**: 2026-10-20 (Updated: 2026-11-12)
**Status**: Proposed — Aligned with v2.0 Svelte UI Rewrite (`AGENTS.md`, `docs/testing-e2e.md`)
**Supersedes**: the schedule in `2026-08-30-plugin-extensibility-architecture.md` (its framework-agnostic manifest and security model stand).
**Goal**: a fully prepared, documented, framework-agnostic plugin system at **2.0.0** alongside the Svelte UI rewrite, tested against `pnpm e2e`.

## Principles

1. **One theme per minor.** Each X.Y.0 is a stable checkpoint; patches are pre-releases (per AGENTS.md).
2. **Dogfood before freezing.** We write our own features as plugins first. The public API is frozen only at 2.0, after the built-ins have used it for a full minor.
3. **UI-framework-agnostic extensions.** Because **v2.0 rewrites the UI in Svelte** (replacing React 19 views while keeping `e2e/specs/` passing unchanged), UI extension points must use declarative schemas, Custom Elements, or sandboxed renderers — never React or Svelte component internals.
4. **No behaviour change while refactoring.** Phases 1.7 and 1.8 must keep the existing Vitest and `pnpm e2e` suites green without edits to assertions.
5. **Plugins never touch the reader iframe DOM.** They draw into the overlayer and use the service facade. This protects pagination and highlight geometry.
6. **Rust stays the source of truth** for heavy work and storage; plugins request capabilities, they don't get raw commands.

## Measured baseline (`1.6.1` -> `1.6.2`)

- **Core/feature isolation achieved on `feature/1.6.2`**: `core/` no longer imports from `features/reader/` (`cover-extractor`, `rss-epub`, `StarDictService`, `reader-runtime-bridge`), dead `ArticleViewer` code was removed, `sync_state.rs` broke circular Rust sync dependencies, and monolithic store/reader/library/sync files were split into cohesive submodules.
- Routing remains a store-driven union (`AppRoute`) in `src/core/types/index.ts`, with lazy-loaded views wired in `src/App.tsx`, `Sidebar`, `BottomNav`, and `AppTitlebar`.
- Tauri commands remain in a single `generate_handler!`, with blocking SQLite/audio/TTS work routed through `offload_commands.rs` returning `Result<T, AppError>`.
- `tests/` + `e2e/specs/` establish framework-agnostic behavioral verification across UI boundaries.

## 1.6.x: ship clean (`1.6.2` complete prerequisite)

- [x] Cross-page highlight merge, touch anchoring, no page travel on touch.
- [x] Remove `core/` -> `features/reader/` imports (`reader-runtime-bridge.ts`, `core/lib/`).
- [x] Split monolithic frontend/Rust modules (`libraryStore`, `sync-orchestrator`, `Library`, `Reader`, `foliate-engine`, `pdfjs-engine`, `batch_ingest`, `sync_commands`).
- [ ] Real-device verification on Android and final `1.6.2` quality gates (`AGENTS.md`).

**Exit:** `core/` imports nothing from `features/`, Rust sync/ingest modules are acyclic, and `e2e/specs/` stay decoupled from React internals.

## 1.7.x: internal module registry & Svelte boundary prep

- `src/core/modules/`: `registerModule({ id, routes, sidebarItems, settingsPanes, commands, shortcuts })`.
- Framework-agnostic service/store boundary so Svelte 2.0 views consume plain Zustand/service snapshots without React coupling.
- Replace the `AppRoute` switch with registry lookups (string route ids, lazy components).
- Sidebar, titlebar, command palette and settings tabs render from the registry.

**Exit:** adding a feature requires touching only its own folder plus one registration line; all tests green and startup bundle budget preserved.

## 1.8.x: events, services and capabilities

- Typed event bus: `book:open`, `book:close`, `reader:relocate`, `selection:change`, `highlight:create|update|merge|delete`, `sync:complete`.
- Read-mostly service facade: `library`, `annotations`, `vocabulary`, `settings` (no store or UI framework handles leaked).
- Rust: group Tauri commands into capability scopes (`fs`, `net`, `db`, `tts`, `sync`, `vault`, `dict`); a registry checks scope before dispatch. Commands keep their names; this is an additive gate.
- Per-plugin storage namespace (`plugin_<id>_kv`) in SQLite.
- Draft the framework-agnostic manifest and declarative UI slot schemas as an RFC in `docs/plans/`.

**Exit:** all built-in modules use events/services instead of reaching into stores; scope table covers every command.

## 1.9.x: extension points & Svelte 2.0 convergence

- Extension points with real consumers: `vaultExporter`, `formatLoader`, `dictionaryProvider`, `readerOverlay` (overlayer only), `view` (framework-agnostic declarative descriptor / Custom Element in Workbench), `command`.
- Move existing implementations (Obsidian/Markdown exporter, MDict/StarDict, Free Dictionary) onto these as built-in plugins.
- Experimental SDK `@theorem/plugin-sdk` (0.x) behind a developer-mode toggle; local plugins from `$APPDATA/plugins/`, manifest + permission prompt, hot reload.
- Sandbox decision: prototype both WASM (Extism/wasmtime) and isolated workers against the same two sample plugins; choose on measured startup, memory, and Android WebView ergonomics. Decide at 1.9.0, not before.
- Write 3 external-style sample plugins (template exporter, reading ruler overlay, custom format loader) and fix every API pain they expose.

**Exit:** the three sample plugins run identically with no private or framework-specific imports; API churn in the last two 1.9 patches is zero.

## 2.0.0: Svelte UI rewrite + frozen plugin SDK

- Ship the Svelte UI rewrite verified by the unchanged `pnpm e2e` suite (`docs/testing-e2e.md`).
- SDK 1.0 + semver policy; `minTheoremVersion` enforced.
- Permission UI, per-plugin enable/disable, crash isolation (a failing plugin cannot block startup).
- `create-theorem-plugin`, docs site section, contribution guide, plugin review checklist.
- Community plugin browser (index file in a repo first; in-app 1-click install after).

## Risks

| Risk | Mitigation |
|------|-----------|
| Freezing a highlight/anchor API too early | Highlights/CFI exposed only via the service facade, and only at 1.9+; `highlight:merge` shipped in 1.6 gives us a real event to test |
| Reader overlay breaking pagination | Overlayer-only rendering, per-plugin error boundary, frame-budget watchdog |
| Android WebView limits for WASM/workers | Prototype on device at 1.9, not desktop only |
| Scope creep from "everything is a plugin" | Core stays core: library, reader engines, sync, persistence are modules but not removable |
| Contributor load | RFC per minor, `good first issue` for plugin samples and docs |

## Per-release rhythm (the ~40 micro releases)

- Every minor opens with an RFC and closes with a "what broke" report against the previous plugin-facing surface.
- Each patch lands one reviewable slice (e.g. 1.7.1 library module, 1.7.2 reader module…), never a mixed refactor.
- Changelog has an "API changes" section from 1.8 onward.
