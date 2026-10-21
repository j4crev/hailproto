import { createHash } from "node:crypto";
import { createWebCryptoVerifier, inspectSignedPayload, verifySignedPayload } from "@hailproto/codec";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import type { AccountRecord } from "../onboarding/repository.js";
import type { HailDidResolver } from "../plc/resolver.js";
import type { EnvelopeRepository, EnvelopeOutcome } from "./repository.js";

export interface EnvelopeAccounts { getAccountByDid(did: string): Promise<AccountRecord | null>; }

export class EnvelopeReceiver {
  constructor(
    private readonly accounts: EnvelopeAccounts,
    private readonly store: Pick<EnvelopeRepository, "candidate" | "accept">,
    private readonly resolver: HailDidResolver,
    private readonly serviceBase: string,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async receive(representation: Uint8Array, signal?: AbortSignal): Promise<EnvelopeOutcome | "ignored"> {
    try {
      signal?.throwIfAborted();
      const inspected = inspectSignedPayload("hail.envelope", representation);
      const payload = inspected.payload;
      if (payload.from === payload.to ||
        payload.created_at > this.now() + 300 || representation.length > 16_384) return "ignored";
      // The claimed fields are used only for a cheap preliminary lookup, never for a durable mutation.
      if (!await this.store.candidate(payload.authorization, payload.from, payload.to)) return "ignored";
      signal?.throwIfAborted();
      const sender = await this.resolver.resolve(payload.from);
      signal?.throwIfAborted();
      const verified = await verifySignedPayload(
        "hail.envelope", representation,
        createWebCryptoVerifier(async (keyId) => {
          if (keyId !== `${payload.from}#hail-messaging`) throw new Error("Wrong envelope key role");
          return ed25519PublicKeyFromDidKey(sender.messagingDidKey);
        }),
      );
      signal?.throwIfAborted();
      const recipient = await this.resolver.resolve(payload.to);
      signal?.throwIfAborted();
      if (recipient.serviceBase !== this.serviceBase) return "ignored";
      const account = await this.accounts.getAccountByDid(payload.to);
      signal?.throwIfAborted();
      if (!account || account.state !== "active" || account.activationVerificationMode !== "public") return "ignored";
      return await this.store.accept({
        payload,
        representation,
        payloadDigest: new Uint8Array(createHash("sha256").update(verified.payloadBytes).digest()),
        envelopeDigest: new Uint8Array(createHash("sha256").update(verified.payloadBytes).digest()),
        localAccountId: account.id,
        signingPublicKey: sender.messagingDidKey,
        evidence: sender.evidence,
        recipientEvidence: recipient.evidence,
        recipientServiceBase: this.serviceBase,
        now: this.now(),
      }, signal);
    } catch {
      return "ignored";
    }
  }
}
