import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { SQL } from "bun";
import { canonicalizeHailAddress } from "../identity/address.js";
import { discoverProvider, lookupTxt, type ProviderDiscovery } from "../discovery/delegation.js";
import { tokenHash } from "./repository.js";
import { canonicalDomain, CustomDomainError } from "./domain-proof.js";

interface Setup {
  id:string;provider_origin:string;canonical_address:string;token_hash:Uint8Array;challenge_hash:Uint8Array;
  created_at:Date;expires_at:Date;next_check_at:Date;verified_at:Date|null;authorization_expires_at:Date|null;
  signup_id:string|null;signup_token_hash:Uint8Array|null;request_digest:Uint8Array|null;consumed_at:Date|null;account_id:string|null;
}
const tokenPattern=/^haild_[A-Za-z0-9_-]{43}$/;
const equal=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&timingSafeEqual(a,b);

export class StandaloneDomains {
  private readonly host:string;
  constructor(private readonly sql:SQL,private readonly origin:string,private readonly txt=lookupTxt,private readonly discover:ProviderDiscovery=discoverProvider){this.host=new URL(origin).hostname;}
  private async publicOnly(tx:SQL){
    const settings=(await tx`SELECT mode FROM provider_registration_settings WHERE singleton=true FOR UPDATE`)[0];
    if(settings?.mode!=="public")throw new CustomDomainError(403,"Standalone domain signup requires public registration.");
  }
  async exists(token:string,sql=this.sql){
    return tokenPattern.test(token)&&(await sql`SELECT id FROM standalone_domain_signups WHERE token_hash=${tokenHash(token)} AND provider_origin=${this.origin}`).length>0;
  }
  private async row(tx:SQL,token:string){
    if(!tokenPattern.test(token))throw new CustomDomainError(403,"Invalid domain setup authority.");
    const row=(await tx<Setup[]>`SELECT * FROM standalone_domain_signups WHERE token_hash=${tokenHash(token)} AND provider_origin=${this.origin} FOR UPDATE`)[0];
    if(!row)throw new CustomDomainError(403,"Domain setup authority is unavailable.");
    return row;
  }
  private live(row:Setup){if(row.consumed_at||row.expires_at.getTime()<=Date.now())throw new CustomDomainError(409,"Domain setup is used or expired. Continue your saved signup or start a new DNS setup.");}
  private summary(row:Setup){
    const domain=row.canonical_address.split("@")[1]!;
    return {id:row.id,address:row.canonical_address,domain,expiresAt:row.expires_at.toISOString(),
      verified:!!row.verified_at&&!!row.authorization_expires_at&&row.authorization_expires_at.getTime()>Date.now(),
      authorizationExpiresAt:row.authorization_expires_at?.toISOString()??null,
      verificationName:`_hail-domain-verify.${domain}`,delegationName:`_hail-provider.${domain}`,delegationValue:`v=hail1; provider=${this.host}`};
  }
  private async available(tx:SQL,address:string){
    const domain=address.split("@")[1]!;
    if((await tx`SELECT 1 FROM account_custom_domains WHERE domain=${domain} AND ((verified_at IS NOT NULL AND withdrawn_at IS NULL) OR withdrawn_at>clock_timestamp()-interval '3630 seconds')
      UNION ALL SELECT 1 FROM provider_accounts WHERE canonical_address=${address} AND (address_released_at IS NULL OR address_released_at>clock_timestamp()-interval '3630 seconds')
      UNION ALL SELECT 1 FROM transfer_address_reservations WHERE canonical_address=${address}
      UNION ALL SELECT 1 FROM provider_reserved_names WHERE local_part=split_part(${address},'@',1) LIMIT 1`).length)
      throw new CustomDomainError(409,"Domain or address is already registered or reserved. Existing domain administrators should use Settings.");
  }
  private async proof(row:Setup){
    const domain=row.canonical_address.split("@")[1]!,signal=AbortSignal.timeout(10_000);
    try{
      const [records,provider]=await Promise.all([this.txt(`_hail-domain-verify.${domain}`,signal),this.discover(domain,signal)]);
      return {ownership:records.some(parts=>{const match=/^hail-domain-verify=([A-Za-z0-9_-]{43})$/.exec(parts.join(""));
        return !!match&&equal(tokenHash(match[1]!),row.challenge_hash);}),delegation:provider===this.host};
    }catch{throw new CustomDomainError(503,"DNS could not be checked. Retry after one minute.");}
  }
  async start(input:string){
    const parts=input.split("@");if(parts.length!==2)throw new CustomDomainError(400,"Enter a username and domain.");
    const domain=canonicalDomain(parts[1]!);let address:string;
    try{address=canonicalizeHailAddress(`${parts[0]}@${domain}`);}catch{throw new CustomDomainError(400,"Enter a valid username and domain.");}
    if(domain===this.host)throw new CustomDomainError(400,"Use ordinary signup for the provider's domain.");
    const token=`haild_${randomBytes(32).toString("base64url")}`,challenge=randomBytes(32).toString("base64url");
    return this.sql.begin(async tx=>{
      await this.publicOnly(tx); // Also serializes anonymous quota and cleanup.
      await tx`DELETE FROM standalone_domain_signups WHERE consumed_at IS NULL AND expires_at<=clock_timestamp()`;
      if(Number((await tx`SELECT count(*) AS n FROM standalone_domain_signups WHERE consumed_at IS NULL`)[0].n)>=5000)
        throw new CustomDomainError(429,"Too many pending domain setups. Try again later.");
      await this.available(tx,address);
      const row=(await tx<Setup[]>`INSERT INTO standalone_domain_signups(id,provider_origin,canonical_address,token_hash,challenge_hash)
        VALUES(${randomUUID()},${this.origin},${address},${tokenHash(token)},${tokenHash(challenge)}) RETURNING *`)[0]!;
      return {...this.summary(row),token,verificationValue:`hail-domain-verify=${challenge}`};
    });
  }
  async status(token:string){return this.sql.begin(async tx=>{await this.publicOnly(tx);const row=await this.row(tx,token);this.live(row);return this.summary(row);});}
  async verify(token:string){
    const row=await this.sql.begin(async tx=>{
      await this.publicOnly(tx);const row=await this.row(tx,token);this.live(row);
      if(row.next_check_at.getTime()>Date.now())throw new CustomDomainError(429,"Wait one minute before checking DNS again.");
      await tx`UPDATE standalone_domain_signups SET next_check_at=clock_timestamp()+interval '1 minute' WHERE id=${row.id}`;
      return row;
    });
    const proof=await this.proof(row);
    return this.sql.begin(async tx=>{
      await this.publicOnly(tx);const current=await this.row(tx,token);this.live(current);await this.available(tx,current.canonical_address);
      const verified=proof.ownership&&proof.delegation;
      const updated=(await tx<Setup[]>`UPDATE standalone_domain_signups SET verified_at=CASE WHEN ${verified} THEN clock_timestamp() ELSE NULL END,
        authorization_expires_at=CASE WHEN ${verified} THEN clock_timestamp()+interval '15 minutes' ELSE NULL END WHERE id=${row.id} RETURNING *`)[0]!;
      return {...this.summary(updated),...proof};
    });
  }
  async check(token:string,address:string){return this.sql.begin(async tx=>{
    await this.publicOnly(tx);const row=await this.row(tx,token);
    if(row.consumed_at)throw new CustomDomainError(403,"Domain setup has already been used. Continue your saved signup.");
    this.live(row);
    if(row.canonical_address!==address||!row.authorization_expires_at||row.authorization_expires_at.getTime()<=Date.now())
      throw new CustomDomainError(403,"Verify DNS for this exact address before signup.");
    await this.available(tx,address);
  });}
  async consume(tx:SQL,token:string,address:string,signupId:string,signupHash:Uint8Array,digest:Uint8Array){
    await this.publicOnly(tx);const row=await this.row(tx,token);
    if(row.canonical_address!==address)throw new CustomDomainError(403,"Domain setup authorizes another address.");
    if(row.consumed_at){
      if(row.signup_id!==signupId||!equal(row.signup_token_hash!,signupHash)||!equal(row.request_digest!,digest))throw new CustomDomainError(409,"Domain setup belongs to another signup.");
      return {authorizationId:row.id,address};
    }
    this.live(row);
    if(!row.verified_at||!row.authorization_expires_at||row.authorization_expires_at.getTime()<=Date.now())throw new CustomDomainError(403,"Verify DNS again before signup.");
    const proof=await this.proof(row);
    if(!proof.ownership||!proof.delegation)throw new CustomDomainError(409,"Keep both DNS records in place until account setup begins.");
    this.live(row);
    if(row.authorization_expires_at.getTime()<=Date.now())throw new CustomDomainError(403,"DNS authorization expired during signup.");
    await this.available(tx,address);
    await tx`UPDATE standalone_domain_signups SET signup_id=${signupId},signup_token_hash=${signupHash},request_digest=${digest},consumed_at=clock_timestamp() WHERE id=${row.id}`;
    return {authorizationId:row.id,address};
  }
  async attach(tx:SQL,token:string,signupId:string,accountId:string){
    const row=await this.row(tx,token);
    if(!row.consumed_at||row.signup_id!==signupId||row.account_id&&row.account_id!==accountId)throw new CustomDomainError(409,"Domain setup does not match this account.");
    if(row.account_id)return;
    const domainId=randomUUID();
    await tx`INSERT INTO account_custom_domains(id,account_id,domain,provider_host,challenge_hash,challenge_created_at,challenge_expires_at,verified_at,ownership_checked_at,delegation_checked_at)
      VALUES(${domainId},${accountId},${row.canonical_address.split("@")[1]!},${this.host},${row.challenge_hash},${row.created_at},${row.expires_at},clock_timestamp(),clock_timestamp(),clock_timestamp())`;
    await tx`INSERT INTO custom_address_authorizations(id,domain_id,account_id,account_generation,provider_origin,canonical_address,token_hash,issued_at,expires_at,signup_id,signup_token_hash,request_digest,consumed_at)
      VALUES(${row.id},${domainId},${accountId},1,${this.origin},${row.canonical_address},${row.token_hash},statement_timestamp(),statement_timestamp()+interval '15 minutes',${signupId},${row.signup_token_hash},${row.request_digest},${row.consumed_at})`;
    await tx`UPDATE standalone_domain_signups SET account_id=${accountId} WHERE id=${row.id}`;
  }
}
