# Technical Research & Architecture Specification: Buy Me Momo & Remote Announcement Engine

**Date**: 2026-10-08  
**Status**: Research & Architecture Specification  
**Related Active Plan**: [`docs/plans/2026-10-06-buyme-momo-and-announcements-design.md`](../plans/2026-10-06-buyme-momo-and-announcements-design.md)  
**Authors**: Theorem Core Engineering  
**Primary Code References**:
- Shell & Layout: [`src/shell/layout/Sidebar.tsx`](../../src/shell/layout/Sidebar.tsx), [`src/shell/AppTitlebar.tsx`](../../src/shell/AppTitlebar.tsx), [`src/App.tsx`](../../src/App.tsx)
- Settings & External Links: [`src/features/settings/Settings.tsx`](../../src/features/settings/Settings.tsx), [`src-tauri/capabilities/default.json`](../../src-tauri/capabilities/default.json)
- Persistence & State Patterns: [`src/features/library/Library.tsx`](../../src/features/library/Library.tsx), [`src/core/lib/app-update.ts`](../../src/core/lib/app-update.ts)
- Design Tokens & Theming: [`src/core/styles/design-tokens.css`](../../src/core/styles/design-tokens.css), [`src/index.css`](../../src/index.css)

---

## 1. Executive Summary & Context

Following the successful completion and archival of the **v1.5.6–v1.6.0 Reading System Stabilization Roadmap** (which delivered native-grade PDF link/lens architecture, thumbnails, progressive rendering, relational SQLite storage, byte-range EPUB decompression, and Knap PKM templating across v1.5.8 and v1.5.9), the primary active remaining work for Theorem's v1.6.0 cycle centers on two key surfaces:

1. **Buy Me Momo Integration**: Providing a sustainable, recurring creator-support channel tailored to Nepal's local payment rails (`buymemomo.com/usefundaments`) and global supporters, balanced by a non-intrusive 30-day cadence model.
2. **Remote Announcement & Broadcast Engine**: Establishing a lightweight, zero-HTML, fail-open broadcast channel delivered via an independent Cloudflare Worker (`fundaments-work/theorem-announcements`) and presented to users without compromising reader immersion or security invariants.

This research document details the technical findings, primary source audits, component designs, and edge-case behaviors required to implement these remaining capabilities safely and idiomatically.

---

## 2. Component 1: Buy Me Momo Creator Support

### 2.1 The Need for Buy Me Momo
- **Platform Rail Limitations**: Global platforms like Buy Me a Coffee and Patreon do not support payouts or bank settlements in Nepal due to Stripe and PayPal unavailability.
- **Buy Me Momo**: Built by Tridev Gurung and Pushparaj Bhattarai, Buy Me Momo provides domestic settlement in Nepal via Connect IPS, eSewa, and Khalti, alongside international card rails (Stripe, Apple Pay, Google Pay).
- **Target URL**: `https://buymemomo.com/usefundaments`
- **Zero Financial Processing In-App**: Theorem never processes transactions, handles tokens, or tracks donation receipts internally. The application strictly acts as an external URL launcher.

---

### 2.2 Cadence Engine & Persistence Invariant
To prevent support prompts from turning into annoying visual clutter, the entry point follows a **recurring monthly nudge**:

```mermaid
flowchart TD
    Start["User Opens App"] --> Check{"Check theorem-support:hiddenUntil in localStorage"}
    Check -- "hiddenUntil missing OR now >= hiddenUntil" --> Show["Show Momo Support Button in Shell"]
    Check -- "now < hiddenUntil" --> Hide["Hide Momo Support Button from Shell"]
    Show --> Action{"User clicks icon OR dismisses"}
    Action --> Persist["Write theorem-support:hiddenUntil = now + 30 days<br/>Write theorem-support:lastShownAt = now"]
    Persist --> Hide
```

#### Key Architectural Decisions:
1. **`localStorage` over Zustand Store**:
   - The user's settings store (`settingsStore.ts`) participates in P2P sync and CRDT state exchange across devices.
   - Chrome dismissal and notification cadence is device-local ephemeral state. Writing it into the settings store would propagate dismissal across paired devices and cause merge conflicts.
   - Stored keys:
     - `theorem-support:lastShownAt`: Unix timestamp (ms) of the last interaction.
     - `theorem-support:hiddenUntil`: Unix timestamp (ms) until which the button is suppressed.
