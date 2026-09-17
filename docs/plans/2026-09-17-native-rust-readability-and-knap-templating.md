# Architecture Plan: Native Rust Readability Engine & Knap PKM Templating

**Date**: 2026-09-17  
**Status**: Approved Planning & Architectural Specification  
**Target Releases**: v1.5.7–v1.5.9 (Native Rust Readability Engine) $\rightarrow$ v1.6.0 (Knap Universal PKM Templating)  
**Authors**: Theorem Core Engineering Team  

---

## 1. Executive Context & Core Principles

### 1.1 The Rust-First Engineering Mandate
Theorem’s architectural doctrine ([`AGENTS.md`](../../AGENTS.md)) strictly dictates:
> *"Whenever implementing any feature that processes text, files, collections, search, hashing, parsing, or caching, **always search for and prioritize a native Rust implementation** instead of TypeScript. Rust is the single source of truth for heavy computation, file I/O, and data storage. JavaScript/React should only handle UI presentation and lightweight interaction state."*

### 1.2 The Problem with Current Article Extraction
1. **Naive Rust Heuristic**: The initial implementation in `src-tauri/src/article_extractor.rs` used rudimentary substring searching (`s.to_lowercase().find("<article")`) and naive tag stripping. On real-world websites, this failed on complex layouts and nested DOM structures.
2. **Lingering JavaScript Fallback**: Because the native implementation was rudimentary, `@mozilla/readability` and `dompurify` were retained in `src/core/services/ArticleExtractorService.ts` as a browser fallback. This violated Theorem's Rust-first principle and bloated frontend bundles.
3. **Rejection of Defuddle for Core Engine**: While Obsidian's `defuddle` library is promising, it is currently in early development (`v0.19.x`), written purely in TypeScript for browser DOM/Node environments, and undergoes frequent breaking changes. Introducing it into Theorem's core reader would re-introduce heavy DOM processing onto the UI thread.

### 1.3 The Role of Knap vs. Obsidian Web Clipper
- **Knap (`obsidianmd/knap`)**: A lightweight, sandboxed, AST-based template language built specifically by the Obsidian team (`kepano` / Steph Ango) for personal knowledge management (PKM). It has zero `eval` execution, compiles safely, and includes 40+ built-in filters (`callout`, `wikilink`, `yaml`, `date`, `footnote`, `table`, `trim`). Knap is the ideal engine for Theorem's **Vault Sync & Note Exporting**.
- **Branded Theorem Web Clipper (Deferred)**: Obsidian's Web Clipper is MIT-licensed, presenting an opportunity for a custom-branded Theorem Web Clipper browser extension in the future. In accordance with core stabilization priorities, **this initiative is deferred** alongside the WebAssembly plugin architecture.
- **Web Article & RSS Vault Export (Deferred)**: Direct clipping/exporting of web articles and RSS feeds to Obsidian vaults is deferred until the native extraction engine and core book/vocabulary vault sync are fully hardened.

---

## 2. Component 1: Native Rust Readability Engine

### 2.1 Architectural Objectives
- **Complete Elimination of JS Readability**: Remove `@mozilla/readability` and `dompurify` from `package.json` and TypeScript entirely.
- **High-Performance Native Extraction**: Parse, score, and sanitize HTML into clean reading articles in Rust in **< 3ms**.
- **Zero Webview Thread Bloat**: The webview only receives a clean, lightweight DTO (`NativeExtractedArticle`).

### 2.2 Extraction Pipeline (`src-tauri/src/article_extractor.rs`)

```
Raw HTML / URL Fetch
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│ 1. Metadata & OpenGraph Extractor                        │
│    Extract title, author, site_name, published_time,      │
│    lead_image_url via <meta> tags & JSON-LD              │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│ 2. DOM Tree Construction & Clutter Stripping             │
│    Parse HTML5 DOM; strip script, style, nav, header,    │
│    footer, aside, iframe, noscript, ad-banners           │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│ 3. Readability Heuristic Node Scoring                    │
│    • Paragraph length & punctuation density (commas)     │
│    • Class/ID positive weights (article, content, body)  │
│    • Class/ID negative weights (comment, sidebar, promo) │
│    • Link-to-text density penalty (< 0.25 threshold)     │
│    • Accumulate parent candidate scores                  │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│ 4. Structural Sanitization & Normalization               │
│    • Resolve relative img src and a href to absolute URLs│
│    • Normalize heading hierarchy (H1 -> H2)              │
│    • Standardize code blocks & footnotes                 │
│    • Strip residual tracking pixels & hidden elements    │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
NativeExtractedArticle (Box<str> Cloudflare Layouts)
```

