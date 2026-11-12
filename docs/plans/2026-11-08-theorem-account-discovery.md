# Theorem account: discovery

Status: early planning; no implementation, provider, launch date or release
assignment is approved. This plan complements the 1.6.2 reliability plan.

## Direction

One optional Theorem account connects Theorem's own hosted services. Account
signup, sign-in, recovery, profile, security and deletion live on the Theorem
website at `theorem.fundaments.work`. Purchases and other account functions can
also be managed there. The app initiates sign-in in the system browser and keeps
an app session after authorization; account management opens the website.

Local reading, existing files, the free Fundaments eLibrary and peer-to-peer sync remain usable without an account or subscription; public user guides and README reflect this boundary today and will introduce optional account wording only if a hosted service launches. School-operated catalogs retain their own separate identities. The store is separate from the free eLibrary. A future Cloud Vault is a historical proposal, not an approved feature or a dependency of this account.

## Sign-in experience to explore

OpenCode's provider authentication offers a browser URL, a device code or an
authorization-code prompt depending on the provider, then saves credentials
and refreshes them when supported. Use the smooth browser handoff as inspiration,
not as an assumed implementation. See [OpenCode provider documentation](https://github.com/anomalyco/opencode/blob/dev/services/www/src/docs/content/cli/providers.mdx).

1. The reader chooses to connect their Theorem account in the app.
2. The system browser opens the Theorem website. The reader signs in or signs up
   and authorizes the app; explain which service and device are being connected.
3. The app resumes and shows the connected state. Provide a clear fallback if
   the browser cannot return to the app; assess a short-lived device-code flow.
4. The website manages account details and connected sessions. The app offers
   sign-out and opens the relevant website page for account management.

Browser cookies and native app sessions are distinct: do not assume that the
app can access the browser's cookies. Evaluate a standard native-app OAuth/OIDC
authorization-code flow with PKCE, secure platform storage, session renewal and
revocation. Validate the final design and dependencies before implementation;
do not invent an authentication protocol.

## Discovery and design work

- [ ] Agree what the first account enables: bookstore, profile, or another
  service; define the smallest useful first release.
- [ ] Map the website and app journeys for signup, sign-in, cancellation,
  expiration, session refresh, sign-out, lost access, recovery and deletion.
- [ ] Specify session and device management, revocation, account deletion,
  and what remains available offline or after a session ends.
- [ ] Evaluate website/backend ownership, identity provider or self-hosted
  options, platform-secure storage and browser callback support on each platform.
- [ ] Define data minimization, privacy notices and threat model; ensure reading
  activity is not sent to catalogs, and protect against callback interception,
  replay, cross-account access and account enumeration.
- [ ] Review existing OPDS authentication support and design catalog-specific
  sign-in so school accounts remain independent of Theorem accounts.
- [ ] For a bookstore, define DRM-free ownership and download entitlements,
  refund and account-deletion behavior, publisher agreements, and payment and
  platform-policy prerequisites before selecting a payment integration.
- [ ] Test first-time and returning users, inaccessible browser returns,
  multiple devices, offline access and revoked sessions on desktop and Android.

## Source plans and open decisions

The Fundaments handbook's Theorem eLibrary technical and OPDS plans describe
the free catalog, independent school sign-in and a later store. The catalog
server plan proposes web registration and an OPDS authentication document.
The studio decision dated 2026-11-01 keeps local apps free and allows separately
offered services. Reconcile older references to Cloud Vault with its explicit
historical-proposal status before setting scope. Payment and provider choices,
account capabilities and exact implementation remain undecided.
