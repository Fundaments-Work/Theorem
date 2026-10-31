# Onboarding

## First-run setup

After store hydration, `App.tsx` renders `ReadingSetup` until
`settings.hasCompletedOnboarding` is true. Existing users are not forced through
setup again. Weekly goals remain available in Settings → General → Reading Goals;
Library does not show a goal invitation.

The setup has three steps:

1. **Make room for reading** — local-first introduction, Start reading, or an
   optional Explore features guide.
2. **Choose your reading rhythm** — select one to seven reading days per week
   (four recommended) with the shared app Dropdown. Its menu layers above the
   setup overlay. Five minutes qualifies a day. Save rhythm or Skip goal.
3. **Bring your first book** — Open Library to add a book, or Browse Discover.
   Library uses the existing file picker and import flow; canceled or failed
   imports leave the normal app available.

Back returns to the previous setup step. Skip setup is available throughout.
Completed steps are persisted as the device-local `readingSetupStep`, so a
restart resumes setup. Saved goals persist independently. No notification, folder,
or sync permission is requested by setup.

Completion writes `settings.hasCompletedOnboarding` and the existing
`localStorage.theorem-onboarding-complete` marker, then routes to Library or
Discover. The overlay is gone before importing or browsing. The continue-reading cue lives inside the existing Library book card and uses
the normal reader navigation and saved-position behavior.

## Optional feature guide

`OnboardingFlow` remains accessible through Explore features on the welcome
screen. It covers Welcome, Read Anything, Highlight and Annotate, Organize Your
Library, and Sync Across Devices. Its Next/Back controls and clickable progress
indicators stay available; completing or skipping it returns to setup rather than
completing first-run setup. Desktop-only export descriptions stay platform-aware.

## One-time state and visual testing

Onboarding runs once per installation/profile. Settings has no replay or reset
control. E2E visual checks use fresh, isolated app profiles so testing never
requires clearing a reader’s library.

The settings store (`theorem-settings`, version 14) persists
`settings.hasCompletedOnboarding` and `readingSetupStep`. Tauri keeps it in the
SQLite KV row `zustand:theorem-settings`; the browser keeps it in IndexedDB
(`theorem-persist`, store `kv`). Completion also sets the legacy localStorage
marker `theorem-onboarding-complete`. These are separate from daily review state.


Reading setup and the optional feature guide share `OnboardingFrame`: an
explicit container-width token, readable content beside existing app
illustrations, and a footer that keeps actions available. Phone layouts stack
the illustration and text. The setup width must never use `max-w-lg`: the
compiled utility resolves to the spacing token, not a page-width token.
