# Buy Me Momo + Announcement Bar — Design

**Date**: 2026-10-06
**Status**: In Progress — Theorem client integration delivered (items 2–5); Worker deployment next
**Area**: Shell / Remote Config / Monetization
**Repos touched**: `Theorem` (this), `theorem-announcements` (new)

---

## 1. Goals & Non-Goals

### Goals

1. Add a **Buy Me Momo** support link (Nepali creator-funding platform) — a lightweight, non-intrusive, **monthly-cadence** surface in the app shell.
2. Add an **announcement bar** that lets the maintainer push arbitrary information to **every** install (desktop, Android, iOS, browser) from one place.

### Non-Goals (explicit)

- **No sync-based announcements.** See §2 — iroh sync structurally cannot reach users you have not paired with. Announcements are HTTP-only, permanently.
- No in-app "what's new" changelog viewer. (Natural follow-up, not in scope.)
- No receipts, supporter list, donation amounts, or payment processing inside the app. Theorem never touches money; it only opens a URL.
- No announcement rich-text / Markdown rendering. Plain text with `**bold**`, `\n`, and auto-linkified `https://…` URLs only (§4.4, §5.4). No HTML sink anywhere in the render path.

---

## 2. Critical Finding: Sync Cannot Deliver Announcements

The natural instinct is to ride the existing P2P sync. **This is not possible**, and it is worth recording so nobody re-litigates it later.

Traced through the implementation:

| Fact | Location |
|---|---|
| `docs_set_entry` builds its write targets **exclusively** from paired devices that have a `sync_doc_id` | `src-tauri/src/sync_commands.rs:739-751` |
| Sync meshes only ever dial that same stored peer list | `src-tauri/src/iroh_sync.rs:559-647` |
| `iroh-gossip` is constructed **only** as iroh-docs transport plumbing | `iroh_sync.rs:509`, `:518`, `:726` |
| **Zero** `broadcast()` / `subscribe(topic)` calls exist anywhere in `src-tauri/` | grep: `gossip` yields 4 hits, all in `iroh_sync.rs` |
| No rendezvous service, no global topic | — |

Consequences:

- Gossip only reaches nodes already in the same overlay. Reaching "all users" would require every user to be mutually connected, which directly contradicts the privacy model.
- Even for paired users, settings merge is **last-writer-wins by `_settingsUpdatedAt`** (`sync-orchestrator.ts:1636-1641`). A maintainer-authored announcement could not be distinguished from a user edit, and any user settings write would clobber it.
- Pushing maintainer-authored state into users' CRDT replicas would make it part of their *synced* state and propagate onward to any third device they pair — a privacy inversion we do not want.

**Decision: announcements travel over HTTP only. Sync is never involved.**

---

## 3. Buy Me Momo

**URL**: `https://buymemomo.com/usefundaments`

### 3.1 Background

BuyMeMomo is a Nepali creator-funding platform — the local answer to Buy Me a Coffee — founded by Tridev Gurung (US) and Pushparaj Bhattarai (Nepal), launched 2025-08-15. It exists precisely *because* Buy Me a Coffee and Patreon are not usable in Nepal (Stripe/PayPal unavailable). Domestic rails: Connect IPS, eSewa, Khalti. International: Stripe / card / Apple Pay / Google Pay. 7% platform fee, 15-day payouts.

The repo already declares `.github/FUNDING.yml` → `github: [Fundaments-Work]`, but that button is inert unless the org's GitHub Sponsors profile is enabled. Adding BuyMeMomo gives a working, Nepal-local path today.

### 3.2 Cadence: monthly

A permanent icon in the titlebar becomes furniture nobody reads, and the reading-streak `Flame` already occupies that visual slot (`Sidebar.tsx:171`). So the icon is a **recurring nudge**:

- First run: visible.
- On click **or** dismiss: `nextEligibleAt = now + 30 days`, persisted locally.
- Reappears once `now >= nextEligibleAt`.

