# Managed custody v1 conformance review

Status: Frozen private-fixture review, October 13, 2026.

This review fixes `hail-managed-custody-v1` and
`hail.plc-read-evidence-v1`. It maps every MC case to executable reference
evidence without promoting private PLC observations to public or independent
evidence. Public writes, host administration and physical custody remain the
separate deployment gates named below.

## Versioning decision

- A semantic profile or policy change requires a new identifier.
- Signed wire records retain their existing type/version and signature domains.
- Provider records retain the managed profile or read-evidence policy separately
  from custody, registry and activation modes.
- Legacy exact private-POC snapshot retries remain readable but cannot become
  strict-public evidence.

## MC-01–MC-14 review

| Case | Private-fixture executable evidence | Evidence still required elsewhere |
| --- | --- | --- |
| MC-01 | `apps/server/test/self-service.integration.test.ts`, `test/public-onboarding.integration.test.ts`, migration 50 constraints | None for profile structure |
| MC-02 | `apps/cli/test/managed-genesis.test.ts`, `apps/server/test/managed-migration-preparation.integration.test.ts` | None for key/state structure |
| MC-03 | `apps/cli/test/managed-genesis.test.ts`, `apps/server/test/public-onboarding.integration.test.ts` | None for signing/DID/CID logic |
| MC-04 | `apps/cli/test/managed-genesis.test.ts`, `apps/server/test/onboarding-restart.integration.test.ts` | None for exact retry logic |
| MC-05 | `apps/server/test/public-onboarding.integration.test.ts`, `test/config.test.ts`, `test/poc-resolver.test.ts` | One canonical public canary write/readback |
| MC-06 | `apps/cli/test/vault-backup.test.ts`; provider tests prove no recovery private-key storage/transport | Independent physical backup installation and operator record |
| MC-07 | `apps/plc-monitor/test/monitor.integration.test.ts`, `test/plc.test.ts`; `apps/server/test/plc-read-evidence.test.ts`, `test/public-plc-resolver.test.ts` | Independently administered deployment and public read-only bootstrap |
| MC-08 | `apps/server/test/public-onboarding.integration.test.ts`, `test/activation.test.ts` | Final public canary activation |
| MC-09 | `apps/server/test/account-api.integration.test.ts`, `test/grant-update.integration.test.ts`, `test/managed-network-orchestration.integration.test.ts` | None for application authorization logic |
| MC-10 | `apps/server/test/account-access.integration.test.ts` | Durable owner backup/operator procedure from MC-06 |
| MC-11 | `apps/server/test/custody-transition.integration.test.ts`, `apps/cli/test/custody-transition.test.ts` | Public canary transition smoke check |
| MC-12 | `apps/server/test/managed-network-orchestration.integration.test.ts`, `test/managed-handshake.test.ts`, `apps/cli/test/managed-account-transfer.test.ts` | Public canary A → B → A proof |
| MC-13 | `apps/server/test/plc-read-evidence.test.ts`, `test/private-poc-migration.integration.test.ts`, `test/managed-network-orchestration.integration.test.ts` | Reviewed unsupported-history and production abandonment procedures |
| MC-14 | `apps/server/test/serving-history-migration.integration.test.ts`, `test/transfer-rate-limit.integration.test.ts`, private clone rehearsal | Independent cross-host restoration and calibrated production envelope |

The private-fixture portion is complete only while all referenced suites pass.
MC-05–MC-08 and MC-11–MC-14 deliberately retain the listed environment or
operational evidence requirements; this review does not satisfy them by label.
