
# Contributing to Theorem

Thanks for your interest in contributing! Theorem is a Tauri-first desktop reader built with React 19, TypeScript, and Rust.

## Getting Started

### Prerequisites

- **Node.js 22+** and **pnpm 10+**
- **Rust** (stable, via [rustup](https://rustup.rs))
- **Tauri system dependencies**: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev` (see [Tauri docs](https://tauri.app/start/prerequisites/))

### Setup

```bash
git clone --recurse-submodules https://github.com/fundaments-work/theorem.git
cd theorem
pnpm install
```

### Running

```bash
pnpm dev          # Web mode (port 1420)
pnpm dev:tauri    # Desktop mode (Tauri window)
```

## Project Architecture

See [AGENTS.md](./AGENTS.md) for the full repository map, import conventions, placement rules, and anti-patterns.

Key architectural decisions:
- **Navigation is store-driven** — `useUIStore.currentRoute`, not React Router
- **No path aliases** (`@/`, `@theorem/*`) — use relative imports
- **`src/features/reader/foliate-js/**` is vendored upstream** — do not edit. Our wrapper lives at `src/features/reader/foliate-js-runtime/`
- **Stores** are one file per slice in `src/core/store/`, barrel-imported from `"../../core/store"`
- **Types** live in `src/core/types/index.ts`
- **Platform detection** uses `isTauri()`, `isMobile()` from `src/core/lib/env.ts` — no hardcoded platform checks

## Making Changes

### Branching

- `main` is the stable release branch. All PRs target `main`.
- Feature branches use `feature/` prefix (e.g., `feature/dark-mode-toggle`)
- Bug fix branches use `fix/` prefix (e.g., `fix/reader-crash-on-mobile`)
- Release branches use `release/` prefix (e.g., `release/1.4.3`)

### Code Style

- **TypeScript**: strict mode, no `any` unless absolutely necessary
- **React**: functional components with hooks, no class components
- **Imports**: named imports, no default exports for components
- **CSS**: Tailwind utility classes + `cn()` from `src/core/lib/utils.ts`
- **Animations**: `prefers-reduced-motion` guard on all animations

### Commit Convention

Use [conventional commits](https://www.conventionalcommits.org/):

| Prefix | When to use |
|--------|-------------|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `chore:` | Maintenance, dependencies, cleanup |
| `docs:` | Documentation |
| `style:` | Formatting, design tokens, CSS |
| `refactor:` | Code restructuring without behavioral change |
| `perf:` | Performance improvement |
| `test:` | Adding or updating tests |
| `ci:` | CI configuration |

### Before Submitting

Run all applicable quality gates:

```bash
pnpm typecheck                           # TypeScript — zero errors
pnpm test                                # Vitest — all pass
cd src-tauri && cargo fmt && cargo check # Rust — fmt no diff, check compiles
cd src-tauri && cargo clippy             # Rust lint — zero warnings
```

### Pull Request Lifecycle

1. Fork the repository and create your branch from `main`
2. Make your changes, keeping commits atomic and well-described
3. Run quality gates (above) and fix any issues
4. Open a PR against `main` — the PR template will pre-fill with a checklist
5. CI runs automatically: typecheck, tests, build, and Rust checks
6. A maintainer reviews your PR. Expect feedback within a few days.
7. Address review feedback with additional commits (no force-push unless requested)
8. Once approved, a maintainer merges your PR

### What to Contribute

We welcome contributions in these areas:

- **Bug fixes** — check the [issues](https://github.com/fundaments-work/theorem/issues) for `bug` and `good first issue` labels
- **Reader improvements** — rendering, pagination, annotation performance
- **Sync reliability** — edge cases in P2P sync, conflict resolution
- **Mobile polish** — Android-specific UX, gesture handling, performance
- **Dictionary support** — additional languages and dictionary formats
- **Tests** — coverage is always welcome
- **Docs** — README, screenshots, onboarding

## Release Process

Releases are automated via GitHub Actions. A maintainer:

1. Bumps version in `package.json`, `Cargo.toml`, `tauri.conf.json`, and `theorem-sync-core/Cargo.toml`
2. Updates `CHANGELOG.md`
3. Registers icons from `public/favicon.svg`
4. Tags `v<version>` and pushes — CI builds all targets and publishes

The full procedure is documented in [AGENTS.md](./AGENTS.md) under the Release section.

## TTS / Immersion Reading Development

The text-to-speech system has two narration paths:

- **Platform TTS (always available)** — no external models or cloud APIs:
  - **Android**: Custom `tauri-plugin-android-tts-audio` plugin using Android's built-in `TextToSpeech` engine
  - **Linux**: `spd-say` via speech-dispatcher (`tts_linux.rs`)
  - **macOS**: `say` shell command
  - **Windows**: PowerShell `System.Speech` API
- **Neural Voice (optional, desktop)** — Supertonic 3 fp32 ONNX models downloaded on demand and SHA-256-verified (`tts_model.rs`, `supertonic.rs`), played natively in Rust (`audio_player.rs`). On Android, neural narration comes from the installable Theorem Neural Voice companion TTS engine.
- **Frontend** (`src/features/reader/audio/ImmersionPlayer.ts`) — orchestration and voice selection.
- **UI** — the reader navbar's immersion row (`src/features/reader/components/progress/ReaderNavbar.tsx`); there is no separate `ImmersionBar` component.

Platform voices available depend on the user's system TTS configuration.

## Testing

```bash
pnpm test          # Run all unit tests (Vitest + jsdom)
pnpm test:watch    # Watch mode
pnpm test:coverage # With coverage report
```

Tests live in `tests/**/*.test.ts` with setup in `tests/setup.ts`. We use Vitest with jsdom for DOM-based tests. New features should include tests.

## Getting Help

- Open a [GitHub Discussion](https://github.com/fundaments-work/theorem/discussions) for questions and ideas
- Open a [GitHub Issue](https://github.com/fundaments-work/theorem/issues) for bugs and feature requests
- Security vulnerabilities: report via [GitHub Security Advisories](https://github.com/fundaments-work/theorem/security/advisories/new)

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By participating, you agree to uphold its standards.
