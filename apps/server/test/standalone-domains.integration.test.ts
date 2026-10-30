import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ProviderDatabase } from "../src/db/database.js";
import { StandaloneDomains } from "../src/accounts/standalone-domains.js";
import { registerStandaloneDomainRoutes } from "../src/accounts/standalone-domain-routes.js";

const integration=process.env.DATABASE_URL?describe:describe.skip;
integration("standalone domain signup",()=>{
  let db:ProviderDatabase,domains:StandaloneDomains;
  const txt=vi.fn(async(_name:string,_signal:AbortSignal):Promise<string[][]>=>[]);
  const discover=vi.fn(async(_domain:string,_signal:AbortSignal):Promise<string|null>=>"haili.app");
  const address=()=>`publisher@${randomUUID()}.example.com`;
  const mode=async(value:string)=>{await db.sql`UPDATE provider_registration_settings SET mode=${value} WHERE singleton=true`;};
  const cooldown=async(id:string)=>{await db.sql`UPDATE standalone_domain_signups SET next_check_at=clock_timestamp()-interval '1 second' WHERE id=${id}`;};
  async function ready(){await mode("public");const setup=await domains.start(address());txt.mockResolvedValue([[setup.verificationValue]]);discover.mockResolvedValue("haili.app");await domains.verify(setup.token);return setup;}
  beforeAll(async()=>{db=new ProviderDatabase(process.env.DATABASE_URL!);await db.migrate();await db.migrate();domains=new StandaloneDomains(db.sql,"https://haili.app",txt,discover);});
  afterAll(async()=>{await db?.close();});

  it("requires public registration, DNS proof, and exact address without any existing account",async()=>{
    await mode("invite");await expect(domains.start(address())).rejects.toMatchObject({status:403});
    await mode("public");await expect(domains.start("a@haili.app")).rejects.toMatchObject({status:400});
    const setup=await domains.start(address());
    expect(await db.sql`SELECT id FROM provider_accounts`).toHaveLength(0);
    expect(await db.sql`SELECT id FROM account_custom_domains`).toHaveLength(0);
    expect(JSON.stringify(await db.sql`SELECT to_jsonb(s) FROM standalone_domain_signups s`)).not.toContain(setup.token);
    expect(JSON.stringify(await db.sql`SELECT to_jsonb(s) FROM standalone_domain_signups s`)).not.toContain(setup.verificationValue.split("=")[1]);
    await expect(domains.check(setup.token,setup.address)).rejects.toMatchObject({status:403});
    txt.mockResolvedValue([[setup.verificationValue]]);discover.mockResolvedValue("other.example.com");
    expect(await domains.verify(setup.token)).toMatchObject({verified:false,ownership:true,delegation:false});
    await expect(domains.verify(setup.token)).rejects.toMatchObject({status:429});
    await cooldown(setup.id);discover.mockResolvedValue("haili.app");
    expect((await domains.verify(setup.token)).verified).toBe(true);
    await domains.check(setup.token,setup.address);
    await expect(domains.check(setup.token,"other@"+setup.domain)).rejects.toMatchObject({status:403});
    await mode("invite");
    await expect(domains.status(setup.token)).rejects.toMatchObject({status:403});
    await expect(domains.verify(setup.token)).rejects.toMatchObject({status:403});
    await expect(db.sql.begin(tx=>domains.consume(tx,setup.token,setup.address,randomUUID(),randomBytes(32),randomBytes(32)))).rejects.toMatchObject({status:403});
    await mode("public");
  });

  it("rechecks DNS at consumption, rolls back authority, and rejects expired authorization",async()=>{
    const setup=await ready(),id=randomUUID(),hash=randomBytes(32),digest=randomBytes(32);
    txt.mockResolvedValue([]);
    await expect(db.sql.begin(tx=>domains.consume(tx,setup.token,setup.address,id,hash,digest))).rejects.toMatchObject({status:409});
    txt.mockRejectedValueOnce(new Error("SERVFAIL"));
    await expect(db.sql.begin(tx=>domains.consume(tx,setup.token,setup.address,id,hash,digest))).rejects.toMatchObject({status:503});
    txt.mockResolvedValue([[setup.verificationValue]]);
    await expect(db.sql.begin(async tx=>{await domains.consume(tx,setup.token,setup.address,id,hash,digest);throw new Error("rollback");})).rejects.toThrow("rollback");
    expect((await db.sql`SELECT consumed_at FROM standalone_domain_signups WHERE id=${setup.id}`)[0].consumed_at).toBeNull();
    await db.sql`UPDATE standalone_domain_signups SET verified_at=clock_timestamp()-interval '16 minutes',authorization_expires_at=clock_timestamp()-interval '1 minute' WHERE id=${setup.id}`;
    await expect(domains.check(setup.token,setup.address)).rejects.toMatchObject({status:403});
    await expect(db.sql.begin(tx=>domains.consume(tx,setup.token,setup.address,id,hash,digest))).rejects.toMatchObject({status:403});
  });

  it("pending attempts do not reserve a domain, and expiry permits a new setup",async()=>{
    await mode("public");const input=address(),a=await domains.start(input),b=await domains.start(input);
    expect(a.token).not.toBe(b.token);
    await db.sql`UPDATE standalone_domain_signups SET created_at=clock_timestamp()-interval '25 hours',expires_at=clock_timestamp()-interval '1 second' WHERE id=${a.id}`;
    await expect(domains.status(a.token)).rejects.toMatchObject({status:409});
    await domains.start(input);
    expect(await db.sql`SELECT id FROM standalone_domain_signups WHERE id=${a.id}`).toHaveLength(0);
    expect(await db.sql`SELECT id FROM account_custom_domains`).toHaveLength(0);
  });

  it("guards anonymous HTTP requests and returns non-cacheable authority only in JSON",async()=>{
    await mode("public");const app=new Hono();registerStandaloneDomainRoutes(app,domains,"https://haili.app");
    const call=(body:unknown,headers:Record<string,string>={},path="",method="POST")=>app.request("https://haili.app/api/v1/domain-signup"+path,{method,headers:{Origin:"https://haili.app","Content-Type":"application/json",...headers},...(method==="GET"?{}:{body:JSON.stringify(body)})});
    expect((await call({address:address()},{Origin:"https://evil.example"})).status).toBe(403);
    expect((await call({address:address(),extra:true})).status).toBe(400);
    expect((await call({},{},"/verify")).status).toBe(403);
    expect((await call(undefined,{},"","GET")).status).toBe(403);
    expect((await call({address:address()},{"Content-Type":"text/plain"})).status).toBe(415);
    const response=await call({address:address()});expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");const setup=await response.json();
    txt.mockResolvedValue([[setup.verificationValue]]);discover.mockResolvedValue("haili.app");
    expect((await call({},{Authorization:`Bearer ${setup.token}`},"/verify")).status).toBe(200);
    expect((await call(undefined,{Authorization:`Bearer ${setup.token}`},"","GET")).status).toBe(200);
    for(let i=0;i<4;i++)expect((await call({address:address()})).status).toBe(200);
    expect((await call({address:address()})).status).toBe(429);
  });

  it("commits only one owner when independently verified setups compete",async()=>{
    await mode("public");const domain=`race-${randomUUID()}.example.com`;
    const a=await domains.start(`a@${domain}`),b=await domains.start(`b@${domain}`);
    txt.mockResolvedValue([[a.verificationValue],[b.verificationValue]]);discover.mockResolvedValue("haili.app");
    await domains.verify(a.token);await domains.verify(b.token);
    const claim=(setup:typeof a)=>db.sql.begin(async tx=>{
      const signupId=randomUUID(),accountId=randomUUID();
      await domains.consume(tx,setup.token,setup.address,signupId,randomBytes(32),randomBytes(32));
      await tx`INSERT INTO provider_accounts(id,tenant_id,canonical_address,onboarding_state) VALUES(${accountId},${randomUUID()},${setup.address},'reserved')`;
      await domains.attach(tx,setup.token,signupId,accountId);
      return accountId;
    });
    const results=await Promise.allSettled([claim(a),claim(b)]);
    expect(results.filter(result=>result.status==="fulfilled"),JSON.stringify(results)).toHaveLength(1);
    expect(await db.sql`SELECT id FROM account_custom_domains WHERE domain=${domain}`).toHaveLength(1);
    expect(await db.sql`SELECT id FROM provider_accounts WHERE canonical_address IN (${a.address},${b.address})`).toHaveLength(1);
    expect(await db.sql`SELECT id FROM standalone_domain_signups WHERE canonical_address IN (${a.address},${b.address}) AND consumed_at IS NULL`).toHaveLength(1);
  });

  it("preserves saved evidence on rollback and can reverse an empty migration",async()=>{
    const rollback=await Bun.file(new URL("../migrations/rollback/0089_standalone_domain_signup.sql",import.meta.url)).text();
    await expect(db.sql.begin(tx=>tx.unsafe(rollback))).rejects.toThrow("Export and explicitly remove");
    const isolated=new ProviderDatabase(process.env.TRANSFER_TARGET_DATABASE_URL!);
    try{await isolated.migrate();await isolated.sql.begin(async tx=>{await tx.unsafe(rollback);await tx`DELETE FROM schema_migrations WHERE version=89`;});await isolated.migrate();
      expect(await isolated.sql`SELECT id FROM standalone_domain_signups`).toHaveLength(0);
    }finally{await isolated.close();}
  });
});
