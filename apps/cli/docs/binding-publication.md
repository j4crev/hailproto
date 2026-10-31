# Address Binding publication

Address Bindings do not expire. Ordinary account creation, migration and custody
changes publish the required binding as part of those workflows. There is no
periodic renewal command, reminder or scheduled signing requirement.

Use explicit publication only to replace an artifact after a change or repair a
publication. It preserves DID-bound relationships and retained binding evidence.
Identity-key reconciliation remains [separately constrained](grant-key-reconciliation.md).

## Commands and authority

```bash
hailp binding show --credentials /secure/account.credential.json
# Owner-controlled account: sign with the local identity vault.
hailp binding publish --credentials /secure/writer.credential.json \
  --vault /secure/account.vault.json --output /secure/replacement-binding.cose
# Managed account: omit --vault; retain the same output on retry.
hailp binding publish --credentials /secure/managed-writer.credential.json \
  --output /secure/managed-binding.cose
```

`binding show` requires `account:read` and returns the signed issuance time,
address, DID, digest/ID and selection status. It does not return an expiration or
`renewalDue` reminder. Selection status describes local publication; it is not a
continuous guarantee about DNS or remote verification.

Publication needs `account:read` for CLI review and `account:write` to submit.
Migration 35 expanded the credential scope constraint without changing existing
rows: a migration-34 credential does not gain write authority on upgrade or
rotation. Obtain write authority deliberately through owner login or an already
authorized issuer; a read-only or Grant-only credential cannot publish a binding.

Owner-controlled publication uses identity-only vault unlocking, never PLC
recovery-key decryption. Managed publication uses the provider's identity key and
rejects a supplied owner vault. The issuer checks fresh verified PLC identity,
messaging/service authority, the expected identity public key, active/public
account state and current credential permission/expiry at both write stages.
Fenced/exported/retired accounts cannot publish. Custom-domain publication also
requires the account's retained domain admission and current DNS delegation to
this provider. This command does not claim a new address or domain.

## Signed artifacts and publication

The closed `hail.address-binding` version 2 payload contains `type`, `version`,
`address`, `did`, `issued_at` and `key_id`. It has no `expires_at`. Issuance must
advance the selected binding's timestamp, and must not be more than 300 seconds
in the future. The passage of time alone does not invalidate the binding.
Credential expiration and current signing authority are still enforced.

Before submission, `<output>.request.json` stores provider/account, expected
identity key, exact unsigned payload and predecessor digest. Owner signatures
are saved in the private output **before** submission. Managed Ed25519 signing
reuses the identical payload, producing the same deterministic signed bytes on
retry. Responses are signature/payload/digest checked and saved privately.

The provider commits hosting first. A second account-locked transaction compares
the selected predecessor digest, withdraws old selection and selects exactly one
new representation. It then performs complete address verification: current
DNS/WebFinger publication must select the exact binding, the current PLC identity
key must verify its signature, and the signed address/DID must match the lookup.
`alsoKnownAs` membership is not part of Hail address verification.

Failed final verification returns an error; retain artifacts and retry the same
request to repair or confirm publication rather than minting another binding.
Exact retries return the same binding ID/bytes; a superseded published retry is
reported `superseded` and never reselects itself. Conflicting predecessors cannot
overwrite a newer selection. Changed options, keys or local artifacts fail closed.
A successful result is not an acceptance promise for messages or Grants.

No DID/PLC operation or Grant revision is created by this command. Address
selection does not transfer or revoke DID-bound relationships. Original completed
signup retries still find their original binding by digest rather than mistaking
a replacement for changed onboarding artifacts.

## Withdrawal and provider cooperation

Account closure and successful migration retirement at the source provider must
withdraw both the public WebFinger mapping and public serving of the account's
signed binding artifacts. Private audit evidence may remain; withdrawal does not
erase DID history or change the DID's permissions. There is no standalone
`binding revoke` command: withdrawal belongs to the provider's account lifecycle.

Resolvers still bound discovery caches and check current domain publication and
PLC signing authority. Withdrawal does not erase downloaded copies or immediately
invalidate cached results. The design trusts provider cooperation: a dishonest
former provider could republish an old binding if its signature still verifies
under the DID's current identity key.

## API and alpha transition

`GET /api/v1/account/binding` returns the authenticated account's selected binding.
`POST` requires `account:write` and exact uncoded JSON with `previous`, `signingKey`
and either owner `cose` or managed `payload`. Requests and representations are
bounded; unknown fields and invalid schema fail validation.

Version 1 expiring bindings are not accepted by the version 2 codec/verifier.
Existing accounts need a one-time replacement of their version 1 artifacts as
part of the alpha rollout. Removing `expires_at` from stored JSON or changing a
version number cannot convert a signed artifact: the new payload must be signed
and published during a coordinated provider upgrade. Routine `binding show` and
`binding publish` expect a selected v2 binding; they are not a v1 migration tool.
Prepare the one-time replacement requests separately before rollout. Old signed
bytes remain audit evidence. This one-time transition is not recurring renewal.
