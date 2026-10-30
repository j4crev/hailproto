# Custom domain support checklist

Status: incremental implementation. Provider-side DNS discovery, domain
registration, and authorized custom-domain browser signup are implemented.
Custom-domain binding renewal and domain-loss safeguards are implemented.
The existing custom-domain flow has been deployed and the user confirmed sending
and replying from their custom address. Standalone signup is implemented locally;
its deployment and live pilot remain pending. Domain withdrawal/reassignment is deferred.

## Agreed product model

- [x] Use separate accounts for `j4@haili.app` and `j4@j4crev.com`: distinct
  DIDs, Sender Profiles, inboxes, permissions, recovery material, and logins.
- [x] Allow domain administration from an existing active account, or bootstrap
  directly into a custom-domain account while public registration is enabled.
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
- [x] Issue single-use, expiring authorization for an exact custom address
  (backend API and atomic signup integration).
- [x] Reuse onboarding with explicit domain authorization rather than removing
  native-domain restrictions globally. Create independent DID, recovery, and
  passkey state; retain provider-origin authentication.
- [x] Host the binding before WebFinger selection, activate only after public
  verification, and make partial failure/retry behavior safe.
- [x] Extend settings with custom-account creation.
- [ ] Verify the browser flow and pilot with `j4@j4crev.com`. Withdrawal,
  reassignment, and transfers remain deferred.

### Registration implementation notes

Migration 0087 adds provider-local `account_custom_domains`. Registration requires
an active public account signed in through its passkey session (native or custom domain). This does
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

### Exact-address authorization implementation notes

Migration 0088 stores provider-local address authorizations. A passkey-authenticated
account can request `POST /api/v1/account/custom-domains/:id/authorize-address`
with `{"address":"alice@example.com"}` under its verified domain. The response
contains `authorizationId`, the canonical `address`, a one-time `token`, and
`expiresAt`. This endpoint does not create an account. The authorization also
satisfies admission for this exact custom address, including on invite-only
providers: an existing active account administering a verified domain may create
separate accounts under it. It cannot admit a native address or another custom
address. General browser/CLI signup still follows the provider’s invite/public
policy. Settings passes the token to `/signup` in a temporary URL
fragment, never a query string or HTTP request URL. Signup immediately removes
the fragment and retains the token only in memory and encrypted setup/recovery
files. Do not copy that fragment into logs or share it. Existing unfinished setup
must be continued before creating another account.

Tokens contain 256 random bits, expire after 15 minutes for first use, and are
stored only as hashes. They authorize only the named address at this provider,
under the issuing administrator's current serving generation. Replacements have
a one-minute cooldown and invalidate previous tokens. At most 20 unconsumed,
unexpired authorizations may exist per administrator. Consumed authorizations
cannot be replaced. Issuance checks current DNS delegation explicitly, without
using the native-domain discovery bypass.

`CustomDomains.consumeAddressAuthorization` is an internal transaction method,
not a public redemption endpoint. Signup calls it inside the
same transaction as admission and account reservation, with a server-computed
request digest covering the exact recovery/identity/setup intent. Never accept
an arbitrary client-supplied digest as evidence of that intent. First consumption
rechecks DNS, domain ownership state, address availability, and administrator
serving/fence state. Its bounded DNS query occurs inside the transaction to keep
consumption and reservation atomic; issuance does its network work outside locks.

A successful consumption binds the token to one signup UUID, setup-token hash,
and request digest. Identical retries can return the original authorization after
its issuance expiry; the caller must still enforce the signup ceremony's own
expiry and completed-state rules. Changed intent is rejected. A failed transaction
rolls back consumption so the original setup can safely retry. Migration/custody
fences and generation checks remain effective, including for administrators who
have advanced beyond generation one.

Native onboarding remains unchanged. Custom signup needs no separate invitation
or emailed code; security email is still verified during signup. It requires the exact address
authorization; supplying it for a native address is rejected. Admission, capability
consumption, account/key reservation, and ceremony linkage commit together. A
failure rolls them all back; exact retries retain the same account and keys.
The server stores only an authorization digest in signup intent. Lower-level
onboarding requires matching consumed authority, ceremony, and recovery/identity
keys within that transaction; ordinary direct custom-address preparation fails.

