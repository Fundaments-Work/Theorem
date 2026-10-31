# Onboarding

## First-run setup

After store hydration, `App.tsx` renders `ReadingSetup` until
`settings.hasCompletedOnboarding` is true. Existing users are not forced through
setup again. A dismissible-by-preference Library invitation offers a weekly goal.

The setup has three steps:

1. **Make room for reading** — local-first introduction, Start reading, or an
   optional Explore features guide.
2. **Choose your reading rhythm** — select one to seven reading days per week
   (four recommended). Five minutes qualifies a day. Save rhythm or Skip goal.
3. **Bring your first book** — Open Library to add a book, or Browse Discover.
   Library uses the existing file picker and import flow; canceled or failed
   imports leave the normal app available.

Back returns to the previous setup step. Skip setup is available throughout.
Completed steps are persisted as the device-local `readingSetupStep`, so a
restart resumes setup. Saved goals persist independently. No notification, folder,
or sync permission is requested by setup.

Completion writes `settings.hasCompletedOnboarding` and the existing
`localStorage.theorem-onboarding-complete` marker, then routes to Library or
Discover. The overlay is gone before importing or browsing. The primary Library
resume action uses existing reader navigation and saved-position behavior.

## Optional feature guide

`OnboardingFlow` remains accessible through Explore features on the welcome
screen. It covers Welcome, Read Anything, Highlight and Annotate, Organize Your
Library, and Sync Across Devices. Its Next/Back controls and clickable progress
indicators stay available; completing or skipping it returns to setup rather than
completing first-run setup. Desktop-only export descriptions stay platform-aware.
