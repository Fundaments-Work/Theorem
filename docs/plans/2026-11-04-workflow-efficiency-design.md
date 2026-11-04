# Workflow efficiency

Use main as the canonical automatic CI branch while retaining release-branch
PR and manual checks. Select relevant gates against the last validated main
commit, falling back to all gates when validation history is unavailable.
This prevents cancelled pushes from losing unchecked changes.

Share artifacts inside each workflow run rather than introducing a cross-run
build cache or skipping validation based only on a commit identifier. Web CI
produces one verified frontend; the native check job restores it for all-feature linting.
Keep default Rust tests and all-feature linting, since they validate different
configurations. Native E2E executables are built and checked locally.

Release and dry-run workflows share frontend/icon preparation and restoration
composite actions. Native jobs keep their own target-specific installers,
signing and dependencies. Resolve the requested tag once, build its immutable
revision everywhere, serialize same-tag attempts, and retain the draft until
all platforms succeed. Keep dry runs manual and version-update PRs active.

Keep security scans and real local E2E assertions. Remove the CodeQL language without
tracked source files; preserve the Homebrew Ruby formula analysis. Share
notification implementation and avoid product landing deployments on docs-only
pushes. Release publication must explicitly notify because GITHUB_TOKEN events
do not start the separate release-event workflow.

Verify selection through executable shell tests, release behavior in a temporary
Git repository, workflow syntax with actionlint, normal project gates, and the
real local E2E suite against a fixed executable copy. Installer signing and publication
remain outside this verification; they require a maintainer-approved release.
The known hosted WebKit screenshot timeouts remain a separate unresolved issue.

## E2E execution policy

Native E2E runs locally. Remove hosted execution, schedules and manual modes,
plus native E2E binary builds and artifact transfer. Preserve all local specs,
the optional smoke selector and fast Node helper tests in CI. The final release
commit must pass full local E2E before tagging. CI keeps unit tests, lint,
typechecks, Android compilation checks, security scans and release builds.