2. **Boundary & Time Skew Conditions**:
   - `now === hiddenUntil`: Exactly at the 30-day boundary, the button becomes visible.
   - Backward clock shifts (e.g., NTP adjustment or timezone travel): Calculated using monotonic epoch comparison (`Date.now() >= hiddenUntil`). If clock is manipulated significantly backwards, the prompt remains safely hidden until real time catches up.

---

### 2.3 Shell Placement & DOM Traps

#### Placement 1: Desktop Sidebar Footer ([`src/shell/layout/Sidebar.tsx`](../../src/shell/layout/Sidebar.tsx#L164-L238))
The Sidebar renders two distinct footer layouts based on width and collapsed state:
- **Horizontal Row (`showDesktopFooterRow`)**: Used on wider expanded sidebars. Contains streak counter, Settings, and Collapse toggle. The Momo button is inserted beside Settings matching its exact typography:
  ```tsx
  <button
      onClick={handleMomoClick}
      className="flex items-center gap-2 text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)] transition-colors"
      title="Support Theorem on Buy Me Momo"
  >
      <MomoIcon className="h-4 w-4" />
      <span className="uppercase tracking-[0.08em] text-[11px] font-bold">Support</span>
  </button>
  ```
- **Stacked Layout**: Used on narrow or collapsed sidebars. When collapsed, the button shrinks to the icon only with `title="Support Theorem"`, exactly mirroring the collapsed Settings icon.

#### Placement 2: Mobile Titlebar ([`src/shell/AppTitlebar.tsx`](../../src/shell/AppTitlebar.tsx#L300-L345))
- Located in the right-hand action cluster beside search and the P2P sync status dot.
- Gated on `isMobile()` and `isEligible`.
- **Drag Region Trap**: On Tauri desktop, elements inside titlebars inherit `-webkit-app-region: drag`. On mobile or touch devices, interactive buttons must explicitly enforce `data-tauri-drag-region={undefined}` or `no-drag` attributes to prevent gesture capture by the window manager.

#### Placement 3: Settings → About Links ([`src/features/settings/Settings.tsx`](../../src/features/settings/Settings.tsx#L1417-L1490))
- Located under the "Links" section alongside "GitHub Repository", "Download Latest Release", and "Report an Issue".
- **Permanent Visibility**: Settings is the intentional home for project links. The Support row in Settings is **always visible**, completely independent of the 30-day shell cadence.

---

### 2.4 SVG Iconography (`MomoIcon`)
Because `lucide-react` does not provide a momo/dumpling icon, Theorem requires an inline SVG component designed according to Theorem's design tokens:
- **Geometry**: A crescent silhouette with distinctive pleated top folds.
- **Styling**: `currentColor` inheritance for both strokes and fills, ensuring flawless contrast across Light, Dark, Sepia, and Nord themes.
- **Sizing**: Default viewBox `0 0 24 24` with `w-4 h-4` standard dimensions.

---

### 2.5 External URL Dispatch Helper (`openExternalUrl`)
Existing external links in Theorem use inconsistent patterns (e.g. raw `target="_blank"`, `window.open`, or scattered dynamic imports of `@tauri-apps/plugin-opener`). In Tauri desktop webviews on Linux and Windows, `window.open` can be swallowed or fail silently.

