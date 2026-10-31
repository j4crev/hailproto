import { randomUUID } from "node:crypto";
import { parseDidKey, P256_JWT_ALG, SECP256K1_JWT_ALG } from "@atproto/crypto";
import type { SQL } from "bun";
import { canonicalizeHailAddress } from "../identity/address.js";

// A public key permits preparation only; activation still requires the owner's
// signed genesis, backup confirmation, monitor evidence and normal verification.
export async function providerRoleAccountId(sql: SQL, address: string, recoveryKey: string): Promise<string | undefined> {
  const role = (await sql<{ account_id: string | null; owner_recovery_public_key: string | null }[]>`
    SELECT claim.account_id, claim.owner_recovery_public_key FROM provider_reserved_names reserved
    LEFT JOIN provider_role_claims claim ON claim.canonical_address = ${address}
    WHERE reserved.local_part = split_part(${address}, '@', 1)`)[0];
  if (!role) return undefined;
  if (!role.account_id || role.owner_recovery_public_key !== recoveryKey) {
    throw new Error("Address is reserved for the provider operator");
  }
  return role.account_id;
}

export async function authorizeProviderRole(sql: SQL, addressInput: string, recoveryKey: string, origin: string): Promise<string> {
  const address = canonicalizeHailAddress(addressInput);
  if (address.split("@")[1] !== new URL(origin).hostname) throw new Error("Role address must belong to this provider");
  if (![P256_JWT_ALG, SECP256K1_JWT_ALG].includes(parseDidKey(recoveryKey).jwtAlg)) {
    throw new Error("Use the owner's recovery public did:key, not an identity or private key");
  }
  return sql.begin(async tx => {
    const reserved = await tx`SELECT local_part FROM provider_reserved_names WHERE local_part = split_part(${address}, '@', 1)`;
    if (!reserved.length) throw new Error("Address is not a reserved provider role");
    const existing = (await tx<{ account_id: string; owner_recovery_public_key: string }[]>`
      SELECT account_id, owner_recovery_public_key FROM provider_role_claims WHERE canonical_address = ${address}`)[0];
    if (existing) {
      if (existing.owner_recovery_public_key !== recoveryKey) throw new Error("Role address is already assigned to another recovery key");
      return existing.account_id;
    }
    if ((await tx`SELECT id FROM provider_accounts WHERE canonical_address = ${address} AND address_released_at IS NULL`).length) {
      throw new Error("Existing account occupies this role address; review ownership manually (no account was changed)");
    }
    const accountId = randomUUID();
    await tx`INSERT INTO provider_role_claims (canonical_address, account_id, owner_recovery_public_key)
      VALUES (${address}, ${accountId}, ${recoveryKey})`;
    return accountId;
  });
}
