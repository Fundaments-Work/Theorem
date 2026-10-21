
## Description

<!-- Briefly describe what this PR does and why it's needed -->

## Related issue

<!-- Link to the issue this PR addresses, if any -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor
- [ ] Documentation
- [ ] CI / Build
- [ ] Release

## Quality checklist

- [ ] Typecheck passes (`pnpm typecheck`)
- [ ] Tests pass (`pnpm test`)
- [ ] Rust fmt + clippy clean (`cd src-tauri && cargo fmt && cargo clippy`)
- [ ] Rust compiles (`cd src-tauri && cargo check`)
- [ ] No `console.log` in production code
- [ ] No secrets, tokens, or credentials introduced
- [ ] Every commit is signed off (`git commit -s`, see [DCO](https://developercertificate.org))
