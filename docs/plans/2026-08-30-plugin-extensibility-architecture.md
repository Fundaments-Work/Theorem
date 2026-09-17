# Plugin-First Extensibility Architecture Plan

**Date**: 2026-08-30 (Updated: 2026-09-17)  
**Status**: Architecture Blueprint Deferred to v2.0+ — Replaced in v1.6.0 by Native Modular Power Features  
**Target Milestone**: v2.0.0+ (Long-Term Extensibility & Ecosystem Milestone)  
**Area**: Plugin Engine / WebAssembly Sandbox / Reader Overlays / Custom Views / Capability Security  

---

## 1. Strategic Milestone Revision (2026-09-17): Why Plugins are Deferred to v2.0+

Following in-depth architectural evaluation and review of user requirements, Theorem has **deferred the third-party WebAssembly/isolated plugin runtime to v2.0.0+**, pivoting **v1.6.0** to focus on **native modular power features**:

### A. The Rationale for Deferral to v2.0+
1. **Avoiding Premature API Freeze**: Shipping an external plugin SDK/API in v1.6.0 would force Theorem to commit to public interfaces and backwards compatibility while the underlying SQLite relational migrations, multi-window synchronization, and reader engines are still actively being optimized. Freezing APIs too early creates technical debt.
2. **The "Plugin Illusion" vs. Real User Needs**: Community demand for plugins is driven almost entirely by four specific workflows:
   - Customizable Obsidian / Logseq Markdown templates (custom YAML frontmatter, callout styles, custom tags).
   - Bionic / fast-reading typographic overlays.
   - Anki / spaced-repetition flashcard creation from highlights and vocabulary.
   - External sync with Readwise, Notion, or custom webhooks.
   Implementing these workflows via third-party plugins introduces WASM boundary overhead, IPC latency, sandboxing complexity, and potential UI instability. Implementing them **natively** in Rust and React provides 100× better performance, zero battery drain, zero configuration headaches, and works seamlessly across Desktop and Android.
3. **Sandbox & Security Overhead**: An isolated WebAssembly sandbox (Wasmtime/Extism) with capability manifests, CPU quotas, permission prompts, and a community marketplace requires massive maintenance bandwidth that detracts from the core reading experience.

### B. The v1.6.0 Focus: Native Modular Power Features
In Theorem v1.6.0, Theorem will deliver the extensibility power users want directly within the core:
- **Template-Driven Vault & Note Exporter**: Fully customizable Jinja/Mustache templates for per-book highlights, annotations, and vocabulary (custom frontmatter, callouts, filenames, and Anki card formats).
- **Native Bionic & Speed-Reading Engine**: Typographic fixation and saccade emphasis integrated directly into reader settings and the Foliate/PDF viewport.
- **External Webhooks & Note Integrations**: Direct sync hooks to Readwise, Notion, and configurable HTTP endpoints.
- **Deepened SQLite Virtualization & Performance**: Continued Rust-first memory and storage scaling.

When Theorem reaches **v2.0.0**, with core data layouts and reader geometry completely stabilized and battle-tested, the isolated WebAssembly plugin ecosystem detailed below will be introduced as the platform extension layer.

---

## 2. Executive Summary & Design Philosophy (v2.0.0+ Vision)

Theorem's long-term vision is to become the **Obsidian of Reading Apps** in **v2.0.0+** — a fast, local-first reading hub that is not a closed silo, but an extensible platform where developers and readers can easily build custom tools, note exporters, custom themes, and reading overlays.

### Core Tenets of the Plugin Architecture:
1. **Low Friction (Obsidian-Style Developer Experience)**: Anyone who knows standard JavaScript/TypeScript and React (or Rust/WASM) can build and publish a plugin in minutes.
2. **Zero Core Bloat**: Advanced niche workflows (e.g. Anki flashcard generation, Notion sync, Bionic reading, Zotero bibtex citation matching, DJVU loaders) live as community plugins rather than cluttering the core app.
3. **Local-First & Hot-Reloadable**: Plugins live in `$APPDATA/plugins/<plugin-id>/` with instant live hot-reloading during development.
4. **Sandboxed Security & Stability**: Plugins must **never** corrupt the SQLite database, freeze the main UI thread, or crash Foliate's multi-column paginator layout.

