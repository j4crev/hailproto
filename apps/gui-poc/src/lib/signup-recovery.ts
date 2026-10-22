import { decodeBase64Url, encodeBase64Url } from "@hailproto/codec/base64url";
import { createUserVault, verifyUserVault, type UserVaultFile } from "../../../cli/src/vault-crypto.js";
import { cipher, unseal } from "../../../cli/src/vault-crypto.js";
import { signReviewedManagedGenesis } from "../../../cli/src/managed-genesis.js";
import { P256Keypair } from "@atproto/crypto";
import type { PublicOnboardingPreparation } from "../../../server/src/onboarding/public.js";

export { encodeBase64Url };
export type { UserVaultFile };
const MAX_BACKUP_BYTES = 16_384;

// Only unfinished signup backups are accepted here, not account recovery imports.
export async function verifySignupBackup(text: string, secretText: string, expected: UserVaultFile): Promise<void> {
  if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES || secretText.length !== 43) {
    throw new Error("Choose the saved signup backup and its separate 43-character recovery secret.");
  }
  const vault: UserVaultFile = JSON.parse(text);
  if (vault?.did !== null || expected.did !== null || vault.createdAt !== expected.createdAt ||
    vault.recovery?.publicDidKey !== expected.recovery.publicDidKey ||
    vault.identity?.publicDidKey !== expected.identity.publicDidKey) {
    throw new Error("This backup belongs to a different signup.");
  }
  const secret = decodeBase64Url(secretText, 32);
  try { await verifyUserVault(vault, secret); }
  finally { secret.fill(0); }
}

export async function createSignupBackup() {
  if (!globalThis.crypto?.subtle) throw new Error("A secure browser context with Web Crypto is required.");
  return createUserVault();
}

export async function signSignupGenesis(vault: UserVaultFile, secret: Uint8Array,
  prepared: PublicOnboardingPreparation, expected: { provider: string; address: string; monitorOrigin: string; monitorKey: string }) {
  const provider = new URL(expected.provider);
  if (provider.protocol !== "https:" || provider.origin !== expected.provider ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(prepared.accountId) ||
    prepared.address !== expected.address.toLowerCase() || !prepared.address.endsWith(`@${provider.hostname}`) ||
    prepared.custodyProfile !== "managed" || prepared.managedProfileVersion !== "hail-managed-custody-v1" ||
    prepared.monitorAssurance !== "reduced-assurance-alpha-v1" || prepared.monitorOrigin !== expected.monitorOrigin ||
    prepared.monitorPublicKey !== expected.monitorKey || prepared.userRecoveryKey !== vault.recovery.publicDidKey ||
    prepared.sourceServiceBase !== `${expected.provider}/hail`) {
    throw new Error("Signup preparation differs from the selected provider, address, custody or monitor.");
  }
  await verifyUserVault(vault, secret);
  const recoveryBytes = await unseal(await cipher(secret), vault.recovery, "user-recovery");
  try {
    const recovery = await P256Keypair.import(recoveryBytes);
    return await signReviewedManagedGenesis({ type: "plc_operation", prev: null,
      rotationKeys: [prepared.userRecoveryKey, prepared.providerRotationKey],
      verificationMethods: { "hail-identity": prepared.userIdentityKey, "hail-messaging": prepared.providerMessagingKey },
      alsoKnownAs: [], services: { hail: { type: "HailMessaging", endpoint: prepared.sourceServiceBase } } }, vault, recovery);
  } finally { recoveryBytes.fill(0); }
}