The browser validates the exact custom address and provider before signing and
retains authorization in the encrypted recovery package. Older native setup files
remain supported. Accounts have independent DIDs, keys, passkeys, inboxes and
permissions. Signing in to the new account replaces the current browser session;
account switching remains deferred. Provider-reserved local names (such as
`admin`) remain unavailable on custom domains under the existing database policy.

Custom-domain source accounts cannot begin portable or managed provider-transfer
fencing. No transfer implementation or background DNS checks have been added.
Binding publication and activation reuse the existing monitored signup pipeline;
production activation still verifies public discovery before selecting the address.

Apply rollback 0088 before 0087, after reverting application consumers; rollback
refuses to discard issued or consumed authorizations without an explicit
export/removal decision. Custom recovery packages require this client version
for setup resumption; their independently verified recovery vault remains usable
offline through the existing tools.

Authorization validation: 60 focused tests and server typechecking passed.
Authorization and domain-registration database suites passed against disposable
PostgreSQL 18.6 with no skipped tests, including rollback and concurrent claims.
The disposable database was removed. No live provider or domain was changed.

Signup integration validation: 61 focused server tests and 9 client tests passed,
as did server typechecking and client Svelte checking (zero errors or warnings).
Six database suites passed against disposable PostgreSQL 18.6: custom-domain
registration, exact-address authorization, monitored signup, public onboarding,
portable migration fencing, and managed network orchestration. These cover native
and custom invite/public signup, rollback after account/key creation, exact retries,
independent recovery and passkey login, encrypted package compatibility, and
rejection of custom-domain transfers before fencing. No database tests were
skipped. The disposable database was removed. UI browser verification and a live
DNS/provider pilot remain outstanding.

## Slice 3: Lifecycle completion

- [x] Authorize custom-domain binding renewal under existing custody rules.
- [x] Recheck delegation when creating accounts and renewing bindings; do not
  introduce background polling or per-message domain checks.
- [ ] Implement domain withdrawal and reassignment with cache-expiry safeguards.
  Never transfer the old DID, keys, messages, or permissions to a new domain owner.
- [x] Preserve provider login and existing DID authority after domain loss;
  expired discovery must not appear currently verified.
- [ ] Exercise existing cross-provider conversations during the live domain-loss pilot.
- [x] Reject unsupported custom-domain provider transfers before fencing the account.
- [ ] Audit remaining custody changes. Domain-transfer implementation remains deferred.
- [ ] Prove cross-provider discovery, messaging, account separation, renewal,
  domain-loss behavior, and unchanged native-domain onboarding.

### Renewal and domain-loss behavior

`POST /api/v1/account/binding` reuses existing scoped credential and custody
checks. Native addresses skip DNS delegation. A custom address additionally needs
its original consumed admission linked to this account and a still-registered
local domain. The issuance token and signup ceremony may have expired or retired;
they establish provenance, not current login authority. The domain administrator
does not sign for or receive access to the custom account.

Renewal checks current delegation with the bounded DNS resolver before signing
and again before selecting the hosted artifact. Missing or changed delegation
returns a conflict; DNS failures return a retryable service error. Neither permits
selection of new authority. The existing public signed-binding verifier checks
the result through delegated WebFinger after publication. If that final check
fails after publication, retain and retry the same artifact; the selected binding
may already have committed. DNS can change between any two requests, so this is
operation-time verification, not a continuous guarantee.

Domain loss does not delete accounts, revoke passkeys/credentials, alter keys, or
rewrite DID grants. Existing selected bindings retain their original expiry;
there is no scheduled withdrawal. An expired selected binding is omitted from
WebFinger, without fallback to older bindings. Binding status describes expiry
and selection, not continuous DNS verification. Restoring delegation allows an
authorized account to renew after expiry without creating a replacement identity.

Domain withdrawal and reassignment remain intentionally unimplemented. Before
adding them, define how to retire local address claims and wait out discovery
caches while retaining old DID-authorized conversations and preventing any key,
inbox, or permission inheritance by the next domain owner.

