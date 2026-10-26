import {randomBytes,randomUUID} from "node:crypto";
import {SQL} from "bun";
import {beforeAll,afterAll,describe,it,expect,vi} from "vitest";
import {ProviderDatabase} from "../src/db/database.js";
import {OperatorInvitations} from "../src/operator/invitations.js";
import {verifySignupInvitation} from "../src/onboarding/invitation.js";
const integration=process.env.DATABASE_URL?describe:describe.skip;
integration("provider operator invitations",()=>{
  let admin:SQL,db:ProviderDatabase,service:OperatorInvitations;
  const schema=`operator_${randomUUID().replaceAll('-','')}`,account=randomUUID(),key=randomBytes(32).toString('base64url'),
    origin="https://example.com",invite=vi.fn(async()=>{});
  beforeAll(async()=>{
    admin=new SQL(process.env.DATABASE_URL!);await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const url=new URL(process.env.DATABASE_URL!);url.searchParams.set("options",`-csearch_path=${schema}`);
    db=new ProviderDatabase(url.toString());await db.migrate();
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${account},${randomUUID()},'operator@example.com',${`did:plc:${"a".repeat(24)}`},'active',now(),${randomBytes(32)},'public')`;
    service=new OperatorInvitations(db.sql,origin,origin,key,{invite} as never);
  });
  afterAll(async()=>{await db?.close();if(admin){await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}});
  it("requires a grant, creates valid single-use admission links, and keeps retries immutable",async()=>{
    const id=randomUUID();expect(await service.authorized(account)).toBe(false);
    await expect(service.create(account,{id,email:null})).rejects.toMatchObject({status:403});
    await db.sql`INSERT INTO provider_operators(account_id,serving_generation) VALUES(${account},1)`;
    const first=await service.create(account,{id,email:"Alice@example.com"});
    expect(verifySignupInvitation(new URLSearchParams(new URL(first.url).hash.slice(1)).get("invitation")!,origin,key)).toBe(id);
    expect(await service.create(account,{id,email:"Alice@example.com"})).toEqual(first);expect(invite).toHaveBeenCalledTimes(1);
    await expect(service.create(account,{id,email:"other@example.com"})).rejects.toMatchObject({status:409});
    const listing=await service.list();expect(listing.invitations).toHaveLength(1);
    expect(listing.invitations[0]).toMatchObject({id,status:"pending",delivery:"accepted-by-email-service"});
    expect(JSON.stringify(listing)).not.toContain("#invitation");
    await db.sql`UPDATE provider_operators SET serving_generation=2 WHERE account_id=${account}`;
    expect(await service.authorized(account)).toBe(false);
    await expect(service.create(account,{id:randomUUID(),email:null})).rejects.toMatchObject({status:403});
    await db.sql`DELETE FROM provider_operators WHERE account_id=${account}`;
  });
  it("retains the original request on email failures and never reports successful delivery prematurely",async()=>{
    await db.sql`INSERT INTO provider_operators(account_id,serving_generation) VALUES(${account},1)`;
    const id=randomUUID();invite.mockRejectedValueOnce(new Error("upstream unavailable"));
    await expect(service.create(account,{id,email:"retry@example.com"})).rejects.toThrow();
    expect((await service.list()).invitations.find(row=>row.id===id)?.delivery).toBe("unconfirmed");
    await service.create(account,{id,email:"retry@example.com"});
    expect(invite.mock.calls.at(-1)).toEqual(invite.mock.calls.at(-2));
  });
});
