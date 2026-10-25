import {createHash,timingSafeEqual} from "node:crypto";
import type {SQL} from "bun";
import {createWebCryptoVerifier,decodeBase64Url,encodeBase64Url,verifySignedPayload} from "@hailproto/codec";
import type {DiscoveryFetch,NetworkTargetValidator} from "../discovery/verifier.js";
import {parseJsonWithoutDuplicateKeys} from "../discovery/strict-json.js";
import {canonicalizeHailServiceBase,type HailDidResolver} from "../plc/resolver.js";
import {requireFreshPublicAuthority} from "../plc/authority.js";
import {ed25519PublicKeyFromDidKey} from "../identity/did-key.js";

// All network destinations come from current PLC, never a QR URL or caller-supplied host.
export class RemoteConnectionReview {
  constructor(private readonly sql:SQL,private readonly resolver:HailDidResolver,private readonly fetch:DiscoveryFetch,
    private readonly validateTarget:NetworkTargetValidator,private readonly localBase:string){}
  async exchange(did:string,step:"invitations/review"|"state"|"admit"|"commit"|"disconnect"|"sync"|"handover"|"handover-freeze"|"handover-abort"|"handover-commit"|"handover-complete",input:unknown){
    const state=await this.resolver.resolve(did),base=canonicalizeHailServiceBase(state.serviceBase);
    if(state.did!==did||base===this.localBase)throw new Error("Remote provider differs from current authority");
    await requireFreshPublicAuthority(this.sql,state.evidence,{did,serviceBase:base},new Date());
    const url=new URL(base+"/connections/"+step);await this.validateTarget(url);
    const body=JSON.stringify(input);if(new TextEncoder().encode(body).length>131072)throw new Error("Connection request exceeds limit");
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{
      const response=await this.fetch(new Request(url,{method:"POST",redirect:"error",signal:controller.signal,
        headers:{"Content-Type":"application/json","Cache-Control":"no-store"},body}));
      if(response.status!==200||response.headers.get("content-type")!=="application/json"||response.headers.has("content-encoding")||response.headers.has("location")){
        await response.body?.cancel();throw new RemoteConnectionError(response.status);
      }
      const reader=response.body?.getReader();if(!reader)throw new Error("Missing remote proof");
      const chunks:Uint8Array[]=[];let size=0;
      while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>131072){await reader.cancel();throw new Error("Remote proof exceeds limit");}chunks.push(next.value);}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      const wire=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as Record<string,unknown>;
      if(!wire||typeof wire!=="object"||Array.isArray(wire))throw new Error("Invalid remote wire object");
      await requireFreshPublicAuthority(this.sql,state.evidence,{did,serviceBase:base},new Date());
      return {wire,state};
    }finally{clearTimeout(timer);controller.abort();}
  }
  async proof(input:{id:string;did:string;token:string}){
    if(typeof input.id!=="string"||typeof input.did!=="string"||typeof input.token!=="string"||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(input.id)||!/^did:plc:[a-z2-7]{24}$/.test(input.did)||!/^[A-Za-z0-9_-]{43}$/.test(input.token))throw new Error("Invalid remote invitation");
    const {wire,state}=await this.exchange(input.did,"invitations/review",input),base=state.serviceBase;
      if(Object.keys(wire).sort().join(",")!==(wire.federation===1?"binding,federation,invitation,type,version":"binding,invitation,type,version")||wire.type!=="hail.connection-review"||wire.version!==1||
        typeof wire.invitation!=="string"||wire.invitation.length>21846||typeof wire.binding!=="string"||wire.binding.length>21846)throw new Error("Invalid remote proof fields");
      const verifier=createWebCryptoVerifier(async kid=>{if(kid!==input.did+"#hail-identity")throw new Error("Wrong remote signer");return ed25519PublicKeyFromDidKey(state.identityDidKey);});
      const invitationBytes=decodeBase64Url(wire.invitation),bindingBytes=decodeBase64Url(wire.binding);
      if(invitationBytes.length>16384||bindingBytes.length>16384)throw new Error("Remote signed object exceeds limit");
      if(encodeBase64Url(invitationBytes)!==wire.invitation||encodeBase64Url(bindingBytes)!==wire.binding||encodeBase64Url(decodeBase64Url(input.token,32))!==input.token)throw new Error("Noncanonical remote proof");
      const invitation=(await verifySignedPayload("hail.connection-invitation",invitationBytes,verifier)).payload;
      const binding=(await verifySignedPayload("hail.address-binding",bindingBytes,verifier)).payload;
      const tokenHash=createHash("sha256").update(decodeBase64Url(input.token,32)).digest(),now=Math.floor(Date.now()/1000);
      if(invitation.from!==input.did||invitation.invitation_id!==input.id||invitation.issued_at>now+300||
        invitation.expires_at!==null&&invitation.expires_at<=now||!timingSafeEqual(tokenHash,invitation.token_hash.value)||
        binding.did!==input.did||binding.issued_at>now+300||binding.expires_at<=now)throw new Error("Remote invitation identity, token or expiry differs");
      await requireFreshPublicAuthority(this.sql,state.evidence,{did:input.did,role:"hail-identity",key:state.identityDidKey,serviceBase:base},new Date());
      return {id:input.id,did:input.did,address:binding.address,expiresAt:invitation.expires_at,provider:base,preview:true as const,
        admissionSupported:wire.federation===1,invitationBytes,bindingBytes,identityKey:state.identityDidKey};
  }
  async review(input:{id:string;did:string;token:string}){
    const {invitationBytes,bindingBytes,identityKey,...review}=await this.proof(input);return review;
  }
}
export class RemoteConnectionError extends Error {constructor(readonly status:number){super("Remote provider did not return a supported connection response");}}
