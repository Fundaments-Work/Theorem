# Theorem — Design Language

**This file is a pointer.** The design system now lives in one place:

**<https://github.com/Fundaments-Work/design-system>**

| What | Where |
|---|---|
| Token values | [`tokens.md`](https://github.com/Fundaments-Work/design-system/blob/main/tokens.md) |
| Marks, lockup, colour, type, rules, collaboration | [`guidelines.md`](https://github.com/Fundaments-Work/design-system/blob/main/guidelines.md) |
| Official mark and badge files | [`brand/`](https://github.com/Fundaments-Work/design-system/tree/main/brand) |
| The same system, browsable | [`canvas.html`](https://github.com/Fundaments-Work/design-system/blob/main/canvas.html) |

The shipped implementation is authoritative over any prose:

- `src/core/styles/design-tokens.css` — token declarations
- `src/core/lib/design-tokens.ts` — runtime theming and accent maths

Where the code and a document disagree, the code wins and the document
is the bug. That rule is what retired the three copies of this file.

---

## What Theorem keeps

Theorem is a product in the system, not its author. It inherits the
shared dark base unchanged and chooses two things:

- **Accent** — Stone `#c8b89a`, reading progress only
- **Mark** — the turnstile, on the 24-unit grid, radius 0

Its light theme (`#faf9f7` / `#1c1c1c` / `#d4d3ce`) survives as a
theme override inside the system, not as a rival brand.

---

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>