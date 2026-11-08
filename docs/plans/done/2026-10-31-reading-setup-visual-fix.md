# Reading setup visual correction

The real app screenshot exposed a collapsed setup card: `max-w-lg` compiled
as `max-width: var(--spacing-lg)` (1.8rem), producing an 82px desktop panel and
50px phone panel after padding. Text and controls clipped into a thin strip.
The optional guide used a different boxed layout with dense copy.

Use the shipped typography, dark/light surface tokens, and single accent.
`OnboardingFrame` provides an explicit `--container-width-lg` limit, a brand
header, one progress indicator, a readable content/illustration area, and footer
actions that remain visible. Desktop uses two columns; phone layouts stack a
compact illustration and text. Existing SVG illustrations show reading,
highlighting, formats, and the library. The rhythm step visualizes the selected
number of days rather than inventing a calendar schedule.

Onboarding remains one-time. Fresh isolated test profiles are the way to test
it again; no replay or reset entry is added to Settings. Existing completion
flags and normal library routing remain authoritative.

Review screenshots of all three reading steps and all five optional guide
steps at desktop and 390px phone width. Assert usable rendered width, no page
overflow/clipped controls, and 44px touch targets. Verify completion survives
restart. Sidebar and Library controls share a 16px Lucide glyph class and
bare buttons and accent-only active/hover feedback. The toolbar aligns 40px
desktop / 44px touch controls with Add Books, grouped with an 8px gap.
