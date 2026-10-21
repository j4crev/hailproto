import { createHash } from "node:crypto";
import { SQL } from "bun";
import {generationBoundSql} from "./serving.js";

interface Migration {
  version: number;
  name: string;
  url: URL;
}

interface AppliedMigration {
  version: number;
  checksum: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "onboarding",
    url: new URL("../../migrations/0001_onboarding.sql", import.meta.url),
  },
  {
    version: 2,
    name: "onboarding-evidence",
    url: new URL("../../migrations/0002_onboarding_evidence.sql", import.meta.url),
  },
  {
    version: 3,
    name: "plc-readback-evidence",
    url: new URL("../../migrations/0003_plc_readback_evidence.sql", import.meta.url),
  },
  {
    version: 4,
    name: "account-activation",
    url: new URL("../../migrations/0004_account_activation.sql", import.meta.url),
  },
  {
    version: 5,
    name: "activation-lifecycle",
    url: new URL("../../migrations/0005_activation_lifecycle.sql", import.meta.url),
  },
  {
    version: 6,
    name: "sender-profiles",
    url: new URL("../../migrations/0006_sender_profiles.sql", import.meta.url),
  },
  {
    version: 7,
    name: "grants",
    url: new URL("../../migrations/0007_grants.sql", import.meta.url),
  },
  {
    version: 8,
    name: "detached-bodies",
    url: new URL("../../migrations/0008_detached_bodies.sql", import.meta.url),
  },
  {
    version: 9,
    name: "envelopes",
    url: new URL("../../migrations/0009_envelopes.sql", import.meta.url),
  },
  {
    version: 10,
    name: "delivery-work",
    url: new URL("../../migrations/0010_delivery_work.sql", import.meta.url),
  },
  {
    version: 11,
    name: "delivery-status",
    url: new URL("../../migrations/0011_delivery_status.sql", import.meta.url),
  },
  {
    version: 12,
    name: "reply-capabilities",
    url: new URL("../../migrations/0012_reply_capabilities.sql", import.meta.url),
  },
  {
    version: 13,
    name: "migration-fence",
    url: new URL("../../migrations/0013_migration_fence.sql", import.meta.url),
  },
  {
    version: 14,
    name: "migration-snapshots",
    url: new URL("../../migrations/0014_migration_snapshots.sql", import.meta.url),
  },
  {
    version: 15,
    name: "portable-migration-authority",
    url: new URL("../../migrations/0015_portable_migration_authority.sql", import.meta.url),
  },
  {
    version: 16,
    name: "portable-cutover-observation",
    url: new URL("../../migrations/0016_portable_cutover_observation.sql", import.meta.url),
  },
  {
    version: 17,
    name: "user-signed-cutover-operation",
    url: new URL("../../migrations/0017_user_signed_cutover_operation.sql", import.meta.url),
  },
  {
    version: 18,
    name: "destination-operational-keys",
    url: new URL("../../migrations/0018_destination_operational_keys.sql", import.meta.url),
  },
  {
    version: 19,
    name: "portable-destination-address",
    url: new URL("../../migrations/0019_portable_destination_address.sql", import.meta.url),
  },
  {
    version: 20,
    name: "portable-cutover-activation",
    url: new URL("../../migrations/0020_portable_cutover_activation.sql", import.meta.url),
  },
  {
    version: 21,
    name: "migration-retirement-receipt",
    url: new URL("../../migrations/0021_migration_retirement_receipt.sql", import.meta.url),
  },
  {
    version: 22,
    name: "transfer-handshake",
    url: new URL("../../migrations/0022_transfer_handshake.sql", import.meta.url),
  },
  {
    version: 23,
    name: "transfer-origin-proof",
    url: new URL("../../migrations/0023_transfer_origin_proof.sql", import.meta.url),
  },
  {
    version: 24,
    name: "transfer-address-selection",
    url: new URL("../../migrations/0024_transfer_address_selection.sql", import.meta.url),
  },
  {
    version: 25,
    name: "transfer-grant-evidence",
    url: new URL("../../migrations/0025_transfer_grant_evidence.sql", import.meta.url),
  },
  {
    version: 26,
    name: "transfer-delivery-jobs",
    url: new URL("../../migrations/0026_transfer_delivery_jobs.sql", import.meta.url),
  },
  {
    version: 27,
    name: "transfer-throttling",
    url: new URL("../../migrations/0027_transfer_throttling.sql", import.meta.url),
  },
  {
    version: 28,
    name: "transfer-cancellation",
    url: new URL("../../migrations/0028_transfer_cancellation.sql", import.meta.url),
  },
  {
    version: 29,
    name: "private-poc-cutover",
    url: new URL("../../migrations/0029_private_poc_cutover.sql", import.meta.url),
  },
  {
    version: 30,
    name: "private-poc-onboarding",
    url: new URL("../../migrations/0030_private_poc_onboarding.sql", import.meta.url),
  },
  {
    version: 31,
    name: "collocated-grant-receiver",
    url: new URL("../../migrations/0031_collocated_grant_receiver.sql", import.meta.url),
  },
  {
    version: 32,
    name: "account-api-credentials",
    url: new URL("../../migrations/0032_account_api_credentials.sql", import.meta.url),
  },
  { version: 33, name: "self-service-accounts", url: new URL("../../migrations/0033_self_service_accounts.sql",import.meta.url) },
  { version: 34, name: "account-access-challenges", url: new URL("../../migrations/0034_account_access_challenges.sql", import.meta.url) },
  { version: 35, name: "account-write-scope", url: new URL("../../migrations/0035_account_write_scope.sql", import.meta.url) },
  { version: 36, name: "serving-lifecycle-history", url: new URL("../../migrations/0036_serving_lifecycle_history.sql", import.meta.url) },
  { version: 37, name: "generation-admission", url: new URL("../../migrations/0037_generation_admission.sql", import.meta.url) },
  { version: 38, name: "retired-import-history", url: new URL("../../migrations/0038_retired_import_history.sql", import.meta.url) },
  { version: 39, name: "transfer-abandonment", url: new URL("../../migrations/0039_transfer_abandonment.sql", import.meta.url) },
  { version: 40, name: "public-cutover-evidence", url: new URL("../../migrations/0040_public_cutover_evidence.sql", import.meta.url) },
  { version: 41, name: "public-plc-authority", url: new URL("../../migrations/0041_public_plc_authority.sql", import.meta.url) },
  { version: 42, name: "public-grant-authority", url: new URL("../../migrations/0042_public_grant_authority.sql", import.meta.url) },
  { version: 43, name: "public-signing-authority", url: new URL("../../migrations/0043_public_signing_authority.sql", import.meta.url) },
  { version: 44, name: "public-onboarding", url: new URL("../../migrations/0044_public_onboarding.sql", import.meta.url) },
  { version: 45, name: "same-provider-custody-transition", url: new URL("../../migrations/0045_same_provider_custody_transition.sql", import.meta.url) },
  { version: 46, name: "reverse-custody-transition", url: new URL("../../migrations/0046_reverse_custody_transition.sql", import.meta.url) },
  { version: 47, name: "managed-provider-migration", url: new URL("../../migrations/0047_managed_provider_migration.sql", import.meta.url) },
  { version: 48, name: "managed-migration-approval", url: new URL("../../migrations/0048_managed_migration_approval.sql", import.meta.url) },
  { version: 49, name: "managed-migration-materialization", url: new URL("../../migrations/0049_managed_migration_materialization.sql", import.meta.url) },
  { version: 50, name: "managed-profile-version", url: new URL("../../migrations/0050_managed_profile_version.sql", import.meta.url) },
  { version: 51, name: "did-monitor-coverage", url: new URL("../../migrations/0051_did_monitor_coverage.sql", import.meta.url) },
];

