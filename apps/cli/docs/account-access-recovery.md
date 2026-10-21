# Account access after credential expiry — design decision

The milestone 3 design is now implemented as a **private-PLC API-plus-CLI
slice**, requiring provider migration 34 and explicit `POC_ACCOUNT_ACCESS=true`.
It is deployed and verified on both POC providers; see [release evidence](lifecycle-release.md).
Expired/revoked bearer credentials still
cannot authenticate; independent owner-key proof issues a new credential.

## Authority and custody

Account access recovery issues a **new provider-local API credential** after
owner proof. It does not publish a PLC operation, rotate identity/recovery keys,
change custody, renew an Address Binding, transfer an account or restore a revoked
credential. People and agents follow the same authority checks.

- Owner-controlled ordinary login: prove possession of the current, verified
  `#hail-identity` Ed25519 key using identity-only vault unlocking.
- Explicit owner recovery, including managed accounts: prove possession of the
  current owner-controlled top PLC P-256 recovery key. Require a deliberate
  recovery operation/full-vault unlock; never fall back to it after an identity
  signer is unavailable. This signs an account-access challenge, **not** a PLC
  operation or top-authority replacement.
- The provider-held managed identity key is not owner authentication: the
  provider can already sign with it. Managed login must require independent
  owner proof. A future enrolled account-login passkey could handle routine
  access without recovery-key use; it needs its own enrollment/revocation design
  and cannot be inferred from an API token or substituted for raw Hail signatures.
- Custodial POC/unknown profiles with no independently verifiable owner authority
  have no self-service recovery under this design. An operator-mediated access
  procedure is separate and must not be labeled owner-controlled recovery.

## Challenge and exact-retry flow

1. The owner explicitly selects a canonical HTTPS provider, DID, signer role and
   nonempty exact scope set. The client saves a new random credential secret and
   request state in private files **before** requesting a challenge. No secret
   is printed or included in command arguments.
2. A provider-local challenge binds version, provider origin, account/DID,
   purpose `new-api-credential`, signer role/public-key fingerprint, requested
   scopes, new credential token hash, a random 256-bit nonce, issue time and an
   expiry at most five minutes later. Preserve these exact bytes/state for retry.
3. The client validates every bound value against its locally reviewed request
   and vault, including the provider origin and purpose. It signs deterministic
   CBOR with domain separation `hailp.account-access.v1\0`. This account-API
   challenge is neither a federation object nor an arbitrary message-signing
   interface. Untrusted inbox content cannot supply the challenge/signing request.
4. The provider validates the stored, unexpired challenge, exact signature and
   token hash, then independently checks fresh verified PLC authority and current
   service ownership. Identity mode requires the active identity key; recovery
   mode requires the owner's top recovery key and reviewed custody evidence.
   Historical keys, a lower-priority provider key, cached onboarding evidence
   alone or a caller-selected public key are insufficient. Unavailable/conflicting
   authority verification fails closed rather than guessing.
5. Under the existing account-row lock, reject inactive or migration-fenced/
   exported/retired accounts, consume the nonce and issue the new hashed token
   atomically. Bind the nonce's terminal result to the exact credential ID/scopes/
   expiry. A concurrent/replayed changed request cannot issue another credential.
6. An exact retry within the challenge window may return the same still-valid
   result, never refresh its expiry or revive it after revocation/expiry. The
   client already retained the secret and completes the private credential file
   atomically. Challenge expiry without a recoverable result requires an explicit
   new login attempt; no silent new token/nonce after ambiguity.

Use a persisted bounded challenge store so process restart does not lose replay
protection. Rate-limit challenge preparation and completion independently of
authenticated API traffic; use bounded inputs/responses and uniform failures
before revealing account existence/custody. HTTPS verification, redirect refusal,
no-store responses and provider-origin credential isolation remain mandatory.

## Scope and revocation semantics

Bearer issuance remains a subset of the caller's scopes and requires
`credentials:write`. An owner-key login is independent owner authority, not a
scope-escalation endpoint for a read-only/agent bearer token. Require explicit
review of the new scope set; a bearer alone can neither enroll owner proof nor
gain authority. Do not default a recovery request to full access.

Credential revocation remains terminal for that token. Owner key compromise must
be addressed through the separate reviewed identity/recovery authority lifecycle;
revoking one API token does not revoke an owner's keys or all other credentials.
Restoring a managed vault restores owner recovery, not the provider's active
managed identity. No user recovery private key is ever uploaded to the provider.

## Implemented surface

```bash
hailp account login --provider <https-origin> --did <did> \
  --signer identity --vault <private-vault> --state <new-private-state> \
  --credentials <new-output> --scope account:read
# Managed accounts, or an explicitly reviewed owner recovery operation:
hailp account login --provider <https-origin> --did <did> \
  --signer owner-recovery --vault <private-vault> --state <new-private-state> \
  --credentials <new-output> --scope account:read --scope credentials:write
```

There is no default signer or default scope set. Both commands read the vault
encryption secret through hidden terminal input or protected stdin; neither reads
an old API credential. Managed identity proof is rejected even when produced by
the provider's actual active identity key. Retain the original vault, state and
output paths/options across ambiguity; do not change signer/scopes on a retry.
Challenge/signature state is saved before completion, and exact retries within
five minutes return the same still-valid credential ID/expiry. Expired attempts
require deliberately new state/output paths and a new secret; there is no fallback.

Endpoints are `POST /api/v1/account-access/prepare` and `/complete`, separate
from signup, bearer credential management and PLC operations. Preparation accepts
`did`, `signer`, `publicKey`, `scopes`, `tokenHash`; it returns an opaque challenge
shape for known and unknown accounts without deciding or returning custody.
Completion accepts `challengeId`, `token`, `signature` and returns the credential
only after owner proof and fresh current authority checks. Private signup/monitor
evidence alone never substitutes for verified current PLC state.

Unavailable or changed identity/top recovery/service authority fails closed;
reconciliation with reviewed custody evidence is required before using changed
keys. Recovery does not silently reconcile an unsupported custody transition.

POC limits are persistent, independent 20 preparations/minute and 60 completions/
minute per provider, at most 4096 retained challenges, five-minute expiry and one
day of expired-challenge tombstones. Old issued token hashes remain terminal in
the credential table. Protected completion responses reuse the provider's bounded
response schedule. These are controlled POC limits, not public-registry abuse
protection or independent monitoring guarantees.

Both custody paths, challenge tampering/expiry/replay, concurrent completion,
fresh-process/handler retries, terminal credential rejection, current-key/service
changes, unavailable PLC verification and all source-fence states have local
regression proof. Migration 33→34 preserved all 37 pre-existing tables in a
populated disposable database and retained old/new credential-reader compatibility.
See [local verification](account-access-verification.md) and the subsequent
[lifecycle release](lifecycle-release.md), which records restored deployment-copy
rehearsal, individual VPS rollout and real endpoint recovery. Private-POC proof
does not establish public PLC or independent production recovery guarantees.