**Solution**: Centralize into [`src/core/lib/open-external-url.ts`](../../src/core/lib/open-external-url.ts):
```ts
export async function openExternalUrl(url: string): Promise<void> {
    try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(url);
        return;
    } catch {
        // Fallback for standard browser environment
    }
    window.open(url, "_blank", "noopener,noreferrer");
}
```
*Audit*: `opener:default` capability is already pre-configured in [`src-tauri/capabilities/default.json:17`](../../src-tauri/capabilities/default.json#L17).

---

## 3. Component 2: Remote Announcement Engine

### 3.1 Architectural Constraint: Why P2P Sync Cannot Deliver Announcements
Theorem's primary sync protocol (`theorem-sync-core`) relies on **Iroh** (Iroh Docs + Iroh Blobs + Iroh Gossip). An initial hypothesis might suggest broadcasting maintainer announcements through Iroh gossip. However, a deep primary-source audit confirms this is fundamentally impossible:
1. **Pairing-Scoped Mesh**: In [`src-tauri/src/sync_commands.rs`](../../src-tauri/src/sync_commands.rs#L739-L751) and [`src-tauri/src/iroh_sync.rs`](../../src-tauri/src/iroh_sync.rs#L559-L647), sync document replicas dial only explicit paired nodes. There is no global rendezvous overlay or public topic.
2. **Settings LWW Collisions**: User settings synchronize via Last-Write-Wins based on `_settingsUpdatedAt` ([`src/core/lib/sync-orchestrator.ts`](../../src/core/lib/sync-orchestrator.ts#L1636-L1641)). Injecting announcements into synced settings would be overwritten by subsequent user edits on paired devices.
3. **Privacy Inversion**: Injecting maintainer data into local CRDT documents would cause that data to replicate onward to all other paired nodes in the user's private mesh.

**Architectural Law**: Announcements must travel strictly over standard HTTPS from an external endpoint. The sync engine is never involved.

---

### 3.2 Cloudflare Worker Infrastructure (`theorem-announcements`)

```
Maintainer PR
(announcements.json)
       │
       ▼
GitHub Actions CI
  • Validates against schema.json
  • Runs Vitest worker suite
  • wrangler kv key put ANNOUNCEMENTS_DATA
       │
       ▼
Cloudflare Edge KV (Globally Replicated)
       │
       ▼
Cloudflare Worker (GET /api/announcements)
  • ETag validation & 304 Not Modified
  • Cache-Control: public, max-age=300
  • Access-Control-Allow-Origin: *
       │
       ▼
Theorem Client (Desktop, Mobile, Web)
```

#### Endpoints:
- `GET /api/announcements`:
  - Returns `{ "announcements": [...], "updatedAt": "..." }`.
  - Serves directly from Cloudflare KV with edge caching (`Cache-Control: public, max-age=300`).
  - Sends `ETag` matching payload hash; handles `If-None-Match` with `304 Not Modified` (0 egress cost).
- `POST /api/announcements`:
  - Protected by `Authorization: Bearer <ADMIN_TOKEN>`.
  - Validates full payload shape against `schema.json`.
  - Rejects unknown severity values, missing IDs, or insecure non-HTTPS links.

---

### 3.3 Announcement Data Schema & Selection Logic

```typescript
export interface Announcement {
    id: string;               // Unique, stable slug (e.g. "1-6-0-release")
    severity: "info" | "warning" | "critical";
    title: string;
    body: string;             // Plain text with **bold** and bare https:// links
    link?: string;            // Primary action URL (https: only)
    linkLabel?: string;       // Primary action button label (e.g. "View Release")
    publishedAt: string;      // ISO 8601 timestamp
    expiresAt?: string | null;// ISO 8601 expiration timestamp
}
```

#### Selection Invariants:
1. **Single-Bar Display**: At most one announcement is rendered at a time.
2. **Filtering Rules**:
   - Announcements with `id` in `localStorage["theorem-announcements:dismissed"]` are omitted.
   - Announcements where `publishedAt > now` (future schedule) are omitted.
   - Announcements where `expiresAt <= now` (expired notices) are omitted.
3. **Ranking Hierarchy**:
   - Highest `severity` takes precedence (`critical` > `warning` > `info`).
   - Tie-breaker: Latest `publishedAt` timestamp.

---

### 3.4 Zero-HTML Security Invariant & Safe URL Parsing

Remote broadcast banners represent a content injection surface into all installed applications. To guarantee immunity against Cross-Site Scripting (XSS), Theorem mandates a **zero-HTML AST data parsing pipeline**:

```mermaid
flowchart LR
    RawText["Body String<br/>'Check **v1.6.0** at https://github.com'"] --> Linkify["linkifySegments()"]
    Linkify --> Segments["Data Segments Array<br/>[text, link, text]"]
    Segments --> BoldParser["renderInlineBold()"]
    BoldParser --> ReactElements["React JSX Nodes<br/>(&lt;span&gt;, &lt;a&gt;)"]
```

#### Security Guarantees:
1. **No HTML Sink**: Neither `dangerouslySetInnerHTML` nor DOM parser injection is permitted. Announcement text is rendered exclusively as native React children, which automatically undergo React's built-in character escaping.
2. **Data-Level AST over String Replacement**:
   - `linkifySegments(body, max = 5)` parses plain string tokens into `{ kind: 'text', value }` or `{ kind: 'link', value, href }`.
   - `renderInlineBold(text)` converts text segments containing `**...**` into `{ bold: boolean, value }` data structures.
3. **Safe URL Verification (`isSafeHttpUrl`)**:
   ```ts
   export function isSafeHttpUrl(raw: string): boolean {
       try {
           const parsed = new URL(raw);
           return parsed.protocol === "https:" && !parsed.username && !parsed.password;
       } catch {
           return false;
       }
   }
   ```
   - **`https:` Only**: `http:`, `javascript:`, and `data:` schemes are strictly rejected and rendered as inert plain text.
   - **Credential Stripping**: Reject `https://user:pass@domain` to prevent spoofing.
   - **Trailing Punctuation Normalization**: Trailing characters (`.,;:!?)]}'`) adjacent to sentence structures are excluded from the `href` attribute while preserving internal parentheses (e.g. Wikipedia links).
   - **Link Density Cap**: At most 5 links per announcement body to prevent rendering unbounded DOM trees.

---

### 3.5 App Integration & Immersion Isolation

#### Placement ([`src/App.tsx`](../../src/App.tsx#L612-L616))
The announcement bar mounts immediately beneath `<AppTitlebar />` and above `<main id="app-main">`:
```tsx
<div className="relative flex-1 flex flex-col min-w-0">
    <AppTitlebar title="Theorem" />
    <AnnouncementBar />
    <main id="app-main" ...>
```

#### Non-Intrusive Invariants:
1. **Reader Mode Isolation**: In `App.tsx:594-602`, the reader returns early (`if (isReaderMode) return <ReaderPage />`). Mounting `<AnnouncementBar />` in the shell layout guarantees that announcements **never** appear while reading a book, article, comic, or PDF.
2. **Hydration Gating**: Does not mount until store hydration and onboarding are complete (`storesHydrated && hasCompletedOnboarding`).
3. **Z-Index Layering**: Rendered at `--z-sticky` (100). Modals (`--z-modal: 200`) and popovers (`--z-popover: 300`) float above it cleanly.
4. **Local Caching**: Fetched responses are cached in `localStorage["theorem-announcements-cache"]` with a 24-hour TTL, ensuring fast, offline-capable startup without blocking initial rendering.

---

## 4. Status of Deferred Architectural Plans

For complete tracking across the repository's planning records:

| Plan | Target | Current Status | Rationale |
|---|---|---|---|
| **Plugin Extensibility Architecture** ([`docs/plans/2026-08-30-plugin-extensibility-architecture.md`](../plans/2026-08-30-plugin-extensibility-architecture.md)) | v2.0.0+ | **Deferred** | Avoids premature API freeze while SQLite data layouts and reader geometry are actively optimized. User extensibility needs are fulfilled natively via Knap AST note templating. |
| **Native PDFium Rendering Engine RFC** ([`docs/plans/2026-09-29-native-pdfium-rendering-engine-rfc.md`](../plans/2026-09-29-native-pdfium-rendering-engine-rfc.md)) | v2.x | **Backlog RFC** | PDF.js v6 with worker destruction, range reading, bounding-box Theorem Lens, and double-buffered zoom provides native-grade performance with zero native binary bloat (+12MB saved). |

---

## 5. Verification & Testing Strategy

In adherence to Theorem's testing principles (`AGENTS.md`):

1. **Unit Testing (`tests/announcements.test.ts`)**:
   - `parseAnnouncements`: handles `null`, corrupted JSON, missing required fields, drops invalid severities.
   - `selectActive`: validates severity precedence (`critical` > `warning` > `info`), handles tiebreaking, future `publishedAt`, expired dates, and dismissed IDs.
   - `linkifySegments`: verifies URL extraction, trailing punctuation trimming, Wikipedia parentheses preservation, `max = 5` cap, and neutralisation of unsafe schemes (`javascript:`, `http:`).
   - `renderInlineBold`: tests unpaired `**`, empty bolding, and complex string segmentation.
2. **Cadence Testing (`tests/support-momo.test.ts`)**:
   - Tests 30-day epoch boundary arithmetic (`now === hiddenUntil`, `now < hiddenUntil`, clock backward skew).
3. **Quality Gates**:
   - Zero TypeScript errors (`pnpm typecheck`).
   - 100% test pass rate across all Vitest suites (`pnpm test`).
   - Clean Rust verification (`cargo fmt --check && cargo clippy && cargo check`).