One rule for **both** desktop and mobile — deliberately not a platform split.

**Storage** (localStorage, not the settings store — this is ephemeral chrome state, not user configuration, so it must not enter the CRDT or sync to other devices):

| Key | Value |
|---|---|
| `theorem-support:lastShownAt` | epoch ms of last click-or-dismiss |
| `theorem-support:hiddenUntil` | epoch ms; icon hidden while `now < hiddenUntil` |

Visibility = `hiddenUntil` absent, or `Date.now() >= hiddenUntil`. Derived value, no separate boolean.

### 3.3 Placement

**Desktop sidebar footer** — `src/shell/layout/Sidebar.tsx:164-238`.

Two branches exist and both need the icon:

- `showDesktopFooterRow` (`:168-197`) — the single horizontal row: streak · Settings · collapse.
- The stacked variant (`:198-237`) — expanded / collapsed / mobile drawer.

New button matches the sibling `Settings` button exactly: `uppercase tracking-[0.08em] text-[11px] font-bold`, same hover colours, `shrink-0`. Collapsed state reduces to icon + `title` tooltip, identical to how Settings collapses.

Icon: a momo glyph. `lucide-react` has no momo, so ship a small inline SVG component (`MomoIcon`) — a crescent dumpling silhouette. Keep it monochrome and inherit `currentColor` so it themes correctly in dark mode via the existing tokens.

**Mobile titlebar** — right-hand cluster at `src/shell/AppTitlebar.tsx:319` (beside search and the sync-status dot). One ~32px `ui-icon-btn`. Gated on `isMobile()` + the monthly check. Adding a `data-tauri-drag-region={undefined}` is required — without it the button swallows window drags on desktop. (Not applicable: this branch is mobile-only, but the titlebar sets the attribute conditionally, so verify.)

**Settings → About** — `src/features/settings/Settings.tsx`, "Links" section (`:1417-1490`). A **Support Theorem** row copying the existing `<a>` row markup (`:1423-1431`), with the momo icon. **Always visible** regardless of cadence — Settings is the deliberate, permanent home.

### 3.4 `openExternalUrl()` helper

The existing About rows use `target="_blank"`, which relies on `window.open` — unreliable in the Tauri webview on desktop. The codebase's real convention is dynamic import of the opener plugin (`NeuralVoiceSection.tsx:310`, `FeedsPage.tsx:232`, `pdfjs-engine.tsx:1300`).

Create `src/core/lib/open-external-url.ts`:

```ts
export async function openExternalUrl(url: string): Promise<void> {
    try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(url);
        return;
    } catch {
        /* plugin unavailable (browser, or older native) — fall through */
    }
    window.open(url, "_blank", "noopener,noreferrer");
}
```

Used by both momo placements and the new Settings row. A donation link that silently does nothing on desktop is the worst failure mode for this feature.

`opener:default` is already granted in `src-tauri/capabilities/default.json:17`.

---

## 4. Announcements Worker (`fundaments-work/theorem-announcements`)

New **public** repo. Single Cloudflare Worker + KV binding. Public so `raw.githubusercontent.com` and the deploy hook stay simple, and so the announcement history is auditable.

### 4.1 Why a repo rather than a Worker script

"Post an announcement in a certain format" is far nicer as a reviewed PR than a `wrangler kv put` from a laptop.

```
theorem-announcements/
├── src/index.ts              # Worker: GET + POST, CORS, validation
├── announcements.json        # ← source of truth, the thing you edit
├── schema.json               # JSON Schema for validation
├── wrangler.toml             # kv_namespaces binding
└── .github/workflows/sync.yml # on push to main → wrangler kv key put
```

Flow: **edit `announcements.json` → PR → merge → Action syncs to KV → live globally.**

KV as the serving layer means the Worker has **no runtime dependency on GitHub**. If GitHub is down, announcements still serve. `wrangler kv key put` stays available as the escape hatch for urgent posts.

