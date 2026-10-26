# `hailproto.app` / `hailproto.dev` rehearsal providers

## October 26, 2026 upgrade

Both providers run application release
`d622ab30ae9bdbf4c12f7f94de491d39971aaeb8` and schema **71**, matching Haili's
application release. Previously both used the October 22 image and schema 56.
They remain disposable rehearsal providers, not independently operated production
providers merely because their public-PLC verification profile is strict.

- Host: `2.25.253.153`; source checkout: `/opt/hailproto-app-source`.
- Runtime image: `hail-server-ts:providers-d622ab3`, image ID
  `sha256:0ddedc49236dfd435c0c189c3d6001d20f809bf9918def9824e0398b6887479a`.
  Its `org.hailproto.release` label pins the full release commit.
- Both backends now enable passkeys and the shared local/remote connection model,
  with a separate thin GUI per HTTPS origin on the existing edge network.
- Public transfers use canonical `https://plc.directory`, `strict-public-v1`, and
  the existing independent monitor `https://plcmonitor.us`, pinned to public key
  `did:key:z6Mknh84ZKz6BNm2mh4LFGKc1JkW2WN9ZdfCVRbi58s1k4Zr` verified through
  the monitor's guarded status command. No signing key or enrollment token was copied.
  Private-POC gates and public custody transitions remain disabled. Existing public
  CLI onboarding remains enabled; automatic browser signup was not enabled.

### Backup and preservation proof

Encrypted backup on the provider host:
`/var/backups/hail-poc/pre-unified-connections-20261026T005834Z/providers.tar.gpg`.
SHA-256: `a8bcf502a05593b3024c176e474470ca62dccfd33f422a4747a28b823d10a2df`.

The archive includes both custom-format PostgreSQL dumps, exact runtime environment
records and deployment files. It is encrypted to the existing operator recovery
recipient; only that public recipient was supplied to the host. Temporary plaintext
was removed. A checksum-verified copy is retained off-host as
`ops/hailproto-providers-20261026T005834Z.tar.gpg`.

Both databases were authenticated/decrypted and restored in isolated off-host
PostgreSQL **14.24** containers. Candidate migrations reached schema 71 while
preserving all 61 pre-existing data tables' original rows/columns on each provider.
All 33 app-provider and 29 dev-provider account/prepared operational key pairs
decrypted and matched their public keys. No production workers ran in the clones.
No native connection table existed before upgrade; no obsolete relationship cleanup
was needed or performed.

Rollout was app first, then dev, each gated by configuration, container health,
schema and public HTTP checks. Inventory remained:

| Provider | Accounts | Account keys | Prepared-transfer rows |
| --- | ---: | ---: | ---: |
| `hailproto.app` | 9 | 23 | 4 |
| `hailproto.dev` | 9 | 22 | 3 |

Caddy, all databases, the private PLC/sequencer and the old private-POC monitor
containers retained their original IDs. PostgreSQL major/minor versions, volumes,
ports, firewall, SSH policy, Caddy configuration and existing canaries were not changed.
Public readiness, `/auth/login` and `/connect` passed; anonymous connection access
returned 401 and empty unsigned source-freeze input returned 400. Startup logs
show healthy canonical PLC reader diagnostics for each existing diagnostic DID.

Safe off-host reports:

- `ops/pg18-rehearsal/hailproto-providers-connection-upgrade-proof.json`
- `ops/pg18-rehearsal/hailproto-providers-unified-rollout.json`

### Deployment files and rollback boundary

The reviewed Compose stack merges, in order:

1. `/opt/hailproto-app-source/apps/server/deploy/poc/compose.yaml`
2. `/opt/hail-poc/hail-server-ts/deploy/poc/compose.public-canary.yaml`
3. `/opt/hailproto-app-ops/compose.yaml`

It uses `/opt/hail-poc/hail-server-ts/deploy/poc/.env`. Do not print merged Compose
configuration: it contains operational secrets. The third file retains the new image,
per-origin GUI/passkey settings and monitor pin. Its prior version is preserved as
`/opt/hailproto-app-ops/compose.yaml.before-d622ab3`; the old image remains available.
The root-owned rollout record is `/opt/hailproto-app-ops/unified-connections-rollout.json`.

Use service-specific `up --no-deps` during future reviewed rollouts; do not recreate
the databases, Caddy or private PLC/monitor stack unnecessarily. Never restore an old
database volume after new writes. Retained connection/checkpoint-v3 records can make
an old application image incompatible: review the post-write boundary rather than
blindly restoring the old Compose file or bypassing schema guards.

## Public connection-bearing / returning-account rehearsal gate

Upgrading and enabling routes is **not** a completed public transfer rehearsal.
No new account or public DID, connection, message or account move was created by
this upgrade. Existing canaries were not used as disposable accounts.

