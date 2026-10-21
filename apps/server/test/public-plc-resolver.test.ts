import { expect,it,vi } from "vitest";
import type { SQL } from "bun";
import { cidForCbor } from "@atproto/common";
import { signOperation } from "@did-plc/lib";
import { VerifiedPublicPlcResolver } from "../src/plc/public-resolver.js";
import { publicPlcFixture,publicPlcReaders } from "./public-plc-fixture.js";

function recordingSql(){
  let retained:Uint8Array|undefined;
  const query=async(strings:TemplateStringsArray,...values:unknown[])=>{
    const query=strings.join(" ");
    if(query.includes("INSERT INTO public_plc_resolution_evidence")){retained=values[4] as Uint8Array;return [];}
    if(query.includes("SELECT bundle_bytes"))return retained?[{bundle_bytes:retained}]:[];
    return [];
  };
  const tx=query as unknown as SQL;
  const begin=vi.fn(async(callback:(transaction:SQL)=>Promise<unknown>)=>callback(tx));
  return {sql:Object.assign(query,{begin}) as unknown as SQL,begin};
}

it("uses one validated reader and falls back from failed, stale, malformed or stalled primaries",async()=>{
  const fixture=await publicPlcFixture(),readers=publicPlcReaders([fixture]);
  for(const bad of [
    {...readers[1],async audit(){throw new Error("Reader outage");}},
    {...readers[1],async health(){return {lastCommittedOpTime:"2000-01-01T00:00:00.000Z"};}},
    {...readers[1],async health(){return {}; }},
    {...readers[1],async audit(did:string){return (await readers[1].audit(did)).map(entry=>({...entry,createdAt:"2000-01-01T00:00:00.000Z"}));}},
    {...readers[1],resolver:{async resolve(did:string){const resolved=await readers[1].resolver.resolve(did);return {...resolved,messagingDidKey:resolved.identityDidKey};}}},
  ]){
    const {sql}=recordingSql();
    await expect(new VerifiedPublicPlcResolver(sql,[bad,readers[0]],["provider"],["https://local.example.com"])
      .resolve(fixture.did)).resolves.toMatchObject({did:fixture.did});
  }
  const stalled={...readers[1],audit:()=>new Promise<never>(()=>{})};
  const {sql}=recordingSql();
  await expect(new VerifiedPublicPlcResolver(sql,[stalled,readers[0]],["provider"],["https://local.example.com"],undefined,200)
    .resolve(fixture.did)).resolves.toMatchObject({did:fixture.did});
});

it("resolves the canonical directory from one audit read without replica freshness metadata",async()=>{
  const fixture=await publicPlcFixture(),reader=publicPlcReaders([fixture])[0],resolve=vi.fn(async()=>{throw new Error("unused");}),
    audit=vi.fn(reader.audit),{sql}=recordingSql();
  await expect(new VerifiedPublicPlcResolver(sql,[{...reader,origin:"https://plc.directory",operator:"plc-directory",
    resolver:{resolve},audit,health:async()=>({version:"test"})}], ["provider"],["https://local.example.com"])
    .resolve(fixture.did)).resolves.toMatchObject({did:fixture.did});
  expect(audit).toHaveBeenCalledOnce();expect(resolve).not.toHaveBeenCalled();
});

it("refuses authority when every configured reader fails",async()=>{
  const fixture=await publicPlcFixture(),readers=publicPlcReaders([fixture]),{sql,begin}=recordingSql();
  const failed=readers.map(reader=>({...reader,async audit(){throw new Error("Reader outage");}}));
  await expect(new VerifiedPublicPlcResolver(sql,failed,["provider"],["https://local.example.com"])
    .resolve(fixture.did)).rejects.toThrow("No configured PLC reader");
  expect(begin).not.toHaveBeenCalled();
});

it("refuses a valid stale prefix after retaining a later audit history",async()=>{
  const fixture=await publicPlcFixture(),readers=publicPlcReaders([fixture]),{sql}=recordingSql();
  const resolver=new VerifiedPublicPlcResolver(sql,[readers[0]],["provider"],["https://local.example.com"]);
  await resolver.resolve(fixture.did);
  const {sig:_,...genesis}=fixture.log[0]!;
  fixture.log.push(await signOperation({...genesis,prev:(await cidForCbor(fixture.log[0]!)).toString()},fixture.owner));
  await expect(resolver.resolve(fixture.did)).resolves.toMatchObject({did:fixture.did});
  fixture.log.pop();
  await expect(resolver.resolve(fixture.did)).rejects.toThrow("history regressed");
});

it("rejects backward/expired local verification clocks and malformed subjects",async()=>{
  const fixture=await publicPlcFixture(),baseReaders=publicPlcReaders([fixture]),
    readers=baseReaders.map(reader=>({...reader,async health(){return {lastCommittedOpTime:new Date(1_800_000_000_000).toISOString()};}})) as typeof baseReaders,
    {sql,begin}=recordingSql();
  for(const elapsed of [-1,16_000]){
    let calls=0;const clock=()=>new Date(1_800_000_000_000+(calls++?elapsed:0));
    await expect(new VerifiedPublicPlcResolver(sql,readers,["provider"],["https://local.example.com"],clock).resolve(fixture.did)).rejects.toThrow("clock/deadline");
  }
  await expect(new VerifiedPublicPlcResolver(sql,readers,["provider"],["https://local.example.com"]).resolve("untrusted-message-content")).rejects.toThrow("canonical");
  expect(begin).not.toHaveBeenCalled();
});
