import { def } from "@did-plc/lib";
import { decodeDeterministic } from "@hailproto/codec";
import type { SQL } from "bun";
import type { DiscoveryFetch,NetworkTargetValidator } from "../discovery/verifier.js";
import type { HailDidResolver } from "../plc/resolver.js";
import { managedHandshakeDigest,verifyManagedOwnerHandshake,verifyManagedProviderHandshake,
  type ManagedTransferGrant,type SignedManagedHandshake } from "./managed-handshake.js";
import {boundedTransferBody,managedInvitationWire,MAX_TRANSFER_WIRE_BYTES,parseRequestWire,requestWire,
  TRANSFER_MEDIA_TYPE} from "./wire.js";

const same=(a:Uint8Array,b:Uint8Array)=>Buffer.from(a).equals(Buffer.from(b));
interface SourceRow {custody_profile:"portable"|"managed";owner_recovery_public_key:string|null;
  destination_service_base:string;expires_at:Date;grant_bytes:Uint8Array;grant_signature:Uint8Array;
  invitation_bytes:Uint8Array;invitation_signature:Uint8Array;consumed_transfer_id:string|null;
  origin_request_bytes:Uint8Array|null;origin_request_signature:Uint8Array|null;cancelled_at:Date|null;}

export class ManagedTransferDelivery {
  constructor(private readonly sql:SQL,private readonly resolver:HailDidResolver,private readonly sourceBase:string,
    private readonly fetch:DiscoveryFetch,private readonly validateTarget:NetworkTargetValidator) {}

