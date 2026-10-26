# Messaging and portability status

## Already shipped

- [x] Connection messaging: Compose → Connections and Conversations on `haili.app`.

## Deployed implementation — October 26, 2026

Haili release `6e50f8e` / schema 72; backup, migration-preservation and public
smoke-check receipts are in [the deployment log](haili-launch.md). The component
proofs below use disposable fixtures; the separate completed strict-public hosted
rehearsals are recorded under rollout verification.

- [x] Connection-history checkpoints in account-transfer snapshots and inert import staging.
- [x] Signed source/destination/peer handover preparation.
- [x] Historical consent/control signature verification and retained signing evidence.
- [x] Durable peer freeze and pre-cutover abort, including lost-reply/restart checks and held delivery.
- [x] Federated post-PLC commit, exact peer/coordinator location updates and activation-bound final release.
- [x] Destination federated reconstruction and terminal overlays; three-provider component check preserves messages and resumes messaging.
- [x] Completed/released journals and cancelled-transfer evidence in checkpoint v3, with historical signature verification and immutable archives.
- [x] Cutover code warning, source-retirement revocation and fresh destination code checks.
- [x] One consent/control model for new local and remote connections, with in-process local calls.
- [x] Same-provider → cross-provider component move preserves the original connection ID/epoch and messaging.
- [x] Source export-bound proof issuance and prepared-destination signing wired into both completion paths.
- [x] Real connection-bearing managed and owner-controlled moves through PLC submission, activation, release and source retirement.
- [x] Owner-authorized cancellation, interrupted-release recovery, source restoration and unchanged source codes.
- [x] Managed destination passkey recovery and resumed messaging; owner-controlled destination retains no identity private key.

## Remaining rollout verification

- [ ] Explicitly scoped reset of obsolete native records before upgrading affected pre-launch relationships; no conversion adapter planned.
- [x] Strict-public connection-bearing app → dev → app rehearsals for both custody profiles: original usernames, fresh destination passkeys, source retirement, old credential/session/code rejection, four unchanged connection IDs/epoch 1, 16 historical message reads and eight post-return deliveries verified. Exact signed envelope copies and completed journals checked read-only; see [provider receipts](hailproto-providers-operations.md).
- [ ] Unrelated-provider interoperability; the two public rehearsal providers share operator infrastructure.
- [ ] Scoped breaking cleanup/upgrade instructions for unsupported pre-launch records.
- [x] Commit, CI, push and guarded deployment, with off-host backup/migration proof.
- [x] Upgrade `hailproto.app` and `hailproto.dev` with public transfer/monitor configuration; rehearsal backends run `c7ec5c4` / schema 72; see [provider receipts](hailproto-providers-operations.md). Haili now runs the combined backend/frontend release `6e50f8e` / schema 72.

New-model connection transfers are wired when orchestration is configured.
Missing orchestration returns `awaiting-connection-handover`; obsolete records and
undrained work remain blocked. **Messaging itself is already live.**
The fixture now distinguishes seeded component checks from real account-transfer
ceremonies. Both custody profiles execute actual fencing, snapshots, owner approval,
peer RPC, PLC writes, materialization and authenticated retirement.
No legacy-proof reconciliation subsystem is planned; follow the
[pre-launch development policy](../README.md#pre-launch-development-policy--developers-and-agents).
This checklist describes the remaining feature, not permission to wipe hosted data.