### 2.3 Data Model & Zero-Capacity Footprint
Conforming to Theorem's Cloudflare memory layout rules:
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeExtractedArticle {
    pub title: Box<str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byline: Option<Box<str>>,
    pub content: Box<str>,
    #[serde(rename = "textContent", skip_serializing_if = "Option::is_none")]
    pub text_content: Option<Box<str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<Box<str>>,
    #[serde(rename = "siteName", skip_serializing_if = "Option::is_none")]
    pub site_name: Option<Box<str>>,
    #[serde(rename = "leadImageUrl", skip_serializing_if = "Option::is_none")]
    pub lead_image_url: Option<Box<str>>,
    #[serde(rename = "publishedTime", skip_serializing_if = "Option::is_none")]
    pub published_time: Option<Box<str>>,
    pub word_count: usize,
}
```

---

## 3. Component 2: Knap Template Engine for Vault Sync

### 3.1 The Need for Templating in Vault Sync
Theorem's Obsidian Vault synchronization ([`src/core/lib/vault-sync.ts`](file:///run/media/sapiens/Development/Fundaments/Theorem/src/core/lib/vault-sync.ts)) currently constructs Markdown files through rigid hardcoded string arrays. Users cannot customize their frontmatter properties, highlight callouts, or note structures.

### 3.2 Knap Integration
`knap` (`npm install knap`) is integrated into the export pipeline:
- **Zero Eval Security**: Uses an AST-based parser with deterministic execution.
- **PKM Filters**:
  - `wikilink`: `{{ author | wikilink }}` $\rightarrow$ `[[Author Name]]`
  - `callout`: `{{ text | callout: 'quote' }}` $\rightarrow$ `> [!quote]`
  - `yaml`: Safe serialization of custom frontmatter properties.
  - `date`: Custom formatting for reading session timestamps.

### 3.3 Default Templates

#### Book Highlights Template (`defaultBookHighlightTemplate`)
```markdown
---
title: {{ title | yaml }}
author: {{ author | yaml }}
format: {{ format | yaml }}
total_highlights: {{ highlights | length }}
last_sync: {{ syncDate | date: 'YYYY-MM-DD HH:mm:ss' }}
tags:
  - reading/highlights
---

# {{ title }}
*By {{ author | wikilink }}*

---

## Highlights & Notes

{% for item in highlights %}
> [!quote] {{ item.chapterTitle | default: 'Highlight' }} ({{ item.progress | round }}%)
> {{ item.text }}
{% if item.note %}
> 
> **Note**: {{ item.note }}
{% endif %}

*Created: {{ item.createdAt | date: 'YYYY-MM-DD HH:mm' }}*

{% endfor %}
```

#### Vocabulary Term Template (`defaultVocabularyTemplate`)
```markdown
---
term: {{ term | yaml }}
language: {{ language | yaml }}
created: {{ createdAt | date: 'YYYY-MM-DD' }}
tags:
  - vocabulary
  - theorem/lemma
---

# {{ term }}

> [!definition] Definition
> {{ definition }}

{% if context %}
> [!example] Context in {{ bookTitle | default: 'Reading' }}
> {{ context }}
{% endif %}
```

### 3.4 Settings UI & Preset Selection
In **Settings $\to$ Obsidian Vault**:
- Users can choose between presets:
  1. **Theorem Standard** (Obsidian callouts + wikilinks).
  2. **Minimalist** (Blockquotes + plain text).
  3. **Custom** (Live syntax-highlighted Knap template editor).

---

## 4. Deferred Milestones (Future Roadmap)

1. **Theorem Branded Web Clipper (Post-v1.6.0 / v2.0.0)**:
   - Fork and rebrand `obsidianmd/obsidian-clipper` (MIT License) into an official Theorem Companion Extension.
   - Directly connects to Theorem's local P2P sync and native reading queue.
   - Deferred until core reader, PDF parity, and native sync stabilization are 100% complete.
2. **Web Articles & RSS Note Vault Sync (Post-v1.6.0)**:
   - Exporting clipped web articles and RSS feeds directly into vault note files.
   - Deferred until native Rust article extraction and book highlight vault sync are verified in production.

---

## 5. Implementation Phasing

| Phase | Target Version | Scope | Deliverables |
| :--- | :--- | :--- | :--- |
| **Phase 1** | v1.5.7–v1.5.8 | Native Rust Readability Engine | • Implement DOM scoring & clutter stripping in `src-tauri/src/article_extractor.rs`<br>• Deprecate and remove `@mozilla/readability` & `dompurify`<br>• Update `ArticleExtractorService.ts` to call native command exclusively |
| **Phase 2** | v1.5.9 | Knap Template Engine Integration | • Add `knap` to `package.json`<br>• Refactor `vault-sync.ts` to compile notes via Knap AST engine<br>• Ship built-in Obsidian Callout & Wikilink templates |
| **Phase 3** | v1.6.0 | Universal PKM Settings & Presets | • Expose template editor and preset picker in Settings<br>• Unit test suite for edge-case template compilation and corrupted variables |