export class ProviderDatabase {
  readonly #sql: SQL;

  constructor(databaseUrl: string) {
    this.#sql = generationBoundSql(new SQL(databaseUrl, { max: 10 }));
  }

  async ping(): Promise<void> {
    await this.#sql`SELECT 1`;
  }

  get sql(): SQL {
    return this.#sql;
  }

  async migrate(): Promise<void> {
    await this.#sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    await this.#sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(684245101)`;

      const rows = await transaction<AppliedMigration[]>`
        SELECT version, checksum
        FROM schema_migrations
        ORDER BY version
      `;
      const applied = new Map(rows.map((row) => [row.version, row.checksum]));

      for (const migration of migrations) {
        const source = await Bun.file(migration.url).text();
        const checksum = createHash("sha256").update(source).digest("hex");
        const existingChecksum = applied.get(migration.version);

        if (existingChecksum !== undefined) {
          if (existingChecksum !== checksum) {
            throw new Error(`Applied migration ${migration.version} checksum does not match`);
          }
          continue;
        }

        await transaction.unsafe(source);
        await transaction`
          INSERT INTO schema_migrations (version, name, checksum)
          VALUES (${migration.version}, ${migration.name}, ${checksum})
        `;
      }
    });
  }

  async close(): Promise<void> {
    await this.#sql.close();
  }
}