A fresh public round trip requires the independent monitor operator to enroll the
disposable DIDs, attest onboarding, review/approve each exact cutover expectation
and issue fresh operation-specific attestations. The existing monitor SSH account
has passwordless access only to `hail-monitor-ops`; that wrapper exposes status,
logs, backup and application deployment, not enrollment/approval/attestation commands.
Its signup enrollment API is separately provider-bound and is not an arbitrary
transfer-approval API. Do not reuse Haili's enrollment token for another provider,
copy the monitor signing secret off-host, or broaden sudo to bypass this boundary.

Arrange console-assisted monitor operations (or a separately reviewed narrowly
scoped operator command) before creating the disposable public identities. Then
prove connections/messages before and after `app → dev → app`, terminal disconnect
and replay behavior, fresh destination access, journal preservation and old-code
invalidation. Until that proof is recorded, the two acceptance checks in the
[portability status](portability-status.md) remain open.

### Rehearsal progress — October 26

Four disposable public DIDs were created and independently enrolled/attested by
the monitor operator: owner-controlled and managed travellers, with one static
peer on each provider. All four activated with verified monitor signatures.
Locally retained software WebAuthn authenticators enrolled through the real
recovery/authentication endpoints; this is protocol proof, not hardware-attestation
proof. Recovery material and resumable state have checksum-verified encrypted
independent backups; no monitor signing key was exported.

Four shared-model local/remote connections converged at epoch 1. All eight
bidirectional baseline message copies reached delivered state with identical
sender/recipient body representations. The test driver initially checked the
reverse projection before replication completed; its readiness condition was
corrected without changing product code or recreating consent.

