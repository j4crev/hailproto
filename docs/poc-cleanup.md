# POC cleanup audit

There is meaningful POC cleanup available, but most should wait until the
remaining private rehearsals finish.

1. **Delete:** Archive the historical POC rollout journals from release-facing
   documentation; Git history plus one concise archive index is enough.
   [`hailproto/docs/typescript-backend-poc.md:1`,
   `apps/server/deploy/poc/README.md:1`,
   `apps/cli/docs/*release*.md`]
2. **Delete:** Remove the original custodial prototype onboarding path after the
   remaining legacy accounts are migrated or retired; strict-public mode already
   refuses it. Replacement: public/private owner-key onboarding APIs.
   [`apps/server/src/onboarding/service.ts:57`,
   `apps/server/src/cli/onboard.ts:1`,
   `apps/server/src/cli/activate-local.ts:1`,
   `apps/server/src/cli/activate-public.ts:1`]
3. **Shrink:** Stop copying server operator CLIs and sample Alice/Bob files into
   the production image. They add roughly 1,164 source lines to the artifact but
   are not imported by `src/index.ts`. [`apps/server/Dockerfile:34-37`]
4. **Delete:** Remove the eight standalone provider `poc:*` CLI wrappers once the
   remaining private gates use API/runtime orchestration exclusively; only
   `package.json` references them. [`apps/server/package.json:16-23`,
   `apps/server/src/cli/*private-poc*.ts`]
5. **Delete:** Replace six legacy client `poc:*` wrappers and wrapper-specific
   subprocess tests with `hailp` coverage. Keep the underlying signing/vault
   functions still used by private fixtures.
   [`apps/cli/package.json:22-27`,
   `apps/cli/src/cli/*private-poc*.ts`]
6. **Shrink:** Move `PrivatePocTransferAbandonment` from production `src/` into
   test support; it is referenced only by the private migration integration test
   and is deliberately not routed.
   [`apps/server/src/migration/abandonment.ts:27`,
   `apps/server/test/private-poc-migration.integration.test.ts:33`]
7. **Delete:** Remove the same-VPS SQLite POC alert receiver and Compose service
   after the independent alert destination replaces it. It cannot provide
   production independence.
   [`apps/plc-monitor/src/cli/poc-alert-receiver.ts:1`,
   `apps/plc-monitor/deploy/poc/compose.yaml:57`]

## Do not cut yet

Do not remove private-PLC runtime fixtures, `poc-local` labels, historical
migrations/tables, legacy exact-retry parsing, or the `poc-v1` KEK identifier.
They remain compatibility or production-gate evidence, and applied migrations
cannot be rewritten safely.

## Recommendation

- Do item 3 now.
- Do items 1, 4, 5, and 6 immediately after the private gates finish.
- Do item 2 only after legacy-account disposition.
- Do item 7 when independent monitoring lands.

## Estimated impact

- Approximately 5,000 fewer repository lines.
- Approximately 1,200 fewer lines in the production server artifact.
- No dependency removals identified.