---

## 3. System Architecture & Sandboxed Hierarchy (v2.0.0+)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           PLUGIN RUNTIME ECOSYSTEM                              │
│                    (~/.config/theorem/plugins/<plugin-id>/)                     │
│       ├── manifest.json      (Metadata, permissions, capability declaration)    │
│       ├── main.js / main.wasm(Bundled JS or WebAssembly plugin module)          │
│       └── styles.css         (Scoped custom CSS rules)                          │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    THEOREM PLUGIN RUNTIME & SANDBOX MANAGER                     │
│ ┌─────────────────────────────────────────────────────────────────────────────┐ │
│ │                  WebAssembly / Isolated Worker Sandbox                      │ │
│ │  - Capability-based permission enforcement (network, filesystem, storage)   │ │
│ │  - CPU execution budget and memory limits                                   │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────────────────────────┐ │
│ │                         TheoremPlugin Base Class                            │ │
│ │  - onload() / onunload()                                                    │ │
│ │  - registerCommand({ id, name, callback, hotkey })                          │ │
│ │  - registerSettingTab(SettingTab)                                           │ │
│ │  - registerRibbonIcon(icon, title, callback)                                │ │
│ │  - registerView(viewType, ReactComponent)                                  │ │
│ │  - registerReaderOverlay({ name, component, priority })                     │ │
│ │  - registerVaultExporter({ id, name, exportHandler })                       │ │
│ │  - registerFormatLoader({ extensions, loader })                             │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────────────────────────┐ │
│ │                             EVENT DISPATCH BUS                              │ │
│ │  - app.on('book:open', (book) => ...)                                       │ │
│ │  - app.on('reader:relocate', (loc) => ...)                                  │ │
│ │  - app.on('highlight:create', (highlight) => ...)                           │ │
│ │  - app.on('note:vault-sync', (payload) => ...)                              │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        REACT 19 DECLARATIVE UI SLOTS                            │
│ - Custom Sidebar Views        - Reader SVG Overlays         - Workbench Tabs   │
│ - Context Menu Actions        - Settings Panes              - Command Palette  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Plugin Manifest & Capability Security

Each plugin is a self-contained directory:

```
my-custom-plugin/
├── manifest.json
├── main.js
└── styles.css
```

### `manifest.json` (with Strict Capability Declarations)
```json
{
  "id": "theorem-smart-vault-templates",
  "name": "Smart Obsidian Vault Exporter",
  "version": "1.0.0",
  "minTheoremVersion": "2.0.0",
  "description": "Customizable markdown templates for exporting highlights and notes to Obsidian.",
  "author": "Theorem Community",
  "permissions": [
    "vault:write",
    "annotations:read"
  ]
}
```

### Security Guarantees:
1. **No Unsanctioned File Access**: Plugins can only write to declared vault destinations or isolated plugin folders.
2. **Namespaced SQLite Storage**: Plugins receive isolated tables (`plugin_<id>_kv`) and cannot directly execute arbitrary SQL queries against Theorem's core tables (`book_metadata`, `kv_store`).
3. **Declarative Viewport Slot Isolation**: Plugins **never** touch the Foliate reader's chapter `<iframe>` DOM directly. Overlays must render into Theorem's declarative SVG overlayer, protecting multi-column pagination from crashes.

---

## 5. Core Extension Categories

### A. Reader Overlays & Sensory Modifiers
- **Hook**: `registerReaderOverlay({ id, render, priority })`
- **Use Cases**:
  - **Bionic Reading**: Dynamically bolds the first letters of words in the active viewport (native in v1.6.0; open to plugin overrides in v2.0+).
  - **Translation & Dictionary Glosser**: Injects floating word definitions or interlinear glosses.
  - **Margin Commentary**: Renders sticky notes alongside paragraphs on widescreen monitors.

