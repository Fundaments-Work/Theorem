# Workflow efficiency

Use main as the canonical automatic CI branch while retaining release-branch
PR and manual checks. Select relevant gates against the last validated main
commit, falling back to all gates when validation history is unavailable.
This prevents cancelled pushes from losing unchecked changes.

Share artifacts inside each workflow run rather than introducing a cross-run
build cache or skipping validation based only on a commit identifier. Web CI
produces one verified frontend; the native check job reuses its Cargo dependencies
to produce a fixed executable copy for the separate non-blocking E2E runner.
Keep default Rust tests and all-feature linting, since they validate different
configurations. Strip only transferred executable copies.

Release and dry-run workflows share frontend/icon preparation and restoration
composite actions. Native jobs keep their own target-specific installers,
signing and dependencies. Resolve the requested tag once, build its immutable
revision everywhere, serialize same-tag attempts, and retain the draft until
all platforms succeed. Keep dry runs manual and version-update PRs active.

Keep security scans and real E2E assertions. Remove the CodeQL language without
tracked source files; preserve the Homebrew Ruby formula analysis. Share
notification implementation and avoid product landing deployments on docs-only
pushes. Release publication must explicitly notify because GITHUB_TOKEN events
do not start the separate release-event workflow.

Verify selection through executable shell tests, release behavior in a temporary
Git repository, workflow syntax with actionlint, normal project gates, and the
real E2E suite against the stripped artifact. Installer signing and publication
remain outside this verification; they require a maintainer-approved release.
The known hosted WebKit screenshot timeouts remain a separate unresolved issue.

## E2E execution policy

Keep the existing specs unchanged and select launch, import/search and reader
position as the routine smoke suite. Relevant main pushes run smoke; PRs keep
fast validation without an additional native app build. Nightly and explicitly
requested manual runs execute every spec, including the screenshot regressions.
Local E2E defaults to full and remains required before a release. Scheduled runs
build the frontend and native executable but omit the daytime unit/lint and
Android checks. Full runs share a cancellation group per branch, separate from
ordinary pushes, so pushes cannot stop nightly coverage. Test selection fails
when a smoke file is missing or filters match nothing, and can be previewed
before starting any app processes.
