# Project management

### GitHub Project Board

The [Theorem Roadmap](https://github.com/orgs/fundaments-work/projects/2) board tracks all active work.

**Custom fields**:
- `Status` — Todo / In Progress / Done
- `Priority` — Critical / High / Medium / Low
- `Area` — Reader / Sync / Mobile / Library / RSS / TTS / Vocabulary / Settings / UI/UX / Infrastructure / Documentation
- `Effort` — Story points (number)

**Workflow**: Issues enter the board at Todo → move to In Progress when work starts → Done when merged to `main`.

### Issue Labels

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

### Issue Templates

GitHub issue forms are configured at `.github/ISSUE_TEMPLATE/`:
- `bug_report.yml` — structured form with version, platform, logs fields
- `feature_request.yml` — structured form with scope dropdown
- `config.yml` — directs questions to Discussions

### PR Lifecycle

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full PR process. TL;DR:
1. Work on the active release branch (`1.6.1`); keep only it and `main` after cleanup. Create a task branch only when the maintainer requests one.
2. Atomic conventional commits (`feat:`, `fix:`, `chore:`, etc.)
3. Run quality gates before opening
4. CI runs relevant typechecks, unit tests, builds and Rust checks on main pushes, PRs targeting either maintained branch and manual runs. Native E2E runs locally before release.
5. Maintainer reviews within a few days
6. Integrate approved changes into `1.6.1`. Merge to `main` only with the maintainer’s approval; dependency PRs may be resolved on the release branch with a link to their integration commit. Remove their branches after integration.

### Release Workflow

See [release.md](release.md). CI (`release.yml`) auto-builds and publishes on tag push.


Dependabot version-update PRs target the active `1.6.1` branch for npm, Cargo
and GitHub Actions. Security alerts track the default branch independently;
they clear when the verified fixes reach `main`. Do not dismiss an alert merely
because its fix is waiting on a release branch.