  async deliver(did:string):Promise<SignedManagedHandshake> {
    if(!/^did:plc:[a-z2-7]{24}$/.test(did))throw new Error("Invalid managed transfer DID");
    const state=await this.resolver.resolve(did),data=def.documentData.parse(state.evidence.data);
    const row=(await this.sql<SourceRow[]>`SELECT custody_profile,owner_recovery_public_key,destination_service_base,
      expires_at,grant_bytes,grant_signature,invitation_bytes,invitation_signature,consumed_transfer_id,
      origin_request_bytes,origin_request_signature,cancelled_at FROM provider_transfer_authorizations WHERE did=${did}`)[0];
    if(!row||row.custody_profile!=="managed"||!row.owner_recovery_public_key||row.cancelled_at||
      row.expires_at.getTime()<=Date.now()||state.did!==did||state.serviceBase!==this.sourceBase||
      !state.evidence.verification||data.rotationKeys[0]!==row.owner_recovery_public_key)
      throw new Error("Managed transfer authorization is absent, stale, or no longer current");
    const grantSigned={payloadBytes:new Uint8Array(row.grant_bytes),signature:new Uint8Array(row.grant_signature)};
    const acknowledgementSigned={payloadBytes:new Uint8Array(row.invitation_bytes),signature:new Uint8Array(row.invitation_signature)};
    const grant=await verifyManagedOwnerHandshake(grantSigned,"hail.managed-transfer-grant",row.owner_recovery_public_key);
    const acknowledgement=await verifyManagedProviderHandshake(acknowledgementSigned,
      "hail.managed-transfer-acknowledgement",state.messagingDidKey);
    const grantDigest=managedHandshakeDigest(grantSigned.payloadBytes),acknowledgementDigest=managedHandshakeDigest(acknowledgementSigned.payloadBytes);
    if(grant.did!==did||grant.source_identity_key!==state.identityDidKey||grant.source_service_base!==this.sourceBase||
      grant.destination_service_base!==row.destination_service_base||grant.expires_at!==Math.floor(row.expires_at.getTime()/1000)||
      acknowledgement.did!==did||acknowledgement.nonce!==grant.nonce||acknowledgement.source_service_base!==this.sourceBase||
      acknowledgement.destination_service_base!==grant.destination_service_base||acknowledgement.expires_at!==grant.expires_at||
      !same(acknowledgement.grant_digest,grantDigest))throw new Error("Stored managed acknowledgement does not match its owner grant");
    if(row.origin_request_bytes&&row.origin_request_signature) {
      const prior={payloadBytes:new Uint8Array(row.origin_request_bytes),signature:new Uint8Array(row.origin_request_signature)};
      await this.verifyOffer(prior,grant,grantDigest,acknowledgementDigest,
        [state.identityDidKey,state.messagingDidKey,...data.rotationKeys]);
      return prior;
    }
    if(row.consumed_transfer_id)throw new Error("Managed transfer authorization was already consumed");
    const url=new URL(`https://${grant.destination_domain}/.well-known/hail/transfers/managed-invitations`);
    await this.validateTarget(url);
    const body=managedInvitationWire(grantSigned,acknowledgementSigned);
    if(body.length>MAX_TRANSFER_WIRE_BYTES)throw new Error("Managed invitation wire body exceeds limit");
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error("Managed invitation timed out")),10_000);
    try {
      const response=await this.fetch(new Request(url,{method:"POST",body:Uint8Array.from(body),signal:controller.signal,
        headers:{"Content-Type":TRANSFER_MEDIA_TYPE,"Cache-Control":"no-store","Accept-Encoding":"identity"},redirect:"manual"}));
      if(response.status!==200||response.headers.get("content-type")!==TRANSFER_MEDIA_TYPE||response.headers.has("content-encoding")||
        response.headers.has("location")||response.redirected){await response.body?.cancel().catch(()=>{});throw new Error("Destination did not acknowledge managed invitation");}
      const offerSigned=parseRequestWire(await boundedTransferBody(response.body,response.headers.get("content-length")));
      const offer=await this.verifyOffer(offerSigned,grant,grantDigest,acknowledgementDigest,
        [state.identityDidKey,state.messagingDidKey,...data.rotationKeys]);
      await this.sql.begin(async tx=>{
        const current=(await tx<SourceRow[]>`SELECT custody_profile,owner_recovery_public_key,destination_service_base,
          expires_at,grant_bytes,grant_signature,invitation_bytes,invitation_signature,consumed_transfer_id,
          origin_request_bytes,origin_request_signature,cancelled_at FROM provider_transfer_authorizations WHERE did=${did} FOR UPDATE`)[0];
        if(!current||current.custody_profile!=="managed"||current.cancelled_at||current.consumed_transfer_id&&current.consumed_transfer_id!==offer.transfer_id||
          !same(current.grant_bytes,grantSigned.payloadBytes)||!same(current.grant_signature,grantSigned.signature)||
          !same(current.invitation_bytes,acknowledgementSigned.payloadBytes)||!same(current.invitation_signature,acknowledgementSigned.signature))
          throw new Error("Managed authorization changed during destination delivery");
        if(current.origin_request_bytes||current.origin_request_signature) {
          if(!current.origin_request_bytes||!current.origin_request_signature||!same(current.origin_request_bytes,offerSigned.payloadBytes)||
            !same(current.origin_request_signature,offerSigned.signature))throw new Error("Conflicting managed destination Offers");
          return;
        }
        await tx`UPDATE provider_transfer_authorizations SET origin_request_bytes=${offerSigned.payloadBytes},
          origin_request_signature=${offerSigned.signature},origin_confirmed_at=clock_timestamp() WHERE did=${did}`;
      });
      return offerSigned;
    } finally {clearTimeout(timer);controller.abort();}
  }

  private async verifyOffer(signed:SignedManagedHandshake,grant:ManagedTransferGrant,grantDigest:Uint8Array,
    acknowledgementDigest:Uint8Array,sourceKeys:string[]) {
    const raw=decodeDeterministic(signed.payloadBytes) as Record<string,unknown>;
    if(!raw||typeof raw.destination_messaging_key!=="string")throw new Error("Managed Offer lacks a destination messaging key");
    const offer=await verifyManagedProviderHandshake(signed,"hail.managed-transfer-offer",raw.destination_messaging_key);
    const now=Math.floor(Date.now()/1000);
    const destinationKeys=[offer.destination_rotation_key,offer.destination_identity_key,offer.destination_messaging_key];
    if(destinationKeys.some(key=>sourceKeys.includes(key))||offer.did!==grant.did||offer.nonce!==grant.nonce||offer.source_service_base!==grant.source_service_base||
      offer.destination_service_base!==grant.destination_service_base||offer.issued_at>now+300||offer.expires_at<=now||
      offer.expires_at>grant.expires_at||!same(offer.grant_digest,grantDigest)||
      !same(offer.acknowledgement_digest,acknowledgementDigest))throw new Error("Managed Offer does not bind the admitted source artifacts");
    return offer;
  }
}
