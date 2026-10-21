# Post-expiry account access — local verification, October 9, 2026

The [account-access recovery design](account-access-recovery.md) is implemented
locally in provider/client code. Provider migration **34** adds a provider-local
challenge table. Runtime access endpoints are opt-in with
`POC_ACCOUNT_ACCESS=true` and the existing pinned private-PLC registry guard.
At the end of this local verification, the POC remained on migration 33.
The subsequent [lifecycle release](lifecycle-release.md) records restored
deployment-copy rehearsal and both providers' rollout/recovery proof at 34.

## Observable acceptance

Real HTTPS CLI/PostgreSQL integration fixtures prove:

- An expired owner-controlled account credential cannot authenticate, but the
  owner can obtain a new explicitly scoped credential with the active Ed25519
  identity key. A deliberately unreadable recovery ciphertext does not prevent
  identity login, proving that routine login does not decrypt recovery.
- A managed owner can recover with the independently held top PLC P-256 key.
  The provider's actual managed Ed25519 key cannot authenticate as the owner.
- Old expired/revoked tokens remain terminal. Revoking the new credential makes
  completion retries fail rather than revive it. Read-only issuance cannot
  acquire credential-management authority from its bearer token.
- Preparation/completion response loss is recovered from the same private
  state. Fresh CLI processes and rebuilt provider handlers retain the same
  challenge/signature/token and return the same credential ID and expiry.
- Concurrent identical completion issues exactly one credential. Changed token,
  signature payload/scopes or preparation request is rejected.
- Expired challenges and retained expired token-hash requests fail closed.
  All source fence states (fenced/exported/retired) prohibit account recovery.
- Current identity, top recovery and provider service changes, lower-priority
  provider keys, and unavailable verified PLC resolution cannot authorize login.
  Tests use the real PLC resolver with genuine signed operation histories.
- The client rejects changed provider, scopes or purpose before saving a
  signature; retries cannot silently change their selected scopes or signer.
- No PLC operation is submitted, custody/top owner authority remains unchanged,
  no recovery key is stored in provider key rows, and secrets are absent from CLI
  stdout/stderr. Completion responses use verified HTTPS with a test CA, not
  disabled TLS verification. Unknown-account preparation has the same opaque
  shape and invalid completion receives the same generic no-store failure.

The login receipt is account API data, not federation evidence or a PLC recovery
operation. Fresh verification must agree with reviewed custody/provider-key
evidence; unsupported authority transitions require reconciliation, not guesses.

## Migration and mixed-version proof

A clean archive of provider `19a931349cd13f5171f9c303a87b0cc55c532de7` built a
populated migration-33 disposable database. The new runner applied migration 34
and repeated it. Sorted row-count/SHA-256 snapshots for **all 37 pre-existing
public tables** matched before/after, excluding only the migration ledger.

The old migration runner remained usable without contracting the schema. Old and
new credential readers authenticated the existing credential; the old reader
also authenticated a newly issued credential. No existing table/column or
credential/custody row is altered by migration 34. An image rollback can disable
new access routes while leaving the additive table and credentials intact; it
does not undo already issued credentials or revive revoked ones. Retain complete
database backups and the previous image for deployment recovery.

The runnable local check is retained at
`/tmp/opencode/account-access-migration-20261009/verify-upgrade.ts`, with the
archived old source beside it. The local disposable databases were removed after
verification. This proves local upgrade/reader compatibility, **not restored live
deployment-copy rehearsal** or off-host recovery.

## Gates and release work

Focused provider gate:

```bash
DATABASE_URL=<private-disposable-database-url> bun --bun vitest run \
  test/account-access.integration.test.ts \
  test/credential-rotation.integration.test.ts \
  test/account-api.integration.test.ts test/self-service.integration.test.ts
```

This gate covers the new recovery slice and existing inventory, narrower issuance,
rotation, signup, Grant and messaging paths. Provider/client typecheck/build and
client tests are the nearest additional gates; all runtime integrations use Bun.

Recorded results: **16 focused PostgreSQL/HTTPS integrations**, **108 provider
tests** without database environment (**61 integrations skipped** in that run),
and **5 client tests** passed. Both repositories' typechecks/builds and
`git diff --check` passed. The focused run supplies the changed paths' database
proof, not proof of all 61 integrations. Multi-process/padded-response test cases
use a 30-second harness budget; production challenge/processing deadlines are
unchanged.

The subsequent [release record](lifecycle-release.md) proves migration-34
rehearsal on restored deployment copies, retained fresh backups/images, individual
provider rollout, explicit access enablement and disposable expired-credential
recovery through both real HTTPS origins. Private PLC and same-VPS proof do not
establish production/public registry or independent monitoring guarantees.
