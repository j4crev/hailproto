import {randomBytes,randomUUID} from "node:crypto";
import {SQL} from "bun";
import {beforeAll,afterAll,describe,it,expect,vi} from "vitest";
import {Hono} from "hono";
import {ProviderDatabase} from "../src/db/database.js";
import {RegistrationPolicy} from "../src/onboarding/registration.js";
import {createSignupInvitation} from "../src/onboarding/invitation.js";
import {registerSelfServiceOnboarding} from "../src/accounts/onboarding-routes.js";
const integration=process.env.DATABASE_URL?describe:describe.skip;
integration("shared registration admission",()=>{
  let admin:SQL,db:ProviderDatabase,policy:RegistrationPolicy;
  const schema=`registration_${randomUUID().replaceAll('-','')}`,account=randomUUID(),key=randomBytes(32).toString('base64url'),origin="https://example.com";
  beforeAll(async()=>{
    admin=new SQL(process.env.DATABASE_URL!);await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const url=new URL(process.env.DATABASE_URL!);url.searchParams.set("options",`-csearch_path=${schema}`);
    db=new ProviderDatabase(url.toString());await db.migrate();
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${account},${randomUUID()},'operator@example.com',${`did:plc:${"a".repeat(24)}`},'active',now(),${randomBytes(32)},'public')`;
    await db.sql`INSERT INTO provider_operators(account_id,serving_generation) VALUES(${account},1)`;
    policy=new RegistrationPolicy(db.sql,origin,key);
  });
  afterAll(async()=>{await db?.close();if(admin){await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}});
  it("defaults to invite, validates signatures and consumes invitations across both APIs",async()=>{
    expect(await policy.read()).toEqual({mode:"invite"});
    for(const token of ["","invalid",createSignupInvitation(origin,key,Math.floor(Date.now()/1000)-8*86400),createSignupInvitation("https://other.example",key)])
      await expect(policy.admit(randomBytes(32),randomBytes(32),"cli",token)).rejects.toMatchObject({status:403});
    const invitation=createSignupInvitation(origin,key),hash=randomBytes(32),digest=randomBytes(32);
    const id=await policy.admit(hash,digest,"browser",invitation);
    expect(await policy.admit(hash,digest,"browser",invitation)).toBe(id);
    await expect(policy.admit(randomBytes(32),randomBytes(32),"cli",invitation)).rejects.toMatchObject({status:409});
    await expect(policy.admit(hash,randomBytes(32),"browser",invitation)).rejects.toMatchObject({status:409});
    await expect(policy.requireLive(hash,"cli")).rejects.toMatchObject({status:410});
    const competing=createSignupInvitation(origin,key);
    const results=await Promise.allSettled(["cli","browser"].map(channel=>policy.admit(randomBytes(32),randomBytes(32),channel as "cli"|"browser",competing)));
    expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    expect(results.filter(result=>result.status==="rejected")).toHaveLength(1);
  });
  it("audits authorized changes and lets existing public admissions resume after switching to invite",async()=>{
    await expect(policy.update(randomUUID(),{mode:"public"})).rejects.toMatchObject({status:403});
    await expect(policy.update(account,{mode:"unknown"})).rejects.toMatchObject({status:400});
    await policy.update(account,{mode:"public"});
    const hash=randomBytes(32),digest=randomBytes(32);
    expect(await policy.admit(hash,digest,"cli","")).toBeNull();
    await policy.update(account,{mode:"invite"});
    expect(await policy.admit(hash,digest,"cli","")).toBeNull();
    await expect(policy.admit(randomBytes(32),digest,"cli","")).rejects.toMatchObject({status:403});
    await db.sql`UPDATE provider_signup_admissions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=${hash}`;
    await expect(policy.admit(hash,digest,"cli","")).rejects.toMatchObject({status:410});
    await expect(policy.requireLive(hash,"cli")).rejects.toMatchObject({status:410});
    expect((await db.sql<{previous_mode:string;mode:string}[]>`SELECT * FROM provider_registration_audit ORDER BY id`).map(row=>[row.previous_mode,row.mode])).toEqual([["invite","public"],["public","invite"]]);
  });
  it("serializes a new admission behind an in-flight policy change",async()=>{
    await policy.update(account,{mode:"public"});
    let locked!:()=>void,release!:()=>void;
    const ready=new Promise<void>(resolve=>locked=resolve),hold=new Promise<void>(resolve=>release=resolve);
    const change=db.sql.begin(async tx=>{
      await tx`SELECT mode FROM provider_registration_settings WHERE singleton=true FOR UPDATE`;locked();await hold;
      await tx`UPDATE provider_registration_settings SET mode='invite' WHERE singleton=true`;
    });
    await ready;
    const admission=policy.admit(randomBytes(32),randomBytes(32),"cli","");
    release();await change;
    await expect(admission).rejects.toMatchObject({status:403});
  });
  it("enforces policy and provider domain at the CLI HTTP entry point",async()=>{
    const prepare=vi.fn(async()=>({accountId:randomUUID()})),app=new Hono();
    registerSelfServiceOnboarding(app,{sql:db.sql,provider:origin,profile:"strict-public-v1",invitationKey:key,onboarding:{prepare} as never});
    const input={address:"alice@example.com",recoveryKey:"fixture",identityKey:"fixture",custody:"managed",backupVerified:true,
      signupHash:randomBytes(32).toString('base64url'),monitorOrigin:"https://monitor.example",monitorKey:"fixture"};
    const request=(body:unknown)=>app.request("/api/v1/onboarding",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    expect((await request(input)).status).toBe(403);expect(prepare).not.toHaveBeenCalled();
    const invited={...input,invitation:createSignupInvitation(origin,key)};
    expect((await request(invited)).status).toBe(200);
    expect((await request({...invited,signupHash:randomBytes(32).toString('base64url')})).status).toBe(409);
    await policy.update(account,{mode:"public"});
    expect((await request({...input,signupHash:randomBytes(32).toString('base64url')})).status).toBe(200);
    expect((await request({...input,address:"alice@custom.example",signupHash:randomBytes(32).toString('base64url')})).status).toBe(400);
    expect(prepare).toHaveBeenCalledTimes(2);
  });
});
