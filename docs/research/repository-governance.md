# Repository governance audit

Audit date: 2026-11-06. This is a proposed local plan, not evidence that GitHub
settings have been applied. Public GitHub branch metadata reported `main` as
unprotected; it cannot establish the full effective organization ruleset or
administrator bypass configuration.

- GitHub [rulesets and available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) support pull request, branch, and tag restrictions. An administrator should verify plan availability and inherited rules before applying them.
- A PR author [cannot approve their own PR](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews). A one-review requirement therefore needs another eligible reviewer or an explicit, accountable bypass for a solo maintainer.
- [Required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks) have different behavior for skipped jobs and workflows. The existing CI selects jobs by changed paths; the proposed aggregate distinguishes expected skips from failures and cancellations, and must be observed on a real PR before it is required.
- [Branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) can restrict pushes and require checks; use distinct check names and verify which GitHub App supplies them.
- GitHub can [require approval for outside contributors' Actions runs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository). Set the policy deliberately, including repeat contributors.
- DCO sign-off and [cryptographic commit verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification) are separate. This repository currently asks contributors for DCO sign-off; a signature requirement is a separate policy decision.
- The [Tauri action](https://github.com/tauri-apps/tauri-action#usage) requires the requested draft status to match an existing release and supports targeting an explicit release ID. A tag alone is not a sufficient identity for a safe recovery workflow.

Before enforcing any rules: agree on bypass actors, observe the proposed CI
aggregate on a real PR, and verify that approved contributors,
Dependabot, and maintainers retain the intended paths to contribute. Apply settings
only with administrator access and maintainer approval, then test an ordinary PR
and an unauthorized push without exposing private information.
