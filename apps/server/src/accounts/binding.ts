import { createHash, randomUUID } from "node:crypto";
import { createWebCryptoSigner, createWebCryptoVerifier, decodeBase64Url, encodeBase64Url, inspectSignedPayload,
  signPayload, toDiagnosticJson, validatePayload, verifySignedPayload, type HailAddressBinding } from "@hailproto/codec";
import type { SQL } from "bun";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import { importEd25519PrivateKey } from "../identity/keys.js";
import type { KeyEncryptor } from "../identity/key-encryption.js";
import { OnboardingRepository } from "../onboarding/repository.js";
import type { HailDidResolver } from "../plc/resolver.js";
import { retainPublicSigningAuthority } from "../plc/signing-authority.js";
import type { AddressVerificationService } from "../onboarding/activation.js";
import type { AccountApiSession } from "./repository.js";

export class BindingError extends Error { constructor(readonly status:400|403|409,message:string){super(message);} }
interface Row {id:string;cose:Uint8Array;representation_digest:Uint8Array;selected_at:Date|null;published_at:Date|null;}
const equal=(a:Uint8Array,b:Uint8Array)=>Buffer.from(a).equals(Buffer.from(b));
export class AccountBinding {
  constructor(private readonly sql:SQL,private readonly resolver:HailDidResolver,private readonly encryptor:KeyEncryptor,private readonly origin:string,
    private readonly verifier:AddressVerificationService){}
  async show(session:AccountApiSession) {
    const rows=await this.sql<Row[]>`SELECT id,cose,representation_digest,selected_at,published_at FROM address_bindings
      WHERE account_id=${session.account_id} AND canonical_address=${session.canonical_address} AND did=${session.did}
        AND selected_at IS NOT NULL ORDER BY selected_at DESC,id DESC LIMIT 1`;
    if(!rows[0])throw new BindingError(409,"Account has no selected binding");return this.summary(rows[0]);
  }
  private summary(row:Row) {
    const binding=inspectSignedPayload("hail.address-binding",new Uint8Array(row.cose)).payload,now=Math.floor(Date.now()/1000);
    return {type:"hailp.address-binding",version:1,bindingId:row.id,cose:encodeBase64Url(row.cose),digest:encodeBase64Url(row.representation_digest),
      binding:toDiagnosticJson("hail.address-binding",binding),expiresAt:binding.expires_at,
      status:row.selected_at?(binding.expires_at<=now?"expired":"active"):"superseded",renewalDue:binding.expires_at-now<=7*86400};
  }
  private async writer(tx:SQL,session:AccountApiSession,key:string) {
    if(session.canonical_address.split("@")[1]!==new URL(this.origin).hostname)throw new BindingError(409,"Renewal currently requires a provider-domain address");
    const account=await tx`SELECT id FROM provider_accounts WHERE id=${session.account_id} AND did=${session.did}
      AND canonical_address=${session.canonical_address} AND onboarding_state='active' AND activation_verification_mode='public' FOR UPDATE`;
    if(!account.length||(await tx`SELECT did FROM provider_migration_fences WHERE account_id=${session.account_id}`).length)throw new BindingError(409,"Account cannot renew its address");
    const credential=await tx`SELECT id FROM account_api_credentials WHERE id=${session.credential_id} AND account_id=${session.account_id}
      AND revoked_at IS NULL AND expires_at>clock_timestamp() AND scopes ? 'account:write' FOR SHARE`;
    if(!credential.length)throw new BindingError(403,"Current credential cannot renew an address");
    const current=await this.resolver.resolve(session.did);
    const keys=await tx<{role:string;public_key:string}[]>`SELECT role,public_key FROM account_keys WHERE account_id=${session.account_id}`;
    if(current.did!==session.did||current.serviceBase!==`${this.origin}/hail`||current.identityDidKey!==key||
      !keys.some(k=>k.role==="hail-messaging"&&k.public_key===current.messagingDidKey))throw new BindingError(409,"Current signing/service authority differs");
    return {
      managed: (await tx`SELECT account_id FROM managed_custody_evidence WHERE account_id=${session.account_id}`).length === 1,
      resolved: current,
    };
  }
  async renew(session:AccountApiSession,input:Record<string,unknown>) {
    if(Object.keys(input).length!==3||typeof input.previous!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(input.previous)||
      typeof input.signingKey!=="string"||input.signingKey.length>256||Boolean(input.cose)===Boolean(input.payload)||
      Object.keys(input).some(k=>!["previous","signingKey","cose","payload"].includes(k)))throw new BindingError(400,"Invalid renewal request");
    const previous=decodeBase64Url(input.previous),signingKey=input.signingKey;
    if(encodeBase64Url(previous)!==input.previous)throw new BindingError(400,"Invalid predecessor digest");
    const staged=await this.sql.begin(async tx=>{
      const { managed }=await this.writer(tx,session,signingKey);
      let cose:Uint8Array;
      if(managed) {
        if(!input.payload||input.cose)throw new BindingError(400,"Managed renewal requires an explicit payload");
        validatePayload("hail.address-binding",input.payload);this.review(session,input.payload as HailAddressBinding);
        const key=await new OnboardingRepository(tx).getKey(session.account_id,"hail-identity");
        if(key.publicKey!==signingKey)throw new BindingError(409,"Managed identity key changed");
        const raw=await this.encryptor.decrypt(session.account_id,key.role,key.algorithm,key.publicKey,key);
        try {cose=await signPayload("hail.address-binding",input.payload as HailAddressBinding,
          createWebCryptoSigner(`${session.did}#hail-identity`,await importEd25519PrivateKey(raw)));}finally{raw.fill(0);}
      } else {
        if(typeof input.cose!=="string"||input.payload||input.cose.length>21846)throw new BindingError(400,"Owner renewal requires signed bytes");
        cose=decodeBase64Url(input.cose);if(cose.length>16384)throw new BindingError(400,"Binding too large");
      }
      const checked=await verifySignedPayload("hail.address-binding",cose,createWebCryptoVerifier(async kid=>{
        if(kid!==`${session.did}#hail-identity`)throw new BindingError(400,"Wrong binding signer");return ed25519PublicKeyFromDidKey(signingKey);
      }));this.review(session,checked.payload);
      const digest=new Uint8Array(createHash("sha256").update(cose).digest());
      const existing=await tx<Row[]>`SELECT id,cose,representation_digest,selected_at,published_at FROM address_bindings
        WHERE account_id=${session.account_id} AND representation_digest=${digest}`;
      if(existing[0]) {if(!equal(existing[0].cose,cose))throw new BindingError(409,"Binding bytes conflict");return existing[0];}
      const id=randomUUID();
      const rows=await tx<Row[]>`INSERT INTO address_bindings (id,account_id,canonical_address,did,cose,representation_digest,issued_at,expires_at,hosted_at)
        VALUES (${id},${session.account_id},${session.canonical_address},${session.did},${cose},${digest},
          ${new Date(checked.payload.issued_at*1000)},${new Date(checked.payload.expires_at*1000)},clock_timestamp())
        RETURNING id,cose,representation_digest,selected_at,published_at`;
      return rows[0]!;
    });
    // Commit hosting first: the immutable final URL is available before WebFinger selects it.
    const result=await this.sql.begin(async tx=>{
      const { resolved }=await this.writer(tx,session,signingKey);
      const candidate=(await tx<Row[]>`SELECT id,cose,representation_digest,selected_at,published_at FROM address_bindings WHERE id=${staged.id}`)[0]!;
      const proposed=inspectSignedPayload("hail.address-binding",new Uint8Array(candidate.cose)).payload;this.review(session,proposed);
      if(candidate.published_at)return this.summary(candidate);
      const current=(await tx<Row[]>`SELECT id,cose,representation_digest,selected_at,published_at FROM address_bindings
        WHERE account_id=${session.account_id} AND canonical_address=${session.canonical_address} AND selected_at IS NOT NULL
        ORDER BY selected_at DESC,id DESC LIMIT 1`)[0];
      if(!current||!equal(current.representation_digest,previous))throw new BindingError(409,"Selected binding changed; retain the signed artifact");
      const old=inspectSignedPayload("hail.address-binding",new Uint8Array(current.cose)).payload;
      if(proposed.issued_at<=old.issued_at||proposed.expires_at<=old.expires_at)throw new BindingError(409,"Renewal must extend the selected binding");
      await tx`UPDATE address_bindings SET selected_at=NULL WHERE account_id=${session.account_id}
        AND canonical_address=${session.canonical_address} AND selected_at IS NOT NULL`;
      const row=(await tx<Row[]>`UPDATE address_bindings SET selected_at=clock_timestamp(),published_at=clock_timestamp()
        WHERE id=${candidate.id} AND expires_at>clock_timestamp() RETURNING id,cose,representation_digest,selected_at,published_at`)[0];
      if(!row)throw new BindingError(409,"Binding expired before publication");
      await retainPublicSigningAuthority(tx, {
        actionType: "address-binding",
        localAccountId: session.account_id,
        did: session.did,
        role: "hail-identity",
        key: signingKey,
        serviceBase: `${this.origin}/hail`,
        representation: new Uint8Array(candidate.cose),
        evidence: resolved.evidence,
      });
      return this.summary(row);
    });
    if(result.status==="active") {
      const verified=await this.verifier.verify(session.canonical_address);
      if(verified.did!==session.did||verified.serviceBase!==`${this.origin}/hail`||verified.identityDidKey!==signingKey||
        !equal(verified.representation,staged.cose)||!equal(verified.digest,staged.representation_digest))throw new BindingError(409,"Published binding verification differs; retain artifacts");
    }
    return result;
  }
  private review(session:AccountApiSession,binding:HailAddressBinding) {
    const now=Math.floor(Date.now()/1000);
    if(binding.address!==session.canonical_address||binding.did!==session.did||binding.key_id!==`${session.did}#hail-identity`||
      binding.issued_at>now+300||binding.expires_at<=now)throw new BindingError(400,"Binding does not match the reviewed account or time");
  }
}