### 4.2 Endpoints

**`GET /api/announcements`** →

```json
{ "announcements": [ /* …schema below… */ ], "updatedAt": "2026-10-20T09:00:00Z" }
```

Headers: `ETag`, `Cache-Control: public, max-age=300`, `Access-Control-Allow-Origin: *` (public read-only data), `Access-Control-Allow-Methods: GET, POST, OPTIONS`.

**`POST /api/announcements`** → validates against `schema.json`, writes KV. Auth: `Authorization: Bearer <token>` compared against a Worker secret (`wrangler secret put ADMIN_TOKEN`). Returns `401` on mismatch. Rate-limited by Cloudflare by default.

`OPTIONS` preflight handled so the POST is usable from a browser admin page later.

### 4.3 Announcement schema

```jsonc
{
  "id": "1-5-10-out",          // stable dismissal key — human-meaningful, never reused
  "severity": "info",          // "info" | "warning" | "critical"
  "title": "Theorem 1.5.10 is out",
  "body": "Series grouping on shelves is much faster now.\nDetails at https://github.com/Fundaments-Work/Theorem/releases/tag/v1.5.10",
  "link": "https://github.com/Fundaments-Work/Theorem/releases/tag/v1.5.10",
  "linkLabel": "See what's new",  // optional
  "publishedAt": "2026-10-20T09:00:00Z",
  "expiresAt": null              // optional ISO date; maintenance notices self-retire
}
```

`body` supports two link styles, both safe by construction (§4.4):

- A bare `https://…` URL is **auto-linkified** in place.
- `link` + `linkLabel` renders one dedicated CTA button — use it for the single most important action.

Rules:

- `id` **must** be stable — it is what users have already dismissed. Reusing an id means nobody sees the new text.
- Only one announcement is displayed at a time. Selection: highest `severity` (critical > warning > info), then most recent `publishedAt`.
- `publishedAt` in the future → treat as not yet active (lets you schedule).
- `expiresAt` in the past → filtered out entirely.
- An empty array is valid and means "no announcements" — the bar simply does not render.
- At most **one** `link`. A second is a Worker-side validation error, not a silent override.

### 4.4 Links

Two mechanisms, both supported. Links are first-class — announcements routinely need a "what's new" or "report this" target.

**a) Auto-linkified bare URLs in `body`.** A pasted `https://…` becomes a tappable link. Implemented as a **pure string split**, not regex-replacement into HTML:

```
linkify(body) → Array<{ kind: "text", value } | { kind: "link", value, href }>
```

The renderer maps segments to React elements with `key`, rendering `kind === "link"` as `<a href={href}>`. Because React escapes interpolated text, there is **no HTML sink and no injection surface** — `<script>` in the body renders as literal characters, structurally, not by filtering.

**b) A dedicated CTA via `link` + `linkLabel`.** For the primary action ("See what's new"), rendered as an explicit button/anchor. At most one; a second `link` overrides the first (Worker-side validation rejects it).

Every `href` — from both mechanisms — passes `isSafeHttpUrl()` before reaching the DOM:

```ts
function isSafeHttpUrl(raw: string): boolean {
    try {
        const u = new URL(raw);
        return u.protocol === "https:" && !u.username && !u.password;
    } catch {
        return false;
    }
}
```

Rejecting `javascript:`/`data:` is inherent here, not a denylist. Requiring **https:** (not http) is deliberate — MITM on an announcement bar that can carry a download link is a real risk. Also reject credentialed URLs (`user:pass@`) so a link cannot masquerade as the maintainer's domain.

Trailing-punctuation trimming is required so `see https://x.com.` does not swallow the full stop into the href. Cap auto-linked URLs per body (e.g. 5) to keep the bar bounded.

### 4.5 Security posture

The Worker is a **remote content-injection channel into every install**. Posture, in order of strength:

