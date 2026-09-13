# Plugin-First Extensibility Architecture Plan

**Date**: 2026-08-30 (Updated: 2026-09-13)  
**Status**: Active Architecture Blueprint & Specification  
**Target Milestone**: v1.6.0 (The Extensibility Release)  
**Area**: Plugin Engine / WebAssembly Sandbox / Reader Overlays / Custom Views / Capability Security  

---

## 1. Executive Summary & Design Philosophy

Theorem's long-term vision is to become the **Obsidian of Reading Apps** in **v1.6.0** — a fast, local-first reading hub that is not a closed silo, but an extensible platform where developers and readers can easily build custom tools, note exporters, custom themes, and reading overlays.

### Core Tenets of the Plugin Architecture:
1. **Low Friction (Obsidian-Style Developer Experience)**: Anyone who knows standard JavaScript/TypeScript and React (or Rust/WASM) can build and publish a plugin in minutes.
2. **Zero Core Bloat**: Advanced niche workflows (e.g. Anki flashcard generation, Notion sync, Bionic reading, Zotero bibtex citation matching, DJVU loaders) live as community plugins rather than cluttering the core app.
3. **Local-First & Hot-Reloadable**: Plugins live in `$APPDATA/plugins/<plugin-id>/` with instant live hot-reloading during development.
4. **Sandboxed Security & Stability**: Plugins must **never** corrupt the SQLite database, freeze the main UI thread, or crash Foliate's multi-column paginator layout.

---

## 2. System Architecture & Sandboxed Hierarchy

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

## 3. Plugin Manifest & Capability Security

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
  "minTheoremVersion": "1.6.0",
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

## 4. Core Extension Categories

### A. Reader Overlays & Sensory Modifiers
- **Hook**: `registerReaderOverlay({ id, render, priority })`
- **Use Cases**:
  - **Bionic Reading**: Dynamically bolds the first letters of words in the active viewport.
  - **Translation & Dictionary Glosser**: Injects floating word definitions or interlinear glosses.
  - **Margin Commentary**: Renders sticky notes alongside paragraphs on widescreen monitors.

### B. Custom Note & Vault Exporters
- **Hook**: `registerVaultExporter({ id, name, exportHandler })`
- **Use Cases**:
  - **Template-Driven Markdown Exporter**: Full user customization with Jinja/Mustache syntax (`{{author}}/{{title}}.md`, Callouts, YAML Frontmatter).
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

## 5. Developer Experience (DX) & Scaffolding

1. **Official Template**: `create-theorem-plugin`
   ```bash
   pnpm create theorem-plugin my-plugin
   cd my-plugin && pnpm install && pnpm dev
   ```
2. **Hot-Reloading**: Symlinking `my-plugin/` into `~/.config/theorem/plugins/` live-reloads the plugin inside Theorem instantly upon code change without restarting the app.
3. **SDK Package**: `@theorem/plugin-sdk` published with full TypeScript types, UI component helpers, and store hooks.

---

## 6. Implementation Roadmap

### Phase 1: Core Prerequisites (v1.5.2 & v1.5.3)
- [x] Stabilization of Foliate Overlayer and CSS multi-column geometry.
- [ ] Database virtualization and SQLite single source of truth.
- [ ] Relational schema separation for heavy content (RSS, sessions).

### Phase 2: Plugin Engine & Runtime Sandbox (v1.6.0)
- [ ] Create `src/core/plugins/PluginManager.ts` and `TheoremPlugin.ts` base class.
- [ ] Build plugin directory scanner in `$APPDATA/plugins/`.
- [ ] Implement capability permission prompts in Theorem Settings.
- [ ] Implement Reader Overlay injection points in `FoliateEngine` and `PDFJsEngine`.
- [ ] Build reference **Obsidian Smart Vault** plugin with customizable templates.
- [ ] Publish `@theorem/plugin-sdk` and `create-theorem-plugin` template.
