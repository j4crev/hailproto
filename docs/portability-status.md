# Messaging and portability status

## Already shipped

- [x] Connection messaging: Compose → Connections and Conversations on `haili.app`.

## Deployed implementation — October 26, 2026

Release `d622ab3`; backup, migration-preservation and public smoke-check receipts
are in [the deployment log](haili-launch.md). End-to-end transfer proofs below use
disposable local fixtures, not hosted account moves.

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
- [ ] Focused connection-bearing returning-account rehearsal; existing connection-free return tests remain a regression gate.
- [ ] Public strict-authority connection-bearing rehearsal and unrelated-provider interoperability; private-fixture proof is not production finality.
- [ ] Scoped breaking cleanup/upgrade instructions for unsupported pre-launch records.
- [x] Commit, CI, push and guarded deployment, with off-host backup/migration proof.

New-model connection transfers are wired when orchestration is configured.
Missing orchestration returns `awaiting-connection-handover`; obsolete records and
undrained work remain blocked. **Messaging itself is already live.**
The fixture now distinguishes seeded component checks from real account-transfer
ceremonies. Both custody profiles execute actual fencing, snapshots, owner approval,
peer RPC, PLC writes, materialization and authenticated retirement.
No legacy-proof reconciliation subsystem is planned; follow the
[pre-launch development policy](../README.md#pre-launch-development-policy--developers-and-agents).
This checklist describes the remaining feature, not permission to wipe hosted data.