1. **No HTML sink.** Announcements never touch `dangerouslySetInnerHTML`. Text is rendered as React children (auto-escaped); links are rendered as real `<a>` elements. Injection is *structurally impossible*, not filtered.
2. **`https:`-only links**, no credentials, via `isSafeHttpUrl()` (§4.4).
3. **No Markdown engine, no new dependency.** Formatting is line breaks + `**bold**` + linkify, all hand-rolled pure functions.

> **Noted alternative, deliberately rejected.** The codebase already has `src/core/lib/sanitize.ts` — DOMPurify with `ALLOWED_TAGS` including `a`, `href`, and `target` — used for book descriptions and RSS article HTML (`Library.tsx:704`, `FeedsPage.tsx:201`). Reusing it for announcements would work and add no dependency. It is not chosen because it makes injection *unlikely* rather than *impossible*, it widens the accepted surface (a body containing `<b>`, `<ul>`, `<img>` would suddenly be honoured, inconsistent with a plain-text spec), and it puts a sanitizer bypass in front of a maintainer-authored channel that has no need to be trusted. Announcement text does not need to be trusted **or** filtered — it needs to be structurally incapable of executing.

Worker-side, the POST handler validates the full payload shape and rejects unknown `severity` values, non-`https:` links, more than one `link`, missing/duplicate `id`s, and malformed dates. **Fail loudly at post-time**, not as a broken bar on every user's screen.

---

## 5. App-Side Integration

### 5.1 `src/core/lib/announcements.ts`

Pure, testable core:

- `ANNOUNCEMENT_ENDPOINT` — `https://<worker-host>/api/announcements`
- `fetchAnnouncements(timeoutMs = 8000)` — `fetch` with `AbortController`. No `isTauri()` branch needed: the Worker sets open CORS, so browser and Tauri use one identical path (mirrors `app-update.ts:77`).
- `parseAnnouncements(raw: unknown): Announcement[]` — runtime validation, drops malformed entries rather than throwing.
- `selectActive(announcements, now, dismissedIds): Announcement | null` — the pure selection rule from §4.3. Fully unit-testable.
- Local cache in `localStorage` under `theorem-announcements-cache`, TTL **24h**, mirroring `DiscoverService.ts:44-46`.

### 5.2 `src/ui/AnnouncementBar.tsx`

Thin, presentational. Follows the `DailyHighlightBanner` dismiss idiom (`Library.tsx:1019-1021`, `:1069-1072`) — lazy `useState` initializer reading `sessionStorage`, written on dismiss. Announcements should outlive a session, so dismissal goes to `localStorage`, not `sessionStorage`.

Placement: **`App.tsx` between `<AppTitlebar/>` (`:613`) and `<main>` (`:615`)**, inside the `flex-col` content column. `<main>` is `flex-1`, so the bar pushes content down naturally and works on both breakpoints. It sits below the drag region and above all routes.

`z-index`: below `--z-nav` (110) — `--z-modal` is 200, so modals still cover it. `--z-sticky` (100) is appropriate.

**Known constraint**: the reader branch returns early at `App.tsx:594-602`, so a bar mounted in the shell branch will **not** appear while reading. That is desirable — announcements must never cover the page. Do not hoist it above the early returns: the `!storesHydrated` and `!hasCompletedOnboarding` guards (`:586-592`) deliberately avoid mounting chrome before hydration.

Colours — `--color-info` is neutral grey (`#6b6b6b` light), `--color-error` is the only genuinely distinct semantic colour. `--color-warning` and `--color-success` are **both `#2d6a6e`**, identical to accent, so a "yellow warning" is not achievable without a new token. Plan: `info` → `--color-info`, `warning` → `--color-accent`, `critical` → `--color-error`, using the established `color-mix(in srgb, var(--x)_N%, transparent)` tint convention (`Settings.tsx:1102`).

Honour `prefers-reduced-motion` — `animate-fade-in` is already gated (`index.css:282-296`).

### 5.3 Fetch timing

Non-blocking and after first paint — never block hydration on the network. Fetch once on app start; re-check when the app returns to the foreground. No polling loop.

