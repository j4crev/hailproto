# Custom domain support checklist

Status: incremental implementation. Provider-side DNS discovery and domain
registration are implemented. Custom-domain account creation is not enabled,
and no live domain or deployment has been changed.

## Agreed product model

- [x] Use separate accounts for `j4@haili.app` and `j4@j4crev.com`: distinct
  DIDs, Sender Profiles, inboxes, permissions, recovery material, and logins.
- [x] Start domain administration from an existing native-domain account.
  Domain administration must not confer access to another account's keys or inbox.
- [x] Keep login, passkeys, and Hail service hosting on the provider origin.
- [x] Use DNS delegation without requiring a webserver on the custom domain.
- [x] Use `_hail-domain-verify.j4crev.com TXT "hail-domain-verify=<random-token>"`
  for the provider's domain-registration challenge.
- [x] Omit scheduled domain checks. Verify during authority-sensitive operations
  and normal discovery; show “Last verified” rather than continuous status.
- [x] Defer custom-domain transfer, aliases, shared inboxes, and account switching.

## Slice 1: DNS discovery

- [x] Specify `_hail-provider.<address-domain> TXT "v=hail1; provider=<hostname>"`.
- [x] Resolve the original address at the selected provider's HTTPS WebFinger
  endpoint; retain signed Address Binding and PLC verification.
- [x] Reject malformed/ambiguous records, unsafe targets, DNS failures, and
  unsupported versions without falling back to the domain's WebFinger endpoint.
- [x] Preserve domain-hosted WebFinger when DNS reports absence.
- [x] Bound DNS work, retain network protections, and avoid application caching.
- [x] Wire all reference provider AddressVerifier entry points, including its
  grant CLI. No recursive Hail delegation lookup on the selected provider.
- [x] Test real signed-binding resolution through delegated and legacy paths,
  failure behavior, cancellation, and existing discovery safety checks.
- [x] Run focused tests and server typechecking.
- [x] For normal operations, skip TXT discovery only for the resolving server's
  exact configured native domain and use HTTPS WebFinger directly. Other domains
  (including locally hosted custom domains and native-domain subdomains) still
  use DNS. Registration and explicit delegation verification never use this bypass.

Validation: 52 focused tests passed across delegation, signed address verification,
safe HTTPS transport, activation, and app discovery routes. Server typechecking
also passed. No live domain setup or deployment was performed.

Initial DNSSEC policy: unsigned DNS is accepted through the operator's configured
recursive resolver. Deployments should use a validating resolver; errors,
including SERVFAIL for bogus DNSSEC, fail closed. Hail does not itself validate
DNSSEC or claim an authenticated DNS result. HTTPS authenticates the delegated
provider, not the original domain's delegation. DNS tampering can redirect an
address to an attacker's DID but cannot inherit the original DID's permissions.

The reference verifier does not cache discovery results. Recursive resolvers
handle DNS TTLs. Any future application cache must additionally track remaining
delegation TTLs (including alias chains) and the existing HTTP/binding limits;
the current TXT API does not expose TTLs, so its results must not be cached by
the application.

Rollout: upgrade resolving providers before publishing DNS-only custom addresses.
Old resolvers cannot discover these addresses. Rollback restores legacy discovery
but makes DNS-only addresses undiscoverable; existing DID grants are unaffected.
No schema or stored-data migration is needed for this slice. The Rust CLI and
other independent address resolvers need their own compatibility work before
claiming DNS-delegation support.

## Slice 2: Domain registration and independent account creation

- [x] Add domain ownership records, canonicalization, unique claims, and status.
- [x] Issue random expiring challenges tied to the provider, administrator, and
  registration attempt; bound/rate-limit checks and prevent replay.
- [x] Verify the challenge and delegation separately; reject conflicting completed
  claims without account takeover. Pending attempts do not reserve the namespace.
- [x] Add Settings → Custom domains with record instructions, manual verification,
  challenge replacement, pending-domain removal, and last-verified status.
- [x] Document native-domain and custom-domain DNS records in provider setup guides.
- [ ] Issue single-use, expiring authorization for an exact custom address.
- [ ] Reuse onboarding with explicit domain authorization rather than removing
  native-domain restrictions globally. Create independent DID, recovery, and
  passkey state; retain provider-origin authentication.
- [ ] Host the binding before WebFinger selection, activate only after public
  verification, and make partial failure/retry behavior safe.
- [ ] Extend settings with custom-account creation and pilot with `j4@j4crev.com`.

### Registration implementation notes

Migration 0087 adds provider-local `account_custom_domains`. Registration requires
an active native-domain account signed in through its passkey session. This does
not require a provider-operator role and gives no access to another account's
messages or signing keys. These administration records are not transferred with
account snapshots; domain administration transfer remains future work.

The browser uses `GET/POST /api/v1/account/custom-domains` to list/start attempts,
`POST /api/v1/account/custom-domains/:id/verify` to check DNS, and
`POST /api/v1/account/custom-domains/:id/remove` to remove pending attempts.
Mutations require same-origin requests. Bearer credentials are not accepted by
this initial administration surface. Responses are private and never cached.

Challenges contain 256 random bits, expire after 24 hours, and are stored only
as hashes. A new challenge replaces the previous one. Checks and replacements
have one-minute retry limits, and each account may hold at most 10 registrations.
Only completed DNS proof establishes a unique claim; simultaneous valid attempts
cannot both succeed. Completed attempts are idempotent and do not recheck DNS.
A consumed verification TXT record can be removed; keep the delegation record.
No scheduler or periodic checks have been added.

Rollback first requires reverting application consumers. The rollback SQL refuses
to drop a populated table; export and explicitly handle registrations before any
schema removal. No live schema has been changed. Tests exercise populated-table
refusal, empty-table rollback/reapplication, expiry, replay, competing claims,
account isolation, migration fences, quota, and DNS failure.

Registration validation: 75 focused tests passed; the custom-domain and existing
passkey-session database suites passed against disposable PostgreSQL 18.6 with
no skipped tests. Server typechecking and client Svelte checking passed (zero
client errors or warnings). The disposable database was removed afterward.
The Settings UI has not been exercised in a live browser or deployed.

## Slice 3: Lifecycle completion

- [ ] Authorize custom-domain binding renewal under existing custody rules.
- [ ] Recheck delegation when creating accounts and renewing bindings; do not
  introduce background polling or per-message domain checks.
- [ ] Implement domain withdrawal and reassignment with cache-expiry safeguards.
  Never transfer the old DID, keys, messages, or permissions to a new domain owner.
- [ ] Preserve provider login and existing DID-authorized conversations after
  domain loss; expired discovery must not appear currently verified.
- [ ] Audit custody changes and reject unsupported custom-domain transfers
  before changing state. Domain-transfer implementation remains deferred.
- [ ] Prove cross-provider discovery, messaging, account separation, renewal,
  domain-loss behavior, and unchanged native-domain onboarding.

## Later work

- [ ] Define custom-domain provider transfer and re-verification at destination.
- [ ] Require fresh ownership proof for domain administrator changes; ownership
  transfer and removal of verified registrations are currently rejected.
- [ ] Add an account switcher with independently authenticated sessions.
- [ ] Consider composing as another account with that account's permissions.
- [ ] Register the protocol's underscored DNS names before standardization.

References: [address binding](../spec/address-binding.md),
[Sender Profiles](../spec/sender-profile.md),
[RFC 7033](https://www.rfc-editor.org/rfc/rfc7033.html), and
[RFC 8552](https://www.rfc-editor.org/rfc/rfc8552.html).