Renewal validation: the monitored signup suite exercises real custom accounts,
scoped renewal, signed delegated WebFinger discovery, DNS absence/redirection/
failure, staged-but-unselected retry, post-publication verification failure,
expired issuance authority, removed local domain authority, expiry and recovery,
and continued passkey login. The self-service suite covers unchanged native
managed/owner-controlled renewal with a DNS resolver that fails if called.
Both database suites and server typechecking passed against disposable PostgreSQL
with no skipped tests. The disposable database was removed; no live provider,
domain records, or deployment was changed.

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


## Standalone custom-domain signup

A publisher can start at `/signup` → **Address domain** → **Use a custom domain…**, without creating a
provider-native account. This entry point requires public registration and the
existing browser signup configuration. Existing authenticated domain administration
continues to work under invite-only registration.

- [x] Provide anonymous, public-mode-only domain setup for an exact address.
- [x] Issue independent ownership TXT challenge and setup bearer; store hashes only.
- [x] Check ownership and provider routing before handing off to account signup.
- [x] Recheck public mode and both DNS records at account reservation.
- [x] Atomically consume authority, admit signup, reserve the account, and assign
  the domain to that new account. Verification alone never reserves a domain.
- [x] Reuse recovery-package verification, security email, monitor, and passkeys.
- [x] Let the new active account manage its domain and authorize additional separate
  accounts through Settings → Custom domains.
- [x] Preserve native signup, existing invite-only custom authorization, and exact
  admitted retries after registration switches back to invite-only.
- [x] Bound anonymous requests, pending setups, and DNS check frequency.
- [x] Add database and browser regression coverage and guarded rollback.

`POST /api/v1/domain-signup` accepts only `{ "address": "publisher@example.com" }`.
It returns a `haild_` bearer, DNS record names/values, and a 24-hour setup expiry.
`GET /api/v1/domain-signup` resumes status using that bearer;
`POST /api/v1/domain-signup/verify` accepts `{}` with the same bearer. Mutations
require the provider Origin; responses are no-store. Verification lasts 15 minutes
and consumption checks DNS again. Keep both TXT records until account reservation;
afterward the ownership challenge can be removed, but routing must remain.

The single signup wizard has six steps for provider-native addresses. Choosing
**Use a custom domain…** beside the username reveals the domain field and adds
**Verify domain** as step two of seven. Username and security email carry forward;
Back navigation preserves them. `/signup/domain` redirects to `/signup` for older
bookmarks. Existing authenticated-domain links still use the fragment handoff and
skip the DNS step because the domain has already been verified.

The browser retains temporary DNS setup and the entered security email in same-tab
session storage, scoped to the provider, until account reservation succeeds.
The existing encrypted pending setup and recovery package then retain the exact
address authority. No recovery keys go into session storage.

Migration 0089 adds `standalone_domain_signups`. Expired unconsumed rows are pruned
when a new attempt starts; consumed records are retained as admission evidence.
At reservation, ordinary domain and consumed address-authorization records are
created, so existing binding renewal and domain management use their usual
provenance. A unique verified-domain constraint prevents competing setups from
claiming the same domain; any failure rolls back account creation and admission.
There are no periodic DNS checks or new domain transfer semantics.

Rollback of 0089 refuses to discard any saved setup or admission evidence. An
empty table can be rolled back and migrated again. Earlier binaries can continue
using ordinary domain/account records but cannot resume unconsumed standalone
setups; keep the new server version while those setups are in progress.

Standalone validation: server and client typechecks pass (zero Svelte warnings),
23 focused unit tests pass, and six affected database suites pass against disposable
PostgreSQL 18.6 with no skipped tests: domain registration, address authorization,
registration policy, monitored signup, public onboarding, and standalone domains.
Coverage includes standalone activation, passkey login, domain administration,
renewal, public-mode closure, DNS failure, expiry, atomic rollback, competing claims,
and migration reversal. The fresh-built Chromium regression passes, including
standalone DNS display, same-tab reload, six/seven-step switching, preserved
address/email on Back navigation, DNS expiry before recovery-key generation, and
existing invite-only custom-address handoffs.
