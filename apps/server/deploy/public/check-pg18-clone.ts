/** Off-host restored-copy check: never start delivery workers or print key material. */
import type { StoredAccountKey } from "../../src/identity/keys.js";

const role = process.argv[2];
const address = process.env.LAB_DATABASE_URL;
if (!address || !["monitor", "provider"].includes(role!) || process.env.HAIL_BACKUP_REHEARSAL !== "isolated-pg18") {
  throw new Error("Use only the isolated off-host PostgreSQL 18 rehearsal");
}
const url = new URL(address);
if (url.hostname !== "127.0.0.1" || Number(url.port) <= 1024) {
  throw new Error("Refusing a non-loopback or normal database endpoint");
}
// Import only this role's application: the production images deliberately do
// not both contain the other application's source tree.
const Database = role === "monitor"
  ? (await import("../../../plc-monitor/src/database.js")).MonitorDatabase
  : (await import("../../src/db/database.js")).ProviderDatabase;
const db = new Database(address);
let phase = "version";
let jsonTransport = "";
try {
  const version = await db.sql`SHOW server_version_num`;
  const expected = Number(process.env.LAB_EXPECTED_VERSION ?? 180006);
  if (![140024, 180006].includes(expected) || Number(version[0]?.server_version_num) !== expected) throw new Error("Unexpected clone version");
  phase = "application migrations";
  await db.migrate();
  phase = "driver roundtrip";
  await db.sql.begin(async tx => {
    phase = "driver temporary table";
    await tx`CREATE TEMP TABLE pg18_driver_probe(id uuid, document jsonb, payload bytea, stamp timestamptz) ON COMMIT DROP`;
    const id = crypto.randomUUID(), payload = new Uint8Array([0, 255, 17]);
    const stamp = new Date("2026-01-01T00:00:00Z");
    phase = "driver parameter binding";
    const result = await tx`INSERT INTO pg18_driver_probe VALUES
      (${id}, ${JSON.stringify({ pg18: true })}::jsonb, ${payload}, ${stamp}) RETURNING *`;
    const row = result[0];
    // Match the application's existing string/object JSON normalization.
    const document = typeof row.document === "string" ? JSON.parse(row.document) : row.document;
    const checks = { uuid: row.id === id, json: document?.pg18 === true,
      bytes: Buffer.from(row.payload).equals(Buffer.from(payload)),
      timestamp: new Date(row.stamp).getTime() === stamp.getTime() };
    const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    const kind = await tx`SELECT jsonb_typeof(document) AS kind FROM pg18_driver_probe`;
    jsonTransport = typeof row.document + "/" + kind[0].kind;
    phase = "driver comparison " + failed.join(",") + " (synthetic JSON client=" + typeof row.document + ", storage=" + kind[0].kind + ")";
    if (failed.length) throw new Error("Driver type roundtrip failed");
  });
  let checked = 0, preparedChecked = 0;
  phase = "retained key verification";
  if (role === "provider") {
    const { P256Keypair } = await import("@atproto/crypto");
    const { KeyEncryptor } = await import("../../src/identity/key-encryption.js");
    const { importEd25519PrivateKey } = await import("../../src/identity/keys.js");
    const { ed25519PublicKeyFromDidKey } = await import("../../src/identity/did-key.js");
    const { OnboardingRepository } = await import("../../src/onboarding/repository.js");
    const encryptor = new KeyEncryptor(process.env.KEY_ENCRYPTION_KEY ?? "");
    const repository = new OnboardingRepository(db.sql);
    const entries = await db.sql`SELECT account_id, role FROM account_keys ORDER BY account_id, role`;
    if (!entries.length) throw new Error("No retained operational keys to verify");
    async function verifyKey(id: string, key: StoredAccountKey) {
      const secret = await encryptor.decrypt(id, key.role, key.algorithm, key.publicKey, key);
      try {
        if (key.algorithm === "p256") {
          if ((await P256Keypair.import(secret)).did() !== key.publicKey) throw new Error("Rotation-key mismatch");
        } else if (key.algorithm === "ed25519") {
          const challenge = crypto.getRandomValues(new Uint8Array(32));
          const signature = await crypto.subtle.sign("Ed25519", await importEd25519PrivateKey(secret), challenge);
          if (!await crypto.subtle.verify("Ed25519", await ed25519PublicKeyFromDidKey(key.publicKey), signature, challenge)) {
            throw new Error("Identity/messaging-key mismatch");
          }
        } else throw new Error("Unsupported retained key algorithm");
      } finally { secret.fill(0); }
    }
    for (const entry of entries) {
      await verifyKey(entry.account_id, await repository.getKey(entry.account_id, entry.role));
      checked++;
    }
    const prepared = await db.sql`SELECT * FROM prepared_migration_target_keys ORDER BY transfer_id`;
    for (const row of prepared) {
      for (const [prefix, role, algorithm] of [["rotation", "plc-rotation", "p256"],
        ["messaging", "hail-messaging", "ed25519"], ["identity", "hail-identity", "ed25519"]] as const) {
        if (prefix === "identity" && row.custody_profile !== "managed") continue;
        await verifyKey(row.transfer_id, { role, algorithm, publicKey: row[prefix + "_public_key"],
          ciphertext: row[prefix + "_private_ciphertext"], nonce: row[prefix + "_nonce"],
          encryptionVersion: 1, kekId: "poc-v1" });
        preparedChecked++;
      }
    }
  }
  console.log(JSON.stringify({ role, application_schema: "matches", driver_roundtrip: true,
    json_transport: jsonTransport, account_keys_decrypted: checked, prepared_keys_decrypted: preparedChecked,
    private_public_key_pairs_verified: checked + preparedChecked }));
} catch {
  console.error("Restored-copy compatibility check failed during " + phase + "; private diagnostics withheld");
  process.exitCode = 1;
} finally { await db.close(); }