### B. Custom Note & Vault Exporters
- **Hook**: `registerVaultExporter({ id, name, exportHandler })`
- **Use Cases**:
  - **Template-Driven Markdown Exporter**: Full user customization with Jinja/Mustache syntax (`{{author}}/{{title}}.md`, Callouts, YAML Frontmatter — delivered natively in v1.6.0).
  - **Notion / Readwise / Logseq Exporters**: Syncs highlights to external note systems.
  - **Anki Flashcard Generator**: Converts marked sentences into `.apkg` or connects to AnkiConnect.

### C. Custom Document Formats & Audio Encoders
- **Hook**: `registerFormatLoader({ extensions, loader })`
- **Use Cases**:
  - **DJVU Reader**: Decodes `.djvu` documents into rendered canvas pages.
  - **Markdown / Plain Text Reader**: Treats folders of `.md` files as books.

### D. Custom UI Panes & Workbench Tabs
- **Hook**: `registerView(viewType, ReactComponent)`
- **Use Cases**:
  - **Book Knowledge Graph View**: Interactive 2D/3D force-directed graph connecting books by author, tags, and shared concepts.
  - **Advanced Reading Analytics**: Deep GitHub-style activity charts and velocity graphs.

---

## 6. Developer Experience (DX) & Scaffolding (v2.0.0+)

1. **Official Template**: `create-theorem-plugin`
   ```bash
   pnpm create theorem-plugin my-plugin
   cd my-plugin && pnpm install && pnpm dev
   ```
2. **Hot-Reloading**: Symlinking `my-plugin/` into `~/.config/theorem/plugins/` live-reloads the plugin inside Theorem instantly upon code change without restarting the app.
3. **SDK Package**: `@theorem/plugin-sdk` published with full TypeScript types, UI component helpers, and store hooks.

---

## 7. Implementation Roadmap

### Phase 1: Core Prerequisites & Foundation Stabilization (v1.5.2 – v1.5.5) [Completed]
- [x] Stabilization of Foliate Overlayer and CSS multi-column geometry (`Range.getClientRects()`).
- [x] Database virtualization and SQLite single source of truth (`sqlite_query_books_window`).
- [x] Relational schema separation for heavy content (RSS tables, vocabulary, reading sessions).
- [x] Two-tier search engine (SQLite FTS5 + nucleo SIMD fuzzy ranker).
- [x] Multi-device Iroh P2P sync hardening and direct LAN discovery.

### Phase 2: Native Modular Power Features & Core Extensibility (v1.6.0) [Next Milestone]
- [ ] **Customizable Vault & Note Exporter**: Native Jinja/Mustache template engine in Settings → Devices & Export allowing custom YAML frontmatter, quote callouts, tag transformations, and per-book filenames.
- [ ] **Native Bionic / Speed-Reading Mode**: Typographic fixation/saccade toggle in Reader Settings directly wired to the overlayer rendering path with zero allocation overhead.
- [ ] **Anki Flashcard Generator**: Built-in export format for highlighted sentences and saved vocabulary terms.
- [ ] **External Sync & Webhook Exporters**: Configurable webhook endpoints for pushing highlights to Readwise, Notion, or custom web services.
- [ ] **Multi-Window Sync Hardening**: IPC event deduplication and instant UI refresh across companion windows.

### Phase 3: WebAssembly Plugin Sandbox & Ecosystem (v2.0.0+) [Future Major Release]
- [ ] Native WebAssembly plugin host (Wasmtime / Extism in Rust).
- [ ] Create `src/core/plugins/PluginManager.ts` and `TheoremPlugin.ts` base class.
- [ ] Build plugin directory scanner in `$APPDATA/plugins/`.
- [ ] Implement capability-based permission manager in Theorem Settings.
- [ ] Implement declarative Reader Overlay injection points in `FoliateEngine` and `PDFJsEngine`.
- [ ] Publish `@theorem/plugin-sdk` and `create-theorem-plugin` scaffolding template.
- [ ] In-App Community Plugin Browser with 1-click install.
