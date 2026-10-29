import {decodeBase64Url,fromDiagnosticJson,createWebCryptoVerifier,verifySignedPayload} from "@hailproto/codec";
import {base58btc} from "multiformats/bases/base58";
import {privateFile,savePrivateBytes} from "./grant-revocation.js";
import {unlockUserIdentity,type UserVaultFile} from "./vault.js";
import {readRecoverySecret} from "./cli/private-input.js";

export async function signConnectionProposal(vaultPath:string,proposalPath:string,output:string,expectedProvider:string,showReview=true){
  const proposal=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(proposalPath,32768)));
  const origin=new URL(expectedProvider);
  if(origin.protocol!=="https:"||origin.origin!==expectedProvider||Object.keys(proposal).sort().join(",")!=="expiresAt,payload,provider,requestId,type,version"||
    proposal.type!=="hailp.connection-signing"||proposal.version!==1||proposal.provider!==expectedProvider||
    typeof proposal.requestId!=="string"||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(proposal.requestId)||
    typeof proposal.expiresAt!=="string"||!Number.isFinite(Date.parse(proposal.expiresAt))||Date.parse(proposal.expiresAt)<=Date.now()||Date.parse(proposal.expiresAt)>Date.now()+300000)
    throw new Error("Connection proposal must name the expected provider and one current short-lived approval");
  const type=proposal.payload?.type;
  if(type!=="hail.connection-invitation"&&type!=="hail.connection-confirmation")throw new Error("Only connection invitation/confirmation consent may be signed");
  const payload=fromDiagnosticJson(type,proposal.payload),now=Math.floor(Date.now()/1000);
  if(payload.issued_at>now+300||payload.expires_at!==null&&payload.expires_at<=now)throw new Error("Connection consent has expired or is dated in the future");
  // Public consent only. No admission token, unlocked key or vault is sent to a provider.
  if(showReview)console.error(JSON.stringify({provider:expectedProvider,requestId:proposal.requestId,consent:proposal.payload,
    warning:type==="hail.connection-invitation"?"Standing invitation: any authenticated holder may connect before expiry, without another approval.":"Explicit mutual connection consent, not a subscription."}));
  const secret=decodeBase64Url(await readRecoverySecret());
  try{
    const owner=await unlockUserIdentity(JSON.parse(new TextDecoder().decode(await privateFile(vaultPath,16384))) as UserVaultFile,secret);
    const signed=await owner.signConnectionConsent(payload);
    const publicBytes=base58btc.decode(owner.vault.identity.publicDidKey.slice(8));
    await verifySignedPayload(type,signed,createWebCryptoVerifier(async()=>crypto.subtle.importKey("raw",Uint8Array.from(publicBytes.slice(2)),"Ed25519",false,["verify"])));
    try{await savePrivateBytes(output,signed);}catch(error){
      if(!(error instanceof Error&&"code" in error&&error.code==="EEXIST")||!Buffer.from(await privateFile(output,16384)).equals(Buffer.from(signed)))throw error;
    }
    return {requestId:proposal.requestId,type,output};
  }finally{secret.fill(0);}
}
