import type {SQL} from "bun";
import {createSignupInvitation} from "../onboarding/invitation.js";
import type {SignupEmailClient} from "../onboarding/email.js";

export class OperatorError extends Error {constructor(readonly status:400|403|409|429|503,message:string){super(message);}}
export function invitationEmail(value:unknown):string|null{
  if(value===null)return null;
  if(typeof value!=="string"||value.length>254||!value.includes("@"))throw new OperatorError(400,"Enter a valid email address");
  const [local,domain,...rest]=value.split("@");
  if(rest.length||!local||local.length>64||!domain||! /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)||
    local.startsWith(".")||local.endsWith(".")||local.includes("..")||!domain.includes(".")||
    domain.split(".").some(label=>! /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))||! /^[a-z]{2,63}$/i.test(domain.split(".").at(-1)!))
    throw new OperatorError(400,"Enter a valid email address");
  return `${local}@${domain.toLowerCase()}`;
}
export class OperatorInvitations{
  constructor(private readonly sql:SQL,private readonly origin:string,private readonly browserOrigin:string,
    private readonly key:string,private readonly email:SignupEmailClient){}
  async authorized(accountId:string){return (await this.sql`SELECT op.account_id FROM provider_operators op JOIN account_serving_generations g ON g.account_id=op.account_id AND g.generation=op.serving_generation WHERE op.account_id=${accountId}`).length>0;}
  async list(){
    const invitations=await this.sql<{id:string;email:string|null;created_at:Date;expires_at:Date;status:string;delivery:string}[]>`SELECT i.id,i.email,to_timestamp(i.issued_at) AS created_at,
      to_timestamp(i.issued_at+604800) AS expires_at,
      CASE WHEN c.completed_at IS NOT NULL THEN 'completed' WHEN c.id IS NOT NULL THEN 'accepted'
        WHEN i.issued_at+604800<=extract(epoch FROM clock_timestamp()) THEN 'expired' ELSE 'pending' END AS status,
      CASE WHEN i.email IS NULL THEN 'link' WHEN i.email_accepted_at IS NOT NULL THEN 'accepted-by-email-service' ELSE 'unconfirmed' END AS delivery
      FROM provider_signup_invitations i LEFT JOIN account_signup_ceremonies c ON c.invitation_id=i.id
      ORDER BY i.created_at DESC,i.id LIMIT 100`;
    return {invitations};
  }
  async create(accountId:string,input:Record<string,unknown>){
    if(Object.keys(input).sort().join(',')!=="email,id"||typeof input.id!=="string"||! /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(input.id))
      throw new OperatorError(400,"Invalid invitation request");
    const id=input.id,email=invitationEmail(input.email);
    const row=await this.sql.begin(async tx=>{
      // Serialize creation and revocation on the operator grant; retries keep their original intent.
      if(!(await tx`SELECT op.account_id FROM provider_operators op JOIN account_serving_generations g ON g.account_id=op.account_id AND g.generation=op.serving_generation WHERE op.account_id=${accountId} FOR UPDATE OF op`).length)
        throw new OperatorError(403,"Operator access required");
      let saved=(await tx`SELECT * FROM provider_signup_invitations WHERE id=${id}`)[0];
      if(saved){
        if(saved.operator_account_id!==accountId||saved.email!==email)throw new OperatorError(409,"Invitation request changed");
        if(Number(saved.issued_at)+604800<=Date.now()/1000)throw new OperatorError(409,"Create a new invitation; this one expired");
      }else{
        await tx`SELECT pg_advisory_xact_lock(hashtext('hail.provider-invitations'))`;
        const count=(await tx`SELECT count(*)::integer AS count FROM provider_signup_invitations WHERE created_at>clock_timestamp()-interval '1 hour'`)[0]!.count;
        if(count>=100)throw new OperatorError(429,"Hourly invitation limit reached");
        saved=(await tx`INSERT INTO provider_signup_invitations(id,operator_account_id,email,issued_at)
          VALUES(${id},${accountId},${email},${Math.floor(Date.now()/1000)}) RETURNING *`)[0]!;
      }
      return saved;
    });
    const token=createSignupInvitation(this.origin,this.key,Number(row.issued_at),id);
    const url=`${this.browserOrigin}/signup#invitation=${encodeURIComponent(token)}`;
    if(email&&!row.email_accepted_at){
      await this.email.invite({id,email,url,expiresAt:Number(row.issued_at)+604800});
      await this.sql`UPDATE provider_signup_invitations SET email_accepted_at=clock_timestamp() WHERE id=${id}`;
    }
    return {id,url,expiresAt:new Date((Number(row.issued_at)+604800)*1000).toISOString(),delivery:email?"accepted-by-email-service":"link"};
  }
}
