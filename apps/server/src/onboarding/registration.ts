import type {SQL} from "bun";
import {verifySignupInvitation} from "./invitation.js";

export type SignupMode="invite"|"public";
export class RegistrationError extends Error {
  constructor(readonly status:400|403|409|410,message:string){super(message);}
}
/** All HTTP signup surfaces share this admission ledger, including invitation consumption. */
export class RegistrationPolicy {
  constructor(private readonly sql:SQL,private readonly origin:string,private readonly invitationKey?:string){}
  async read(){
    const row=(await this.sql`SELECT mode FROM provider_registration_settings WHERE singleton=true`)[0];
    if(!row||!["invite","public"].includes(row.mode))throw new Error("Registration policy unavailable");
    return {mode:row.mode as SignupMode};
  }
  private invitation(mode:SignupMode,token:string):string|null{
    if(!token&&mode==="public")return null;
    try{
      if(!this.invitationKey)throw new Error();
      return verifySignupInvitation(token,this.origin,this.invitationKey);
    }catch{throw new RegistrationError(403,"A valid, unexpired invitation is required");}
  }
  async check(invitation:string){this.invitation((await this.read()).mode,invitation);}
  async admit(tokenHash:Uint8Array,digest:Uint8Array,channel:"browser"|"cli",invitation:string,transaction?:SQL):Promise<string|null>{
    const run=async(tx:SQL)=>{
      // The same row lock serializes admissions and admin changes across processes.
      const settings=(await tx`SELECT mode FROM provider_registration_settings WHERE singleton=true FOR UPDATE`)[0];
      if(!settings)throw new Error("Registration policy unavailable");
      const prior=(await tx`SELECT *,expires_at>clock_timestamp() AS live FROM provider_signup_admissions WHERE token_hash=${tokenHash}`)[0];
      if(prior){
        if(prior.channel!==channel||!Buffer.from(prior.request_digest).equals(Buffer.from(digest)))throw new RegistrationError(409,"Signup retry differs from its admitted request");
        if(!prior.live)throw new RegistrationError(410,"Setup authority expired; retain your original artifacts");
        return prior.invitation_id as string|null;
      }
      const id=this.invitation(settings.mode,invitation);
      if(id&&(await tx`SELECT token_hash FROM provider_signup_admissions WHERE invitation_id=${id}`).length)
        throw new RegistrationError(409,"Invitation already used");
      await tx`INSERT INTO provider_signup_admissions(token_hash,channel,request_digest,invitation_id) VALUES(${tokenHash},${channel},${digest},${id})`;
      return id;
    };
    return transaction?run(transaction):this.sql.begin(tx=>run(tx as unknown as SQL));
  }
  async requireLive(tokenHash:Uint8Array,channel:"browser"|"cli"){
    if(!(await this.sql`SELECT token_hash FROM provider_signup_admissions WHERE token_hash=${tokenHash} AND channel=${channel} AND expires_at>clock_timestamp()`).length)
      throw new RegistrationError(410,"Setup authority expired or missing; retain your original artifacts");
  }
  async update(accountId:string,input:Record<string,unknown>){
    if(Object.keys(input).length!==1||!["invite","public"].includes(input.mode as string))throw new RegistrationError(400,"Select invite or public registration");
    return this.sql.begin(async tx=>{
      if(!(await tx`SELECT op.account_id FROM provider_operators op JOIN account_serving_generations g ON g.account_id=op.account_id AND g.generation=op.serving_generation WHERE op.account_id=${accountId} FOR UPDATE OF op`).length)
        throw new RegistrationError(403,"Operator access required");
      const prior=(await tx`SELECT mode FROM provider_registration_settings WHERE singleton=true FOR UPDATE`)[0];
      if(!prior)throw new Error("Registration policy unavailable");
      if(prior.mode!==input.mode){
        await tx`UPDATE provider_registration_settings SET mode=${input.mode as string} WHERE singleton=true`;
        await tx`INSERT INTO provider_registration_audit(operator_account_id,previous_mode,mode) VALUES(${accountId},${prior.mode},${input.mode as string})`;
      }
      return {mode:input.mode as SignupMode};
    });
  }
}
