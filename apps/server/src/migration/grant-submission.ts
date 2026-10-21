import { decodeDeterministic } from "@hailproto/codec";
import type { SQL } from "bun";
import type { KeyEncryptor } from "../identity/key-encryption.js";
import { importEd25519PrivateKey } from "../identity/keys.js";
import type { OnboardingRepository } from "../onboarding/repository.js";
import type { HailDidResolver } from "../plc/resolver.js";
import { TransferInvitationService, verifyHandshake, type SignedHandshake } from "./handshake.js";
import type { TransferInvitationDelivery } from "./invitation-delivery.js";
import type { TransferRateLimit } from "./rate-limit.js";

export class TransferGrantSubmission {
  constructor(private readonly sql: SQL, private readonly resolver: HailDidResolver,
    private readonly sourceBase: string,
    private readonly accounts: Pick<OnboardingRepository, "getKey">,
    private readonly encryptor: KeyEncryptor,
    private readonly invitations: TransferInvitationService,
    private readonly delivery: Pick<TransferInvitationDelivery, "deliver">,
    private readonly rateLimit?: TransferRateLimit) {}

  async submit(signed: SignedHandshake): Promise<SignedHandshake | null> {
    if (signed.payloadBytes.length < 1 || signed.payloadBytes.length > 4096) {
      throw new Error("Transfer grant exceeds its limit");
    }
    const raw: unknown = decodeDeterministic(signed.payloadBytes);
    if (!raw || typeof raw !== "object" || !("did" in raw) ||
      typeof raw.did !== "string" || !/^did:plc:[a-z2-7]{24}$/.test(raw.did)) {
      throw new Error("Transfer grant has no canonical DID");
    }
    const state = await this.resolver.resolve(raw.did);
    if (state.did !== raw.did || state.serviceBase !== this.sourceBase) {
      throw new Error("This server is not the current provider for the DID");
    }
    const grant = await verifyHandshake(signed, "hail.transfer-grant", state.identityDidKey);
    const now = Math.floor(Date.now() / 1000);
    if (grant.source_service_base !== this.sourceBase || grant.expires_at <= now ||
      grant.issued_at > now + 300) throw new Error("Transfer grant is stale or for another provider");
    if (this.rateLimit && !await this.rateLimit.admitAuthenticated("grant", grant.did)) {
      throw new Error("Transfer grant submission is rate limited");
    }
    const accounts = await this.sql<{ id: string }[]>`
      SELECT id FROM provider_accounts WHERE did = ${grant.did} AND onboarding_state = 'active'`;
    if (!accounts[0]) throw new Error("No active source account");
    const key = await this.accounts.getKey(accounts[0].id, "hail-messaging");
    if (key.publicKey !== state.messagingDidKey || key.algorithm !== "ed25519") {
      throw new Error("Source operational key is no longer current");
    }
    const bytes = await this.encryptor.decrypt(accounts[0].id, key.role, key.algorithm, key.publicKey, key);
    try { await this.invitations.issue(signed, await importEd25519PrivateKey(bytes)); }
    finally { bytes.fill(0); }
    try { return await this.delivery.deliver(grant.did); }
    catch { return null; } // The durable invitation worker resumes after timeout/ambiguous result.
  }
}
