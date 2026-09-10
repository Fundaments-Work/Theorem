## Theorem UI Kit — conventions

**No wrapper needed.** Nothing in this kit reads a theme/context provider —
every component works standalone. Reading-mode color overrides come from a
class or attribute on an ancestor, not a provider: put `.theme-light`,
`.theme-sepia`, or `.theme-dark` on a wrapper to pick the reader palette, or
`[data-reading-mode]` on a wrapper to switch surface colors to the reader's
own background/foreground instead of the app chrome palette. Neither is
required — components render correctly with no ancestor classes at all
(the default light palette applies).

**Every corner is square, everywhere, no exceptions.** Every `--radius-*`
token (`--radius-sm` through `--radius-full`) is `0`. Never round a corner
on anything built with this kit — not a card, not a button, not an avatar,
not a spinner (the real `Spinner` component renders a square ring, not a
circle, because of this). This is a deliberate brand rule, not an oversight.

**Styling idiom: Tailwind utility classes, arbitrary-value tokens.**
Components style with plain Tailwind classes (`flex`, `border`, `px-4`)
plus arbitrary-value utilities that reference CSS custom properties —
`bg-[var(--color-surface)]`, `text-[color:var(--color-text-primary)]`,
`border-[var(--color-border)]`. Use that same pattern for new layout code:
reach for a `--color-*`/`--spacing-*`/`--font-size-*` token from
`tokens/design-tokens.css` inside an arbitrary-value class, never a raw
hex/px value. A handful of components also share hand-written semantic
classes instead of raw utilities — reuse them verbatim, don't reinvent:
`.ui-btn` / `.ui-btn-primary` / `.ui-btn-ghost` / `.ui-btn-danger` (buttons
— see the composed examples in every Modal-family preview), `.ui-icon-btn`,
`.ui-chip-btn`, `.ui-tab-btn`, `.ui-input`, `.ui-card`, `.ui-section`,
`.ui-page-title`, `.dict-definition` (rendered dictionary/definition HTML).

**Typography**: `--font-sans` (Helvetica Neue → Arial → sans-serif fallback
chain), `--font-serif` (EB Garamond, actually shipped as a webfont — →
Georgia → serif), `--font-mono` (SF Mono → Consolas → monospace). Weight
contrast comes from size/color, not boldness — avoid `font-bold` except for
small uppercase labels that already use letter-spacing.

**Where the truth lives**: `tokens/design-tokens.css` (every `--color-*`,
`--spacing-*`, `--radius-*`, `--font-*`, `--layout-*`, `--z-*` token) and
`guidelines/design.md` (the full brand spec — logo mark construction, color,
type, spacing, motion). Read both before styling anything non-trivial.

**Example — a confirm dialog, composed from real exports:**
```tsx
import { Modal, ModalHeader, ModalBody, ModalFooter } from 'theorem';

<Modal isOpen onClose={onClose} size="sm">
  <ModalHeader title="Delete highlight?" onClose={onClose} />
  <ModalBody>
    <p className="text-sm text-[color:var(--color-text-secondary)]">
      This can't be undone.
    </p>
  </ModalBody>
  <ModalFooter>
    <button className="ui-btn-ghost" onClick={onClose}>Cancel</button>
    <button className="ui-btn-danger" onClick={onConfirm}>Delete</button>
  </ModalFooter>
</Modal>
```
