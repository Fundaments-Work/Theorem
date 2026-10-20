# Road to the Plugin System: 1.6 → 2.0

**Date**: 2026-10-20
**Status**: Proposed
**Supersedes**: the schedule in `2026-08-30-plugin-extensibility-architecture.md` (its design, manifest and security model still stand).
**Goal**: a fully prepared, documented plugin system at **2.0.0** that outside contributors can build against.

## Principles

1. **One theme per minor.** Each X.Y.0 is a stable checkpoint; patches are beta (per AGENTS.md).
2. **Dogfood before freezing.** We write our own features as plugins first. The public API is frozen only at 2.0, after the built-ins have used it for a full minor.
3. **No behaviour change while refactoring.** Phases 1.7 and 1.8 must keep the existing test suite green without edits to assertions.
4. **Plugins never touch the reader iframe DOM.** They draw into the overlayer and use the service facade. This protects pagination and highlight geometry.
5. **Rust stays the source of truth** for heavy work and storage; plugins request capabilities, they don't get raw commands.

## Measured starting point (1.6.0)

- Features are isolated: only 2 cross-feature imports (reader → library `ShareMenu`, library → share).
- 5 places in `core/` import from `features/reader` (`cover-extractor`, `rss-epub`, `StarDictService`, `core-worker`, `foliate-runtime`).
- Routing is a closed union (`AppRoute`, 10 routes) with a hand-written switch in `App.tsx`; adding a route touches `App.tsx`, `types`, `Sidebar`, `AppTitlebar`.
- 182 Tauri commands, not grouped by capability; one `generate_handler!`.
- Reader: ~23.5k LOC, two engines (Foliate, PDF.js).

## 1.6.x: ship clean (no plugin work)

- Cross-page highlight merge, touch anchoring, no page travel on touch (done on this branch).
- Real-device verification on Android (long-press, handle drag across a page break, tap on a merged highlight).
- Fix the 5 core → reader leaks (move shared helpers into `core/lib`); delete dead prewarm functions.
- Quality gates from AGENTS.md; release as 1.6.0.

**Exit:** `core/` imports nothing from `features/`.

## 1.7.x: internal module registry

- `src/core/modules/`: `registerModule({ id, routes, sidebarItems, settingsPanes, commands, shortcuts })`.
- Library, reader, feeds, catalogs, statistics, share, onboarding, settings become modules.
- Replace the `AppRoute` union and `App.tsx` switch with registry lookups (string route ids, lazy components).
- Sidebar, titlebar, command palette and settings tabs render from the registry.
- Zustand stores stay global, one file per slice; modules may add slices.

**Exit:** adding a feature requires touching only its own folder plus one registration line. 1166+ tests green, bundle size not worse.

## 1.8.x: events, services and capabilities

- Typed event bus: `book:open`, `book:close`, `reader:relocate`, `selection:change`, `highlight:create|update|merge|delete`, `sync:complete`.
- Read-mostly service facade: `library`, `annotations`, `vocabulary`, `settings` (no store handles leaked).
- Rust: group the 182 commands into capability scopes (`fs`, `net`, `db`, `tts`, `sync`, `vault`, `dict`); a registry checks scope before dispatch. Commands keep their names; this is an additive gate.
- Per-plugin storage namespace (`plugin_<id>_kv`) in SQLite.
- Draft the manifest schema and publish it as an RFC in `docs/plans/`.

**Exit:** all built-in modules use events/services instead of reaching into stores; scope table covers every command.

## 1.9.x: extension points, built-in first

- Extension points with real consumers: `vaultExporter`, `formatLoader`, `dictionaryProvider`, `readerOverlay` (overlayer only), `view` (workbench tab), `command`.
- Move existing implementations (Obsidian/Markdown exporter, MDict/StarDict, Free Dictionary, article reader) onto these as built-in plugins.
- Experimental SDK `@theorem/plugin-sdk` (0.x) behind a developer-mode toggle; local plugins from `$APPDATA/plugins/`, manifest + permission prompt, hot reload.
- Sandbox decision: prototype both WASM (Extism/wasmtime) and isolated workers against the same two sample plugins; choose on measured startup, memory, and API ergonomics. Decide at 1.9.0, not before.
- Write 3 external-style sample plugins (template exporter, reading ruler overlay, custom format loader) and fix every API pain they expose.

**Exit:** the three sample plugins run with no private imports; API churn in the last two 1.9 patches is zero.

## 2.0.0: freeze and open

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
