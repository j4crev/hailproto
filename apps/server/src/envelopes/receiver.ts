import { createHash } from "node:crypto";
import { createWebCryptoVerifier, inspectSignedPayload, verifySignedPayload } from "@racrproto/codec";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import type { AccountRecord } from "../onboarding/repository.js";
import type { HailDidResolver } from "../plc/resolver.js";
import type { EnvelopeRepository, EnvelopeOutcome } from "./repository.js";
import type {ConnectionMessagingAuthority} from "../accounts/connection-authorization.js";

export interface EnvelopeAccounts { getAccountByDid(did: string): Promise<AccountRecord | null>; }

export class EnvelopeReceiver {
  constructor(
    private readonly accounts: EnvelopeAccounts,
    private readonly store: Pick<EnvelopeRepository, "candidate" | "accept">,
    private readonly resolver: HailDidResolver,
    private readonly serviceBase: string,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly connections?:Pick<ConnectionMessagingAuthority,"live">,
  ) {}

  async receive(representation: Uint8Array, signal?: AbortSignal): Promise<EnvelopeOutcome | "ignored"> {
    try {
      signal?.throwIfAborted();
      const inspected = inspectSignedPayload("hail.envelope", representation);
      const payload = inspected.payload;
      if (payload.from === payload.to ||
        payload.created_at > this.now() + 300 || representation.length > 16_384) return "ignored";
      signal?.throwIfAborted();
      const sender = await (this.resolver.resolveForAuthentication?.(payload.from) ?? this.resolver.resolve(payload.from));
      signal?.throwIfAborted();
      const verified = await verifySignedPayload(
        "hail.envelope", representation,
        createWebCryptoVerifier(async (keyId) => {
          if (keyId !== `${payload.from}#hail-messaging`) throw new Error("Wrong envelope key role");
          return ed25519PublicKeyFromDidKey(sender.messagingDidKey);
        }),
      );
      signal?.throwIfAborted();
      // Authenticate before consulting protected relationships. Invalid signatures
      // must perform the same public-key work regardless of candidate existence.
      if (!await this.store.candidate(payload.authorization, payload.from, payload.to,payload)) return "ignored";
      signal?.throwIfAborted();
      let conversationDescriptor;
      if(payload.authorization.type==='conversation'&&payload.conversation_introduction){
        const intro=payload.conversation_introduction,authorization=payload.authorization;
        conversationDescriptor=await verifySignedPayload('hail.conversation',intro.descriptor,createWebCryptoVerifier(async kid=>{
          if(kid!==payload.from+'#hail-messaging')throw new Error('Wrong conversation creator');
          return ed25519PublicKeyFromDidKey(sender.messagingDidKey);
        }));
        const d=conversationDescriptor.payload;
        if(d.from!==authorization.creator||d.conversation_id!==authorization.conversation_id||!d.participants.includes(payload.to)||
          d.created_at>payload.created_at+300||!this.connections||!await this.connections.live(payload.to,payload.from,{type:'connection',connection_id:intro.connection_id,epoch:intro.epoch}))return 'ignored';
      }
      const recipient = await (this.resolver.resolveForAuthentication?.(payload.to) ?? this.resolver.resolve(payload.to));
      signal?.throwIfAborted();
      if (recipient.serviceBase !== this.serviceBase) return "ignored";
      const account = await this.accounts.getAccountByDid(payload.to);
      signal?.throwIfAborted();
      if (!account || account.state !== "active" || account.activationVerificationMode !== "public") return "ignored";
      return await this.store.accept({
        payload,
        retainAuthority: async tx => {
          // Stable order avoids cross-delivery DID lock inversion.
          for (const resolved of [sender,recipient].sort((a,b)=>a.did.localeCompare(b.did)))
            await this.resolver.retainAuthenticatedResolution?.(resolved,tx);
        },
        representation,
        payloadDigest: new Uint8Array(createHash("sha256").update(verified.payloadBytes).digest()),
        envelopeDigest: new Uint8Array(createHash("sha256").update(verified.payloadBytes).digest()),
        localAccountId: account.id,
        signingPublicKey: sender.messagingDidKey,
        evidence: sender.evidence,
        recipientEvidence: recipient.evidence,
        recipientServiceBase: this.serviceBase,
        now: this.now(),
        ...(conversationDescriptor?{conversationDescriptor}:{}),
      }, signal);
    } catch {
      return "ignored";
    }
  }
}
