# Milestone 5 release — October 11, 2026 (UTC)

Both private-POC providers are healthy at migration **39**, with self-service
owner-controlled transfer and stable-identity return enabled. A real HTTPS
app → dev → app round trip preserved the returning inbox and all three terminal
delivery acknowledgements. Internal post-export abandonment has no public route.

## Release identity and configuration

| Component | Identity |
| --- | --- |
| Provider deployed source | `b51e1c7f5e21345e2cc0609bbdecbbe70cd9da05` |
| Provider generation/recovery runtime | `19d0ee7` plus `b51e1c7` arrival-history fix |
| Client verified source | `bfd21b8777165cbdb25ed665bbd2c81a25027d46` |
| Protocol | `fb9697b4074086fb86f6dc61f26805ec0450d315` |
| PLC library | `996e23b5ced9c15b32bcc612dd304880342ca4ab` |
| Running image | `hail-server-ts:poc-milestone5-20261011-fix1` |
| Image ID | `sha256:bd738cfabe7ecca7eebafc571cab1a47c427b01cd7c9a0c1510b2c87c0bab2a8` |

The final immutable Git-archive sibling layout is beneath
`/opt/hail-milestone5-release-20261011-fix1/`. The original candidate/rehearsal
source and scripts remain at `/opt/hail-milestone5-release-20261011/`.
The live `compose.cli-release.yaml` overlay pins the final image/build context
and enables `POC_SELF_SERVICE_ONBOARDING`, `POC_ACCOUNT_ACCESS`,
`POC_SELF_SERVICE_TRANSFER` and `POC_SELF_SERVICE_RETURN` on both providers.
The canonical directory remains the configured internal private PLC.

Use the existing overlay with all stack operations:

```bash
docker compose --env-file .env -f compose.yaml -f compose.cli-release.yaml ps
```

Only provider containers were rolled. Provider/PLC databases, PLC/sequencer,
Caddy and the separate monitor stack were not recreated and remain healthy.
No extra public ports or proxy routes were introduced.

## Rehearsal and backups

Fresh live migration-35 dumps were restored into disposable PostgreSQL 14.4
containers. For each provider, candidate startup/repeat migration reached 39,
the migration-35 image passed schema readiness against the expanded schema,
guarded schema rollback returned to 35, and re-upgrade returned to 39.
Sorted row hashes/counts matched for every pre-existing table at every step,
excluding only the migration ledger. Test generations stayed at 1. Temporary
containers and clone environment files were removed; live schemas/images were
unchanged during rehearsal.

Retained evidence/backups:

- `/var/backups/hail-poc/pre-milestone5-rehearsal-20261011/`
- `/var/backups/hail-poc/pre-milestone5-rollout-20261011/`
- `/var/backups/hail-poc/pre-milestone5-fix1-20261011/`

Directories are mode `0700`, and dumps/secret configuration are `0600`.
Nonempty provider/PLC dumps passed custom-format inventory checks; checksums,
previous Compose overlays and image identities are retained. Sequential same-VPS
dumps are not a claim of coordinated cross-host/post-cutover restore proof.

The migration-35 image remains tagged
`hail-server-ts:pre-milestone5-rollout-20261011`; the initial migration-39
candidate/image is retained too. The rehearsal's old-image compatibility applies
to generation 1. The real return below advanced an account to generation 2:
do not downgrade serving processes to generation-unaware code or treat schema
rollback as serving-authority recovery. Guarded rollback refuses advanced state.

## Rollout and live verification

1. Fresh backups preceded the individual provider rollout. Both new runtimes
   reached 39 and passed HTTPS readiness with serving-transition gates closed.
   Only after both were generation-aware and healthy were transfer/return gates
   enabled through individual provider restarts.
2. Existing disposable owner-controlled/managed release credentials authenticated
   on both origins. All four earlier disposable PLC logs still had exactly their
   original genesis operation; existing identity/custody was not converted.
3. Two fresh disposable accounts were created through HTTPS: an owner-controlled
   recipient on app and managed sender on dev. User vault/recovery material stayed
   local in mode-`0600` files; backup verification preceded signup. No user private
   key was copied to a provider. The sender's public profile was published only
   for its exact disposable release account.
4. A signed Grant was published to the sender before send verification. The
   initial test attempted send before the asynchronous publication arrived;
   waiting for the exact received Grant allowed the retained message request to
   continue without a new message ID.
5. Offer/select/export/exact cutover signing/completion and new destination login
   moved the same DID app → dev. Exact artifact retries were verified. A message
   was delivered while dev owned the DID, then the same flow returned it to app.
6. The real return exposed a legitimate receiver-local `grant_revisions.received_at`
   difference: dev already held a grantee replica before recipient migration.
   All signed/checkpoint fields matched. Fix `b51e1c7` compares that checkpoint
   independently of arrival time while retaining the original observation in
   the immutable archive; every other field still participates in the check.
   Focused regression/Grant tests passed, the fix image was rolled on both hosts,
   and the original snapshot/operation/consent/binding files completed the return.
7. App now owns generation 2 with no fence; dev retains its retired generation-1
   projection. Both retain exact outgoing history. The original app credential
   returns 401, fresh returning login works, and the final inbox contains messages
   delivered before, during and after the moves. All three sender status records
   reached terminal `delivered`, revision 2.
8. Both HTTPS readiness endpoints return 200, unauthenticated transfer reads
   return 401, and the internal recovery/abandonment path returns 404. Transfer
   and return gates are explicitly true on both generation-aware processes.
   Final provider logs contain startup messages with no worker errors.

Public proof IDs:

| Object | ID |
| --- | --- |
| Owner-controlled recipient | `did:plc:3s35gxrvk2godqpwqthjzg4o` |
| Managed sender | `did:plc:snjbs2bjnlwmas43qw6ixd6o` |
| Grant | `01a12c12-53a1-79dd-a99e-0b7089839930` |
| app → dev transfer | `9859e435-19c3-4977-ad96-49a6231bfe33` |
| dev → app return | `3e31f149-3ff7-41ee-8be8-e9464459f624` |

The final recipient address is
`release-m5-returned-3e31f149@hailproto.app`; the intermediate address is
`release-m5-moved-9859e435@hailproto.dev`. The three message IDs are
`01a12c12-5578-7e28-b505-792765197b7d`,
`01a12c13-d854-7af2-b3c3-d80f3da873ee` and
`01a12c26-2f7c-7321-a946-bf45f8071766`.

Local verification scripts and protected artifacts are under
`/tmp/opencode/milestone5-live-20261011/`, with scripts in `/tmp/opencode/`.
Only public script/result evidence was copied to the final VPS release directory;
vaults, recovery secrets, credential and private request files were not copied.

The [local generation/return proof](generation-bound-return.md) and
[post-export recovery proof](post-export-recovery.md) remain distinct from this
HTTPS rollout. Recovery coordination remains internal; managed migration,
identity-epoch reconciliation, public PLC, independent monitors and broader
restoration ceremonies are not enabled or relabeled as production guarantees.
