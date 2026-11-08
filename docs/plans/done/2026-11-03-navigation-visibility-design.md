# Optional Discover and Feeds navigation (#173)

Add independent Show Discover and Show Feeds controls to Settings → General.
Both default to on. Apply the same filter to the desktop rail and phone bar;
keep the canonical destination order and let the phone bar's existing flex
layout share the space among three, four or five items.

Store these preferences alongside, rather than inside, AppSettings in the
persisted settings store. Navigation layout belongs to the device; changing it
must not change synced settings or their modification timestamp. Bump local
persistence to version 15 and migrate older stores to both visible. Reset
settings restores both controls. Older app versions continue reading the
unchanged AppSettings format.

Hiding a destination changes navigation visibility only: routes, catalogs,
subscriptions and reading data remain available. Keep keyboard shortcut numbers
stable, including shortcuts to hidden destinations, so an established shortcut
never starts opening a different page. Changing visibility while a hidden route
is open does not interrupt that page.

Alternatives: syncing these flags would couple phone and desktop layouts;
renumbering shortcuts would match the visible order but change learned keys.
Neither is necessary for the requested controls.

Verify all four toggle combinations on both surfaces, immediate hide/restore,
stable shortcuts, migration defaults, persistence, reset, and interaction with
the actual Settings controls. Run typecheck, design checks, the full Vitest
suite and production build. Report real-app E2E separately.
