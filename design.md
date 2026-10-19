# Theorem — Design Language

**Theorem has no design language of its own.** It uses the Fundaments.work design system unchanged.

| What | Where |
|---|---|
| Token values | [`tokens.md`](https://github.com/Fundaments-Work/design-system/blob/main/tokens.md) |
| Marks, lockup, colour, type, rules, collaboration | [`guidelines.md`](https://github.com/Fundaments-Work/design-system/blob/main/guidelines.md) |
| Official mark and badge files | [`brand/`](https://github.com/Fundaments-Work/design-system/tree/main/brand) |
| The same system, browsable | [`canvas.html`](https://github.com/Fundaments-Work/design-system/blob/main/canvas.html) |

The shipped implementation is authoritative over any prose:

- `src/core/styles/design-tokens.css` — token declarations
- `src/core/lib/design-tokens.ts` — runtime theming and accent maths

Where the code and a document disagree, the code wins and the document is the bug.

## What is Theorem-specific

Nothing in the interface. Two things are content, not chrome:

- **Reader serif** (EB Garamond) for book text inside the reading view
- **Highlight colours** — six fixed meanings, defined in the system's tokens

Theorem's own mark is the turnstile, on the 24-unit grid, radius 0.