### 5.4 Formatting & linkify (pure functions, zero dependencies)

`src/core/lib/announcements.ts` exports the pure text helpers so they are unit-testable without rendering:

- `isSafeHttpUrl(raw: string): boolean` — §4.4.
- `linkifySegments(body: string, max = 5): TextSegment[]` — splits on bare `https://…` URLs, trims trailing punctuation (`.,;:!?)]}'"`), enforces `max`, and returns alternating text/link segments. URLs failing `isSafeHttpUrl()` stay **plain text** rather than becoming a dead link.
- `renderInlineBold(text: string): InlineNode[]` — splits on `**…**` into `{ bold: boolean, value: string }` nodes.

Both return **data**, never HTML strings. `AnnouncementBar` maps them to React elements. This is the key structural decision: the render path has no string-to-HTML step anywhere, so there is nothing to escape incorrectly.

`\n` becomes `<br>`. Everything else is rendered as-is.

**No Markdown library, no DOMPurify, no new dependency** — see §4.5 for why this is a deliberate rejection rather than an oversight.

### 5.5 Announcement body rendering

```tsx
function AnnouncementBody({ body }: { body: string }) {
    return (
        <>
            {linkifySegments(body).map((seg, i) =>
                seg.kind === "text" ? (
                    <span key={i}>{renderInlineBold(seg.value)}</span>
                ) : (
                    <a key={i} href={seg.href} target="_blank" rel="noopener noreferrer"
                       onClick={(e) => { e.preventDefault(); void openExternalUrl(seg.href!); }}>
                        {seg.value}
                    </a>
                ),
            )}
        </>
    );
}
```

`target="_blank"` is retained only as a browser fallback; `onClick` intercepts and routes through `openExternalUrl()` (§3.4) so the Tauri webview uses the opener plugin.

---

## 6. Testing

Follows `AGENTS.md` — edge cases, boundaries, outliers. Never weaken an assertion to make a test pass.

**`tests/announcements.test.ts`** (pure logic, no network):
- `parseAnnouncements`: valid array; `null`/non-array; missing `id`/`title`; wrong `severity`; malformed `publishedAt`; non-`https:` link dropped; unknown extra keys preserved; **more than one `link` rejected**.
- `selectActive`: empty array → `null`; all dismissed → `null`; all expired → `null`; future `publishedAt` not active; severity precedence critical > warning > info; `publishedAt` tiebreak; single valid + malformed mix.

`linkifySegments` (the highest-risk pure function):
- no URL → single text segment.
- one URL mid-string → text, link, text.
- URL at start / end → no empty leading/trailing segments.
- trailing `.,;:!?` and a closing `)` are **excluded from the href**.
- a URL containing `)` (e.g. a Wikipedia link) keeps it.
- `max` cap enforced; the 6th URL stays plain text.
- `javascript:`, `data:`, `http:`, and credentialed `https://user:pw@host` are **never** linkified → remain plain text.
- empty string / whitespace-only → no crash, no empty segments.
- `<script>alert(1)</script>` → passed through verbatim as text (assert no HTML is produced anywhere).

`renderInlineBold`: unpaired `**` left literal; `****` empty-bold edge; nested/adjacent spans.

30-day cadence arithmetic: exactly-at-boundary (`now === hiddenUntil` → visible), 1ms before (hidden), DST/timezone-safe (epoch math only), clock moving backwards.

Non-`https:` link rejected before reaching an `href`.

**Component tests**: dismiss persists and hides; long body truncates; `critical` applies the error token; empty state renders nothing; a linked body produces exactly one `<a>` with `rel="noopener noreferrer"` and a `javascript:` href never renders as a link.

**Shell tests**: momo icon visible when eligible, hidden when `now < hiddenUntil`, click writes `hiddenUntil = now + 30d`; collapsed sidebar renders icon + `title`; the Settings row is present regardless of cadence.

