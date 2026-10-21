# Active Grant updates and consent refresh — milestone-4 slice

This slice is deployed to both private-POC providers with migration-35
[binding renewal](binding-renewal.md); Grant revisions themselves need no new
schema migration. [Release evidence](milestone4-release.md) records real HTTPS
checks for both custody profiles and cross-provider acknowledgements.

## Explicit selection and signed revisions

```bash
hailp grant create updates@sender.example.com \
  --category receipts --category security --output /secure/grant.cose \
  --vault /secure/account.vault.json --expires-at "$initial_deadline"
hailp grant update "$grant_id" --category receipts --category security \
  --expires-at "$renewed_deadline" --output /secure/revision.cose \
  --vault /secure/account.vault.json
# Refresh current consent without changing permissions/expiry:
hailp grant update "$grant_id" --category receipts --category security \
  --refresh-consent --output /secure/refreshed.cose --vault /secure/account.vault.json
# A unilateral restriction preserves old expiry and consent:
hailp grant update "$grant_id" --category receipts \
  --output /secure/restricted.cose --vault /secure/account.vault.json
```

Managed accounts omit `--vault`; a supplied owner vault is rejected. Owner
signing unlocks only identity, never PLC recovery. Both profiles require an
active authenticated `grants:write` credential; CLI review also reads account
and Grant state. Categorized updates select one or more unique category IDs,
sorted bytewise, with no wildcard. `--uncategorized` is mutually exclusive.
Use the existing signed `grant revoke` when removing the last selected choice;
there is no implicit switch to uncategorized delivery.

Updates retain grant ID, both DIDs and initial `issued_at`, increment revision
once, bind the exact predecessor digest, advance `updated_at`, and append a
complete signed snapshot. Omitted expiry flags keep the reviewed predecessor's
expiry; `--expires-at` and `--no-expiry` are deliberate choices. An expired grant
is not terminal, but it cannot be silently reactivated by category edits: renewed
authorization requires an explicit future deadline/no-expiry and fresh consent.
Revocation remains terminal for that grant ID.

## Consent policy

- Adding/replacing categories, switching categorized/uncategorized delivery,
  extending expiry or removing an expiry requires current verified Address
  Binding and Sender Profile evidence. All selected choices must be offered.
  The provider rechecks exact evidence hashes at submission, not just proposal.
- `--refresh-consent` explicitly re-verifies both objects even when permissions
  and their hashes are unchanged. A higher same-semantics revision cannot bypass
  evidence verification by retaining old hashes.
- Pure category removal, shorter expiry and signed revocation retain the prior
  consent context unchanged and never fetch sender evidence. An unavailable
  sender therefore cannot prevent unilateral restrictions. Apply restriction
  first and refresh separately rather than combining a restriction with refresh.
- `--sender <verified-address>` can select current consent evidence for the same
  immutable grantee DID. Address reassignment to another DID fails; it never
  transfers the Grant or its permissions/history to the new address holder.
- An offered profile change after proposal makes the signed request stale. The
  client does not silently fetch new evidence, mint another revision or widen
  permission on retry; use deliberately new artifacts after reviewing conflict.

## Exact retry and retained publication

`<output>.request.json` saves provider/account, expected identity public key,
signed predecessor bytes, requested scope/expiry/refresh/address choices and the
exact proposal. Owner COSE bytes are saved before submission. Managed signing
signs only that saved snapshot; deterministic Ed25519/COSE yields identical bytes
on retry, and the response is signature/payload/digest checked before saving.

Repeat the same command/options/output after ambiguity. Already appended exact
bytes are found by their historical revision, even after a newer revision exists;
they return retained acknowledgement, never overwrite current state. A same-
revision fork, stale predecessor or gap is a conflict. Prior signed representations
are never re-signed or overwritten. Semantic comparisons use deterministic CBOR,
so null-prototype decoded maps do not become accidental permission differences.

The repository atomically advances the lineage, retains fresh evidence when
needed and enqueues one publication per revision. Restrictions refer to the
already retained matching consent; they do not create imaginary fresh evidence.
The existing ordered outbox prevents a later revision from publishing ahead of
an unacknowledged predecessor. `publication: durable` promises retained local
state/responsibility, not sender acknowledgement or future message acceptance.

API additions: `POST /api/v1/account/grants/{id}/proposals` and the explicit
managed `/update` endpoint. Owner submission reuses signed COSE import. Initial
creation also supports an additive `scope` field while preserving legacy single-
category requests. Federation remains the existing signed snapshot/If-Match
protocol, with no new selector or unsigned blocking mode.

## Verification

Real HTTPS CLI/PostgreSQL tests exercise both custody profiles: multi-category
creation, offline restrictions/shorter expiry, rejection of silent expired
permission expansion, explicit renewal with fresh evidence, response loss after
commit, exact and superseded retries, consent refresh, stale/missing choices,
address reassignment, a same-revision fork, read-only authority, current signer
epoch mismatch and terminal revocation. Immutable initial bytes and all six
revision/outbox entries are retained. Existing receiver/repository/service gates
cover signature, predecessor and restriction-consent enforcement.

The [historical-key decision](grant-key-reconciliation.md) is defined separately;
this implementation refuses new signer epochs rather than guessing historical
authority. Historical-key execution is not enabled by this release.

Recorded gates: **19 focused PostgreSQL/HTTPS integrations**, **108 provider
tests** without DB environment (**63 integrations skipped** in that run),
**5 client tests**, both repositories' typechecks/builds and diff checks passed.
The focused gate covers new revisions plus existing repository, binding/signup,
account access, rotation and messaging paths; it does not claim all 63 database
integrations ran. Multi-process test harness budgets do not alter production
expiry, signature or processing limits.
