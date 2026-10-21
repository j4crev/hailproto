# Address Binding renewal — migration-35 slice

This implements milestone 4's first item and is deployed to both private-POC
providers at migration 35; see [release evidence](milestone4-release.md).
The [Grant revision/consent slice](grant-revisions.md) and
[historical-key decision](grant-key-reconciliation.md) are also complete locally;
historical-key reconciliation execution remains disabled.

## Commands and authority

```bash
hailp binding show --credentials /secure/account.credential.json
# Choose a future deadline that extends the selected binding, within 90 days of issuance.
hailp binding renew --credentials /secure/writer.credential.json \
  --expires-at "$renewal_deadline" --vault /secure/account.vault.json \
  --output /secure/renewed-binding.cose
# Explicit managed account: omit --vault; retain the same deadline/output on retry.
hailp binding renew --credentials /secure/managed-writer.credential.json \
  --expires-at "$renewal_deadline" --output /secure/managed-binding.cose
```

`binding show` requires `account:read` and returns signed issue/expiry times,
digest/ID and selected active/expired status. `renewalDue` becomes true within
seven days of expiry, including after expiry; people/agents can poll this JSON
for reminders. There is no unattended renewal or background signing.

Renewal needs `account:read` for CLI review and the new `account:write` scope.
Migration 35 expands the credential scope constraint without changing existing
rows: a migration-34 credential does not gain write authority on upgrade or
rotation. Obtain it deliberately through owner login or an already authorized
issuer; a read-only or Grant-only credential cannot renew an address.

Owner-controlled renewal uses identity-only vault unlocking, never PLC recovery
decryption. Managed renewal explicitly uses the provider's identity key and
rejects a supplied owner vault. The issuer checks fresh verified PLC identity,
messaging/service authority, the expected identity public key, active/public
account state and current credential permission/expiry at both write stages.
Fenced/exported/retired accounts cannot publish renewal. Custom-domain authority
management is not implemented: this slice renews the account's provider-domain
address, not a new address or another domain's mapping.

## Signed artifacts and publication

The Address Binding remains the existing closed `hail.address-binding` COSE
representation, with its 90-day maximum unchanged. The deadline must be explicit,
future and later than the selected binding's expiry; issuance must advance its
signed timestamp. A renewal can repair an expired binding, but never resurrects
an expired credential/signer or silently switches signing keys.

Before submission, `<output>.request.json` stores provider/account, expected
identity key, exact unsigned payload and predecessor digest. Owner signatures
are saved in the private output **before** submission. Managed Ed25519 signing
reuses the identical payload, producing the same deterministic signed bytes on
retry. Responses are signature/payload/digest checked and saved privately.

The provider commits immutable hosting first. A second account-locked transaction
compares the selected predecessor digest, withdraws old selection and selects
exactly one new representation. It then runs the existing complete address
verification flow and requires the exact signed bytes/digest, DID, identity and
service to match. Failed verification returns an error; retain artifacts and
retry the same request to repair/confirm publication, not mint another binding.
A successful result describes retained/current selection, not an acceptance
promise for messages or Grants.

Old signed bytes and final URLs are preserved until their signed expiry. Exact
retries return the same binding ID/bytes; a superseded published retry is reported
`superseded` and never reselects itself. Conflicting predecessors cannot overwrite
new selection; their staged immutable representation can remain hosted but is
not selected. Changed deadline/options, keys or local artifacts fail closed.
The selected expired binding never falls back to a superseded unexpired one.
Discovery chooses the latest selection before applying expiry/retirement checks,
including legacy overlapping selections; a stale older holder cannot reappear.

No DID/PLC operation or Grant revision is created. Expiration, renewal and address
selection do not transfer/revoke DID-bound relationships. Original completed
signup retries still find their original immutable binding by digest rather than
mistaking a renewal for changed onboarding artifacts.

## API and proof

`GET /api/v1/account/binding` returns the authenticated account's selected binding
and expiry/reminder metadata. `POST` requires `account:write` and exact uncoded
JSON with `previous`, `signingKey` and either owner `cose` or managed `payload`.
Requests/representations are bounded; unknown fields and invalid lifetime/schema
fail validation. No protocol change or new binding-history table is introduced.

Both custody integration cases prove signed renewal, failed verification and
exact repair, retained historical bytes/URLs, one selected binding, superseded
retry behavior, original signup retries, conflicting predecessors, 90-day bounds,
wrong signer, revoked/expired/read-only authority and source fences. An expired
selected binding returns discovery 404 instead of an older binding; explicit
renewal restores discovery, while the account's Grant revisions/statuses remain
unchanged. Owner renewal also passes with unreadable recovery ciphertext.

Recorded gates: **16 focused PostgreSQL integrations**, **one private-provider
transfer integration** for discovery/retirement compatibility, **108 provider tests**
without DB environment (61 DB tests skipped), **5 client tests**, both typechecks/
builds and diff checks passed. Migration 34→35 on a populated disposable database
preserved existing credential bytes/scopes/expiry, repeated cleanly and allowed
the old migration runner; `account:write` required new deliberate issuance.
Local migration check: `/tmp/opencode/binding-upgrade-20261009/check.ts`.
Those gates were local. The subsequent [milestone-4 release](milestone4-release.md)
records restored deployment-copy rehearsal and real HTTPS publication proof.