**Worker** (`theorem-announcements` repo, vitest + `@cloudflare/vitest-pool-workers`): GET returns 200 + CORS headers + `ETag`; POST without token → 401; POST with invalid payload → 400 with field detail; POST valid → 200 and KV updated; `OPTIONS` preflight; expired entries filtered on read; a second `link` rejected with a field-specific error.

---

## 7. Rollout

1. [ ] Stand up `theorem-announcements`: Worker, KV namespace, `wrangler.toml`, `schema.json`, seed `announcements.json`, sync workflow, vitest. Deploy. Confirm `GET /api/announcements` from a browser.
2. [x] Theorem: `openExternalUrl()` helper (`src/core/lib/open-external-url.ts`).
3. [x] Theorem: `announcements.ts` + tests → `AnnouncementBar` → wire into `App.tsx`.
4. [x] Theorem: momo icon (`src/ui/MomoIcon.tsx`; Sidebar, AppTitlebar, Settings → About) + cadence hook (`src/core/lib/support-prompt.ts`).
5. [x] Update `docs/settings.md` (§4.3 lists Settings sections — the About tab gains a row) and `docs/ARCHITECTURE.md`.
6. [x] CHANGELOG entry.
7. [ ] Release as `1.6.0`.

**Gates before any commit**: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm foliate:check`, and — no Rust changes expected — `cargo fmt --check && cargo clippy && cargo check`. `cargo clippy --target aarch64-linux-android` only if Android-touching code changes.

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Worker/domain goes down → bar silently absent | Fail-open by design: fetch failure renders nothing. Announcements are never load-bearing. 24h local cache smooths short outages. |
| Announcements become marketing spam and users tune them out | Default cadence is one bar, dismissible, monthly at most. Ship conservatively. |
| Compromised Worker injects content | **No HTML sink** — React auto-escapes; links are real `<a>` elements. `https:`-only, no credentials. Admin POST token-gated, public repo for auditability. Injection is structurally impossible, not filtered (§4.5). |
| Malformed/hostile URL inside a body renders as a dead or misleading link | `linkifySegments` demotes anything failing `isSafeHttpUrl()` back to plain text; trailing punctuation trimmed; capped at 5 links. |
| `http://` link downgraded or MITM'd | Rejected outright — only `https:` linkifies. |
| Reused announcement `id` means users never see new text | `id` is required and validated; convention documented in the repo README; never reuse. |
| `target="_blank"` broken in Tauri webview | New shared `openExternalUrl()` using the opener plugin with a `window.open` fallback. |
| Reader shows no announcements | Intentional — see §5.2. |

---

## 9. Decisions & Open Questions

### Resolved

1. **Announcement formatting: plain text + `**bold**` + auto-linkified URLs.** No Markdown engine, no DOMPurify, no new dependency. Confirmed — links are supported via both bare-URL linkify and a dedicated `link` CTA (§4.4, §5.4).

### Still open

2. **Community/ecosystem channel** — strictly maintainer releases, or also non-repo news? Affects whether `announcements.json` stays a single flat list or gains a `channel` field.
3. **Worker hosting** — `workers.dev` subdomain, or a custom domain on the existing Cloudflare zone (`theorem.fundaments.work` / `read.fundaments.work`)?
4. **iOS App Store review** — does a donation link require specific disclosure? Worth checking before shipping to iOS.

---

## 10. Context

- Existing remote-config precedent: `src/core/lib/app-update.ts` (GitHub Releases poll + `AbortController`) — the fetch pattern to mirror.
- Existing CORS-proxy precedent: `functions/api/gutenberg.ts` (Cloudflare Pages Function, host allow-list).
- Existing dismiss-persistence idiom: `DailyHighlightBanner`, `src/features/library/Library.tsx:1008-1080`.
- Existing external-link convention: `@tauri-apps/plugin-opener` dynamic import.
- Release infra: `.github/workflows/release.yml`, `notify-landing.yml`.