A public-runtime preflight found a separate product defect: the shared cutover
gate chose the managed manifest parser whenever a managed monitor was configured,
including for owner-controlled imports. Regression proof reproduced the rejection.
Fix `7b61aa8d4167f880fc779958cc837553787363f7` selects the parser from the retained
import custody profile, preserves the portable account's own monitor declaration,
and still requires an independent configured monitor for managed imports.
All 16 portable fence/public-gate and 2 managed orchestration checks passed;
[CI 40259040940](https://github.com/j4crev/hailproto/actions/runs/40259040940) passed.

With explicit operator approval, only the two rehearsal backends rolled to
`7b61aa8`; Haili, GUIs, Caddy, databases and monitor/PLC containers were unchanged.
Fresh encrypted backup:
`/var/backups/hail-poc/pre-unified-connections-20261026T022559Z/providers.tar.gpg`,
SHA-256 `4d0957bfc2b8368d8cf391cb888f8bba34d52d857a113216ca8f6e8f33a552f5`.
Its off-host restore preserved all 87 existing data tables on each provider and
verified all 40 app / 31 dev operational key pairs. Schema remains 71.
The safe rollout and backup proof are retained under
`/opt/hailproto-app-ops/public-custody-parser-rollout.json` and
`ops/pg18-rehearsal/hailproto-providers-public-custody-parser-proof.json`.

Both travellers' first app-to-dev owner-authorized PLC updates were submitted
against their exact fenced snapshots and stopped at `awaiting-monitor`. The
destination accounts are not yet activated; source fences and peer holds remain.
The operator's operation-specific approval/attestation is the next gate, followed
by activation, history/messaging/code checks and the fresh return transfer.
Neither public round trip is claimed complete at this checkpoint.

The first operation-specific monitor approvals and signatures verified, and public
cutover evidence was retained. Owner-controlled materialization then rolled back:
connection-history reconstruction supplied the closed public-evidence projection
without mandatory database `record_version` / read-policy metadata. PostgreSQL
rejected the null metadata before destination activation; constraints, peer holds
and staged private keys were not bypassed or edited.

Fix `49c79ff3d75cb8b71f0f18900f493288fff879ff` materializes the known v1 metadata
without changing bundle bytes, digests or signed snapshot formats. A focused test
failed on the missing columns before the fix, then passed; signature/history tests,
both transfer integration suites and
[CI 40264261773](https://github.com/j4crev/hailproto/actions/runs/40264261773) passed.
With explicit operator approval, only the rehearsal backends rolled again; Haili
and schema 71 stayed unchanged. Backup:
`/var/backups/hail-poc/pre-unified-connections-20261026T032837Z/providers.tar.gpg`,
SHA-256 `2336094f7743f0caf172e1481b986604738e3ec21f3dea25a232e43d2802a38d`.
Its isolated restore preserved all 87 existing tables per provider and verified
40 app / 36 dev operational key pairs, including the staged destination keys.
Safe proof: `ops/pg18-rehearsal/hailproto-providers-evidence-restoration-proof.json`;
rollout: `/opt/hailproto-app-ops/public-evidence-restoration-rollout.json`.

The expired monitor signatures must be renewed against the same approved operation
CIDs. The original source-signed snapshots, owner approvals, PLC operations and
peer journals remain the resumption artifacts; do not sign replacements, relax
freshness or force activation. Metadata-rich monitor CLI output is locally verified
and projected into the two-field signed wire object before completion submission.

### Outbound completion and retired-peer correction

Fresh signatures from monitor archive `20261026T033620Z` (SHA-256
`fe15702cd9b598bd5da1f7d9b75460f7f169ec118a1f633c0c1292a41946246a`)
completed both exact outbound transfers. Both destination owner logins and
destination-local software WebAuthn enrollments passed. Source fences are retired;
portable destination generation is 1, managed destination generation is 2.

Cross-provider post-move delivery exposed retained retired source rows being
treated as serving local peers. Fix `1c29f4f34debb8eb5a14a213a810edf41100595e`
filters control-proof retention to current unfenced serving accounts and applies
migration 72: retain peer row locks against concurrent returns, but do not demand
serving authority from a retired peer shadow. Serving owner/peer fences, consent,
epochs and tombstones remain enforced. No account, key or signed history is deleted.
Bidirectional post-move integration checks, fence/return regressions and
[CI 40305860723](https://github.com/j4crev/hailproto/actions/runs/40305860723) passed.

Explicitly approved rollout changed only rehearsal backends to `1c29f4f` and their
schema to 72. GUIs, unrelated containers and Haili were unchanged. Fresh encrypted
backup `pre-unified-connections-20261026T101434Z/providers.tar.gpg` has SHA-256
`a693e756cd745cedb496c459453d6af71647f8162af5cff4938d41cb4d580b6c`.
Off-host migration preserved all 87 existing data tables per provider and verified
40 app / 41 dev operational key pairs. Proof:
`ops/pg18-rehearsal/hailproto-providers-retired-peer-proof.json`; hosted rollout:
`/opt/hailproto-app-ops/public-retired-peer-rollout.json`.

At `2026-10-26T10:30:16Z`, all four original connection IDs/epoch 1, eight original
message bodies and eight bidirectional post-move messages verified. Two previously
indeterminate submissions needed the existing authenticated resubmit endpoint;
their original message IDs and signed envelope bytes were reused. Both old source
credentials reject access and both permanent source codes return 410; separately
issued destination codes remain present. Private durable proof: `outbound-proof.json`.

The portable return request is retained but has no Offer; neither dev account is
fenced. Investigation identifies explicit private-POC-only return eligibility in
`migration/return.ts` and portable activation. Do not enable private-POC flags or
delete retired source histories to bypass it. Public return acceptance and any
unrelated-provider interoperability claim remain open pending a separately scoped
strict-public return implementation and rehearsal.

### Strict-public return support and pending monitor approval

Backend-only release `8c2eab9ade27d51505f1f1edd13b1fde1ec7bf85` enables
portable public returns through the existing archived-retirement machinery,
requires unchanged owner identity/recovery keys, monitor pin and trust profile,
and reserves the original username using a separate provisional account.
The connection-bearing strict-public round-trip fixture verifies current-operation
monitor approval, signed history, terminal connection history and resumed delivery.
All 36 focused checks, typecheck and
[CI 40310214139](https://github.com/j4crev/hailproto/actions/runs/40310214139) passed.

With explicit operator approval, only the two rehearsal backends were deployed;
schema 72, both GUI containers and Haili stayed unchanged. Concurrent local GUI
work was excluded from the commit and from the remote build checkout. Backup:
`pre-unified-connections-20261026T104809Z/providers.tar.gpg`, SHA-256
`ac012cc33c01c39b2d2d8f8e1e252a918246ca04cc57ce7c3b1d81f9e0a8f44f`.
Isolated restore preserved all 87 existing data tables per provider and verified
40 app / 41 dev operational key pairs. Proof:
`ops/pg18-rehearsal/hailproto-providers-public-return-proof.json`; hosted rollout:
`/opt/hailproto-app-ops/public-return-rollout.json`.

Both exact dev → app returns reached `awaiting-monitor`; both dev source accounts
are fenced/exported, not yet retired. The portable request was resumed unchanged;
one managed timeout was recovered by retrying its retained artifacts. Operation CIDs:

- Owner-controlled, transfer `d56b1a22-f029-4aee-8513-372436581846`:
  `bafyreigxoblnaqudphru4quumwtglqixmudjd4czdrenrqv6cmdqkuj3bi`.
- Managed, transfer `3f9f21c9-1a15-45bb-b235-0e8d450b1e6d`:
  `bafyreihnggyrfkpyuycvx6jojowo77npmaywlnjvhhedjyvqbghk22ghwu`.

Canonical public logs verify both exact operations, outbound predecessors, original
bootstrap CIDs and locally reviewed full states. The narrowly scoped root-console
approval bundle `/home/hailops/hail-public-connections-return-20261026.tar` was
staged on the monitor host with SHA-256
`c45ef9764cf0d2d94a35b79bed6436cb77ed6c4f34c0e1590c63fab8ee40e403`.
It uses existing enrollment and expected outbound approvals; no checkpoint reset,
new enrollment token, private key export or privilege expansion is involved.
Fresh return attestations and hosted post-return verification are still required.
Encrypted local pending-state backup: `ops/public-connections-return-pending-20261026.tar.gpg`,
SHA-256 `c2c6758ebe089d9ea184a18b9bbb5aa035c548072e27fbc53e833070ffa8f51b`.

### Completed strict-public round trips

The first fresh return approvals retained eligible cutover evidence, but both
activations rolled back on `connection_proof_signatures` conflicts. A direct call
to the unchanged production activation classes/gates identified the exact refusal;
no activation check was skipped. Read-only comparison found identical signed COSE,
PLC document, state and operation log; only the independently verified public read
receipt digest and timestamp differed. No signing keys or historical branches were
reconciled or substituted.

Explicitly approved backend-only fix `c7ec5c4786ae2cdac06f32210eeee9d6e4895332`
keeps the original proof row while comparing exact signer state/log/profile/head
independently of read-observation digest/time. Both observation bundles and signed
checkpoints remain archived. Changed signatures, document, state, log, profile or
operation CID still reject. The new regression failed before the fix; all 19
focused checks, typecheck and
[CI 40313420173](https://github.com/j4crev/hailproto/actions/runs/40313420173) passed.

Pre-roll backup `pre-unified-connections-20261026T111321Z/providers.tar.gpg` has
SHA-256 `73731b4244bdd752c9f768de7193fe2a81ecb57e70d187c1a93906a52e314640`.
Isolated restoration preserved all 87 existing data tables per provider and
verified 45 app / 41 dev operational key pairs. Both exact retained return
snapshots also reconstructed successfully in rollback-only clone transactions,
without monitor/activation claims. Proofs:
`ops/pg18-rehearsal/hailproto-providers-proof-observations-proof.json` and
`ops/pg18-rehearsal/hailproto-providers-exact-return-reconstruction-proof.json`.
Rollout receipt: `/opt/hailproto-app-ops/public-proof-observations-rollout.json`.
Only rehearsal backend images changed; schema 72, both GUI containers and Haili
remained unchanged. Concurrent GUI work was not committed, built or deployed.

Fresh console-issued return attestations `20261026T111921Z`, archive SHA-256
`de2806db378a93292acc7f23a1a177d6eba9b77eca2e80ae65fee54fe4f1d496`,
verified against the exact reviewed DID, transfer, operation, original bootstrap
and monitor pin. Both retained transfers then completed through the normal CLI
completion/retirement endpoints, using a bounded 60-second rehearsal transport
timeout rather than replacing any signed artifact. Both original app usernames
are active again; dev sources are retired. App serving generations are portable
2 / managed 3; dev retains portable 1 / managed 2. Portable accounts still have
no provider-held identity private key.

At `2026-10-26T11:24:00Z`, authenticated checks verified:

- Fresh local identity / owner-recovery API logins and new app-local software
  WebAuthn enrollment/authentication for both returned accounts.
- All four original connection IDs remain at epoch 1; no pending handovers.
- All 16 prior messages remain readable with matching sender/recipient bodies;
  eight fresh bidirectional messages delivered after return.
- Original app credentials/sessions and retired dev credentials/sessions reject
  authentication. Both original app and interim dev permanent codes return 410;
  each returned app account issued a genuinely fresh personal code.
- Read-only database checks match 16 signed envelope copies byte-for-byte against
  retained outbound/return snapshots and match both exact connection-checkpoint
  archive digests. Each returned account retains four completed import journals
  with completion receipts and its original source retirement archive. Both peer
  providers retain completed barrier rows for all four transfer IDs.

Private durable proofs: `return-proof.json`, `return-byte-proof.jsonl`, original
`moves/{outbound,return}/` artifacts, credentials and software authenticator files.
There were no hosted disconnect tombstones in these four standing connections;
terminal disconnect preservation remains covered by the component/integration
fixtures, not a newly claimed public disconnect rehearsal. Software authenticators
prove protocol behavior, not hardware attestation. Existing canaries were untouched;
unrelated-provider interoperability remains unproven.

Final owner-state encrypted backup `ops/public-connections-round-trip-20261026.tar.gpg`
has SHA-256 `7b7916d4bc53316dd5191eca7fb18e29d684cb2ed5ed579ccaf64e8facc48100`.
Decryption verified all 161 files against their originals, including both vaults,
recovery material, returned credentials and completed transfer artifacts; no new
plaintext backup was retained on disk. Safe receipt:
`ops/public-connections-round-trip-backup-proof.json`.
