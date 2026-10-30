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
1. Branch from `main` using `feature/` or `fix/` prefix
2. Atomic conventional commits (`feat:`, `fix:`, `chore:`, etc.)
3. Run quality gates before opening
4. CI runs typecheck, tests, build, Rust checks automatically
5. Maintainer reviews within a few days
6. Approved PRs are merged to `main`

### Release Workflow

See [release.md](release.md). CI (`release.yml`) auto-builds and publishes on tag push.

