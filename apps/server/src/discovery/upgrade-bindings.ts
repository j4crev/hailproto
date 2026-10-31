import { createHash, randomUUID } from "node:crypto";
import type { SQL } from "bun";
import { createWebCryptoSigner, createWebCryptoVerifier, signPayload, verifySignedPayload, type HailAddressBinding } from "@hailproto/codec";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import { importEd25519PrivateKey } from "../identity/keys.js";
import type { KeyEncryptor } from "../identity/key-encryption.js";
import { OnboardingRepository } from "../onboarding/repository.js";
import type { HailDidResolver, PlcResolutionEvidence } from "../plc/resolver.js";
import { retainPublicSigningAuthority } from "../plc/signing-authority.js";
import { assertPublicAuthorityFresh } from "../plc/authority.js";
import { providerDiscoveryForOrigin, type ProviderDiscovery } from "./delegation.js";

/** One-time alpha conversion of previously validated database records, not a
 * legacy wire-format reader. All publications change in one transaction. The
 * old signed bytes and metadata remain untouched for private audit purposes.
 */
export async function upgradeAddressBindings(sql: SQL, resolver: HailDidResolver,
  encryptor: KeyEncryptor, origin: string,
  options: { enabled: boolean; withdrawOwners: readonly string[] },
  discover: ProviderDiscovery = providerDiscoveryForOrigin(origin)) {
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(733120090)`;
    const accounts = await tx<{
      id: string; canonical_address: string; did: string; onboarding_state: string;
      managed_key: string | null; fence_state: string | null;
    }[]>`SELECT a.id,a.canonical_address,a.did,a.onboarding_state,
        m.provider_identity_public_key AS managed_key,f.state AS fence_state
      FROM provider_accounts a
      LEFT JOIN managed_custody_evidence m ON m.account_id=a.id
      LEFT JOIN provider_migration_fences f ON f.account_id=a.id
      WHERE EXISTS (SELECT 1 FROM address_bindings b WHERE b.account_id=a.id
        AND b.selected_at IS NOT NULL AND b.expires_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM address_binding_withdrawals w WHERE w.binding_id=b.id))
      ORDER BY a.id FOR UPDATE OF a`;
    if (!accounts.length) return { upgraded: 0, withdrawnOwners: 0 };
    if (!options.enabled) throw new Error("Legacy address bindings require the explicit v2 upgrade before startup");
    // Refuse the whole operation before signing if any account needs owner input.
    for (const account of accounts) {
      if (account.onboarding_state !== "active" || account.fence_state)
        throw new Error(`Binding upgrade requires completed onboarding and no migration: ${account.canonical_address}`);
      if (!account.managed_key && !options.withdrawOwners.includes(account.canonical_address))
        throw new Error(`Binding upgrade requires an owner signature or explicit withdrawal: ${account.canonical_address}`);
    }
    let upgraded = 0, withdrawnOwners = 0;
    const evidence: PlcResolutionEvidence[] = [];
    const repository = new OnboardingRepository(tx);
    for (const account of accounts) {
      const current = (await tx<{ id: string; issued_at: Date; expires_at: Date | null }[]>`
        SELECT id,issued_at,expires_at FROM address_bindings
        WHERE account_id=${account.id} AND selected_at IS NOT NULL
        ORDER BY selected_at DESC,id DESC LIMIT 1`)[0]!;
      if (current.expires_at === null) continue;
      if (account.managed_key) {
        const domain = account.canonical_address.split("@")[1]!;
        const host = new URL(origin).hostname;
        if (domain !== host && await discover(domain, AbortSignal.timeout(10_000)) !== host)
          throw new Error(`Custom domain no longer delegates to this provider: ${domain}`);
        const resolved = await resolver.resolve(account.did);
        const identity = await repository.getKey(account.id, "hail-identity");
        const messaging = await repository.getKey(account.id, "hail-messaging");
        if (resolved.did !== account.did || resolved.serviceBase !== `${origin}/hail` ||
          resolved.identityDidKey !== account.managed_key || identity.publicKey !== account.managed_key ||
          resolved.messagingDidKey !== messaging.publicKey)
          throw new Error(`Current PLC authority differs for ${account.canonical_address}`);
        const now = Math.floor(Date.now() / 1000);
        const issued = Math.max(now, Math.floor(current.issued_at.getTime() / 1000) + 1);
        if (issued > now + 300) throw new Error("Stored binding issuance is too far in the future");
        const payload: HailAddressBinding = { type: "hail.address-binding", version: 2,
          address: account.canonical_address, did: account.did, issued_at: issued,
          key_id: `${account.did}#hail-identity` };
        const secret = await encryptor.decrypt(account.id, identity.role, identity.algorithm, identity.publicKey, identity);
        let cose: Uint8Array;
        try { cose = await signPayload("hail.address-binding", payload,
          createWebCryptoSigner(payload.key_id, await importEd25519PrivateKey(secret))); }
        finally { secret.fill(0); }
        await verifySignedPayload("hail.address-binding", cose,
          createWebCryptoVerifier(async () => ed25519PublicKeyFromDidKey(resolved.identityDidKey)));
        await tx`UPDATE address_bindings SET selected_at=NULL WHERE account_id=${account.id} AND selected_at IS NOT NULL`;
        await tx`INSERT INTO address_bindings(id,account_id,canonical_address,did,cose,representation_digest,issued_at,hosted_at,selected_at,published_at)
          VALUES (${randomUUID()},${account.id},${account.canonical_address},${account.did},${cose},
            ${new Uint8Array(createHash("sha256").update(cose).digest())},${new Date(issued*1000)},clock_timestamp(),clock_timestamp(),clock_timestamp())`;
        await retainPublicSigningAuthority(tx, { actionType: "address-binding", localAccountId: account.id,
          did: account.did, role: "hail-identity", key: resolved.identityDidKey, serviceBase: resolved.serviceBase,
          representation: cose, evidence: resolved.evidence });
        evidence.push(resolved.evidence);
        upgraded++;
      } else {
        // Explicitly approved publication withdrawal, not account deletion.
        withdrawnOwners++;
      }
      await tx`INSERT INTO address_binding_withdrawals(binding_id,reason)
        SELECT id,'replacement' FROM address_bindings WHERE account_id=${account.id} AND expires_at IS NOT NULL
        ON CONFLICT DO NOTHING`;
    }
    for (const retained of evidence) assertPublicAuthorityFresh(retained, new Date());
    return { upgraded, withdrawnOwners };
  });
}
