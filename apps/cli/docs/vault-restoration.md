# Offline vault restoration — October 9, 2026

`hailp vault verify`, `vault backup` and `vault import` use the existing v1
encrypted vault. Verification explicitly decrypts/imports both keys and checks
their public/private match. Copy operations verify before writing, create a new
mode-`0600` file inside a private directory, then compare exact bytes and unlock
the saved copy. Existing output files are never overwritten. Import requires a
reviewed `--expected-did` (or `unbound`). JSON output includes public fingerprints
and paths, never encryption secrets, ciphertext or private keys.

The existing `vault:verify` and `poc:verify-vault-copy` scripts reuse these same
verification/copy primitives. Vault inputs reject unknown fields, invalid key
record shapes and invalid metadata; file reads remain bounded to 16 KiB. Wrong
secrets, damaged key ciphertext or mismatched key fingerprints fail verification.

## Second-installation proof

A new source/dependency installation was created at:

```text
/tmp/opencode/vault-restore-20261009/second-install/
  hail-user-client-ts/
  hailproto/
  did-method-plc/
```

The client used the current working source including these changes. Protocol
and PLC sibling sources were freshly extracted from their Git revisions
`4c8af6d9d3435c15859a05b684f6f6ed562c523f` and
`996e23b5ced9c15b32bcc612dd304880342ca4ab`. Dependencies were installed into
that new layout using frozen lockfiles, not copied/symlinked from the original
installation's `node_modules`:

```bash
# In the new hailproto directory:
bun install --frozen-lockfile
bun run --cwd packages/hail-codec-ts build
# In the new did-method-plc directory:
pnpm install --filter @did-plc/lib... --frozen-lockfile
pnpm --filter @did-plc/lib exec tsc --build tsconfig.build.json --force
# In the new client directory:
bun install --frozen-lockfile
bun run typecheck
```

The two disposable app accounts from the [HTTPS release proof](cli-release-rollout.md)
were backed up with `hailp vault backup`. Their vault encryption-secret files
were separately copied into private local test storage. The new installation
received only those backup vaults/secrets, not API credentials, signup state,
keystore entries or provider/database material.

Every fresh-installation import, verification and signing proof ran under:

```bash
unshare --user --map-root-user --net bun <fresh-installation-command>
```

This separate network namespace has no provider/network connectivity. Both
imports and subsequent full verification succeeded, preserved the reviewed DID
and public keys, and produced byte-identical vault copies:

| Custody | Restored DID | Signature proof |
| --- | --- | --- |
| owner-controlled | `did:plc:6zexa3fpfmfpcwlsrtp6cqu2` | Ed25519 Grant and top PLC recovery signature verified |
| managed | `did:plc:evaewtveayxkk4ltjbmuxc5z` | Owner's top PLC recovery signature verified |

Signing challenges were offline only: no Grant or PLC operation was submitted.
The managed vault's local identity remains unused; it is not the provider-held
active identity and was not claimed as such. Recovery signatures were verified
against each original owner recovery public key.

Executed scripts and public result summary are retained locally at
`/tmp/opencode/vault-restore-20261009/restore.sh`,
`second-install/hail-user-client-ts/restore-proof.ts` and `public-results.json`.
Private test vaults/secrets live beneath the mode-`0700` `backups/` and `restored/`
directories. These are temporary disposable evidence artifacts, not the user's
durable/offline backup storage.

## Regression gates

`bun run test` passed all five tests, including backup/import rejection and exact
copy checks, CLI/legacy backup commands, identity-only Grant regressions and the
existing onboarding/transfer-signature proof. The package test script now selects
Bun explicitly so its `Bun.spawn` CLI checks run with the intended runtime.
`bun run typecheck`, `bun run build` and `git diff --check` passed.

## Proof boundaries

This proves restoration on a **second installation on the same Linux machine**,
independent of provider-held data and network access. It does not prove physical
second-device recovery, off-host backup durability, directory recovery publication
or account login after credentials expire. The v1 vault's DID metadata is not
part of its encrypted key authenticated data; the import command checks the
owner's independently reviewed DID. Compare both public-key fingerprints too;
offline unlock does not establish current PLC signing authority after rotation.

Device-keystore protection is [defined separately](device-keystore.md), not
implemented. Do not store the v1 shared backup encryption secret in a routine
signing device keystore: that would make recovery decryptable there as well.
