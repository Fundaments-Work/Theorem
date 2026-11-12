# Project management

## GitHub Project Board

The [Theorem Roadmap](https://github.com/orgs/fundaments-work/projects/2) board tracks all active work.

**Custom fields**:
- `Status` — Todo / In Progress / Done
- `Priority` — Critical / High / Medium / Low
- `Area` — Reader / Sync / Mobile / Library / RSS / TTS / Vocabulary / Settings / UI/UX / Infrastructure / Documentation
- `Effort` — Story points (number)

**Workflow**: Issues enter the board at Todo → move to In Progress when work starts → Done when merged to `main`.

## Issue Labels

| Label | Purpose |
|-------|---------|
| `bug` | Confirmed defect |
| `enhancement` | Feature request |
| `sync` | P2P sync related |
| `reader` | EPUB/PDF rendering |
| `mobile` | Android-specific |
| `rss` | RSS feeds |
| `tts` | Text-to-speech |
| `library` | Library management |
| `vocabulary` | Dictionary/words |
| `settings` | App settings |
| `ui/ux` | UI/UX improvements |
| `infrastructure` | CI, build, plugins |
| `documentation` | Docs, README |
| `android` | Android platform |
| `performance` | Performance |
| `good first issue` | New contributor friendly |

New issues should be labeled by `Area` + type (`bug`/`enhancement`).

## Issue Templates

GitHub issue forms are configured at `.github/ISSUE_TEMPLATE/`:
- `bug_report.yml` — structured form with version, platform, logs fields
- `feature_request.yml` — structured form with scope dropdown
- `config.yml` — directs questions to Discussions

## PR Lifecycle

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full PR process. TL;DR:
1. Contributors use a fork or branch based on `main` and open a PR against `main`. Agents follow the workspace and branch instructions in `AGENTS.md`. The `1.6.1` branch was retired; keep its release tag.
2. Atomic conventional commits (`feat:`, `fix:`, `chore:`, etc.)
3. Run quality gates before opening
4. CI runs relevant typechecks, unit tests, builds and Rust checks on main pushes, PRs targeting `main` and manual runs. Native E2E runs locally before release.
5. Maintainer reviews within a few days
6. Integrate approved changes into the maintained branch. Merging a release branch to `main` requires the maintainer’s approval; dependency PRs may be resolved with a link to their integration commit. Remove their branches after integration.

## Release Workflow

See [release.md](release.md). A tag push triggers the release workflow; publishing and changing releases require maintainer approval.

## Repository protection rollout

GitHub's public branch metadata reported `main` as unprotected during the
November 2026 audit. An administrator must verify effective rules, including
organization rulesets, before changing settings; public metadata alone does not
prove which rules apply. No protection has been enabled by this documentation.

For `main`, propose a ruleset requiring pull requests, resolved conversations,
and an explicit maintainer-controlled bypass; prevent deletion and force pushes.
Require a review only when another eligible reviewer is available or a deliberate
maintainer bypass is configured: authors cannot approve their own PRs. Protect
release tags from update and deletion, with a narrowly scoped maintainer bypass.
Decide who may create release tags before enabling the rule.

Do not require a conditional CI job directly as the sole gate. The proposed
`CI result` aggregate fails on failed or cancelled selected jobs and accepts only
intentional skips; verify it on a real PR before requiring its exact name.
Until then, have maintainers inspect the selected checks manually. Configure
approval for external contributors' Actions runs and review workflow changes before
allowing them to execute. DCO sign-off (`git commit -s`) is not a cryptographic
commit signature; do not enforce the latter as a substitute for the former.

Sources and plan limitations are in [the repository governance audit](research/repository-governance.md).

Dependabot version-update PRs target `main` for npm, Cargo
and GitHub Actions. Security alerts track the default branch independently;
they clear when the verified fixes reach `main`. Do not dismiss an alert merely
because its fix is waiting on a release branch.
