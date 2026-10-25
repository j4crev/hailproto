# Messaging and portability status

## Already shipped

- [x] Connection messaging: Compose → Connections and Conversations on `haili.app`.

## Implemented locally, not deployed

- [x] Connection-history checkpoints in account-transfer snapshots and inert import staging.
- [x] Signed source/destination/peer handover preparation.
- [x] Historical consent/control signature verification and retained signing evidence.
- [x] Durable peer freeze and pre-cutover abort, including lost-reply/restart checks and held delivery.
- [x] Federated post-PLC commit, exact peer/coordinator location updates and activation-bound final release.
- [x] Destination federated reconstruction and terminal overlays; three-provider component check preserves messages and resumes messaging.
- [x] Completed/released handover journals included in checkpoint v2, with historical signature verification and immutable archives.
- [x] Cutover code warning, source-retirement revocation and fresh destination code checks.

## Needed before connection-bearing account moves work

- [ ] Source orchestration and destination reconstruction/activation wired end to end.
- [ ] Native consent conversion/preservation or explicitly scoped breaking reset; current reconstruction rejects native records.
- [ ] Subsequent/return moves with retained journals proven before relaxing their source cutover guards.
- [ ] Complete code invalidation proof through the actual committed account-transfer path, including cancellation.
- [ ] End-to-end moves with messaging, disconnect/replay, cancellation and failure checks.
- [ ] Scoped breaking cleanup/upgrade instructions for unsupported pre-launch records.
- [ ] Commit, CI, push and guarded deployment when requested.

Connection-bearing transfers are still blocked. **Messaging itself is already live.**
The component fixture seeds the authenticated import/base-account boundary; it is
not proof of a complete connection-bearing account transfer. Source issuance,
destination signing/orchestration and safe pre-cutover unwind remain unfinished.
No legacy-proof reconciliation subsystem is planned; follow the
[pre-launch development policy](../README.md#pre-launch-development-policy--developers-and-agents).
This checklist describes the remaining feature, not permission to wipe hosted data.
