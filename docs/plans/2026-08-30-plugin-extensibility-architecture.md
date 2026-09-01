# Plugin-First Extensibility Architecture Plan

**Date**: 2026-08-30  
**Status**: Architecture Blueprint  
**Area**: Plugin Engine / Extensibility API / Reader Overlays / Custom Views  

---

## 1. Executive Summary & Design Philosophy

Theorem's long-term vision is to become the **Obsidian of Reading Apps** — a fast, local-first reading hub that is not a closed silo, but a modular platform where developers and readers can easily build custom tools, note exporters, custom themes, and reading overlays.

### Core Tenets of the Plugin-First Architecture:
1. **Low Friction (Obsidian-Style Developer Experience)**: Anyone who knows standard JavaScript/TypeScript and React can build and publish a plugin in minutes.
2. **Zero Core Bloat**: Advanced niche workflows (e.g. Anki flashcard generation, Notion sync, Bionic reading, Zotero bibtex citation matching, DJVU loaders) live as community plugins rather than cluttering the core app.
3. **Local-First & Hot-Reloadable**: Plugins live in `$APPDATA/plugins/<plugin-id>/` with instant live hot-reloading during development.

---

## 2. System Architecture & Component Hierarchy

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           PLUGIN RUNTIME ECOSYSTEM                              │
│                    (~/.config/theorem/plugins/<plugin-id>/)                     │
│       ├── manifest.json      (Metadata, permissions, version)                   │
│       ├── main.js            (Bundled JS module exporting default Plugin class) │
│       └── styles.css         (Scoped custom CSS rules)                          │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         THEOREM PLUGIN RUNTIME MANAGER                          │
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
│                              REACT 19 UI SLOTS                                  │
│ - Custom Sidebar Views        - Reader Text Overlays        - Workbench Tabs   │
│ - Context Menu Actions        - Settings Panes              - Command Palette  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Plugin Manifest & Structure

Each plugin is a self-contained directory containing three files:

```
my-custom-plugin/
├── manifest.json
├── main.js
└── styles.css
```

### `manifest.json`
```json
{
  "id": "theorem-smart-vault-templates",
  "name": "Smart Obsidian Vault Exporter",
  "version": "1.0.0",
  "minAppVersion": "1.3.0",
  "description": "Customizable template-driven highlight and metadata sync into Obsidian vaults.",
  "author": "Community Developer",
  "isDesktopOnly": false,
  "permissions": ["vault", "annotations"]
}
```

---

## 4. The Extensibility API Surface

Every plugin extends `TheoremPlugin` provided by `@theorem/plugin-sdk`:

```ts
import { TheoremPlugin, SettingTab, Setting } from "@theorem/plugin-sdk";

export default class SmartVaultPlugin extends TheoremPlugin {
    async onload() {
        console.log("Loading Smart Obsidian Vault Plugin");

        // 1. Register a command in the Command Palette (Ctrl+P / Cmd+P)
        this.registerCommand({
            id: "sync-current-book-to-vault",
            name: "Sync Current Book to Obsidian Vault",
            hotkey: "Mod+Shift+V",
            callback: () => this.syncCurrentBook(),
        });

        // 2. Register a live event hook
        this.registerEvent(
            this.app.on("highlight:create", (highlight) => {
                if (this.settings.autoSyncOnHighlight) {
                    this.appendHighlightToVault(highlight);
                }
            })
        );

        // 3. Register a Settings UI Tab
        this.registerSettingTab(new SmartVaultSettingTab(this.app, this));
    }

    async onunload() {
        console.log("Unloading Smart Obsidian Vault Plugin");
    }
}
```

---

## 5. Core Plugin Extension Categories

### A. Reader Overlays & Sensory Modifiers
- **Hook**: `registerReaderOverlay({ id, render, priority })`
- **Use Cases**:
  - **Bionic Reading Plugin**: Applies dynamic saccadic eye fixation bolding to the first letters of words in the active viewport.
  - **Translation & Dictionary Glosser**: Injects floating word definitions or interlinear translations between paragraphs.
  - **Margin Commentary**: Renders margin sticky notes alongside paragraphs on large widescreen monitors.

### B. Custom Note & Vault Exporters
- **Hook**: `registerVaultExporter({ id, name, exportHandler })`
- **Use Cases**:
  - **Template-Driven Markdown Exporter**: Full user customization with Jinja/Mustache syntax (`{{author}}/{{title}}.md`, Callouts, YAML Frontmatter).
  - **Notion / Readwise / RemNote / Heptabase Exporters**: Syncs highlights to external cloud note apps.
  - **Anki Flashcard Generator**: Converts marked sentences into `.apkg` or pushes directly to AnkiConnect.

### C. Custom Document Formats & Audio Encoders
- **Hook**: `registerFormatLoader({ extensions, loader })`
- **Use Cases**:
  - **DJVU Reader**: Decodes `.djvu` documents into rendered canvas pages.
  - **Markdown / Plain Text Reader**: Treats directories of `.md` files as books.

### D. Custom UI Panes & Workbench Tabs
- **Hook**: `registerView(viewType, ReactComponent)`
- **Use Cases**:
  - **Book Knowledge Graph View**: Interactive 2D/3D force-directed graph connecting books by author, tags, and shared concepts.
  - **Reading Heatmap & Analytics**: Deep GitHub-style activity charts and velocity graphs.

---

## 6. Developer Experience (DX) & Scaffolding

To empower developers to create plugins effortlessly:

1. **Official Template**: `create-theorem-plugin`
   ```bash
   pnpm create theorem-plugin my-plugin
   cd my-plugin && pnpm install && pnpm dev
   ```
2. **Hot-Reloading**: Symlinking `my-plugin/` into `~/.config/theorem/plugins/` live-reloads the plugin inside Theorem instantly upon code change without restarting the app.
3. **SDK Package**: `@theorem/plugin-sdk` published with full TypeScript types, UI component helpers, and store hooks.

---

## 7. Implementation Roadmap

### Phase 1: Plugin Manager & Runtime Loader
- [ ] Create `src/core/plugins/PluginManager.ts` and `TheoremPlugin.ts` base class.
- [ ] Build plugin directory scanner in `$APPDATA/plugins/`.
- [ ] Build Community & Installed Plugins view in Theorem Settings.

### Phase 2: Extension Hooks & Overlays
- [ ] Implement Reader Overlay injection points in `FoliateEngine` and `PDFJsEngine`.
- [ ] Implement event dispatch bus (`book:open`, `highlight:create`, `location:change`).
- [ ] Build reference **Obsidian Smart Vault** plugin with customizable templates.
- [ ] Publish `@theorem/plugin-sdk` and `create-theorem-plugin` template.
