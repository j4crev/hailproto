import {expect,it,vi} from "vitest";
import {ADDRESS_NOTICE_MS,observeIdentity,identityNotice,parseIdentityHistory,conflictingIdentities,identityAcknowledgmentKey} from "./identity-history.js";
import {identityMemory} from "./identity-memory.js";
const alice="did:plc:"+"a".repeat(24),bob="did:plc:"+"b".repeat(24);
const old="alice@old.example.com",next="alice@new.example.com";
it("shows a bounded same-identity notice without extending it on reload or older messages",()=>{
  let history=observeIdentity([],alice,old,1000);
  expect(identityNotice(history,alice,old,1000)).toBeNull();
  history=observeIdentity(history,alice,next,2000);
  expect(identityNotice(history,alice,next,2000)).toMatchObject({kind:"changed",text:expect.stringContaining(old)});
  const restored=parseIdentityHistory(JSON.stringify(history));
  expect(observeIdentity(restored,alice,old,3000)).toEqual(history);
  expect(observeIdentity(restored,alice,next,4000)).toEqual(history);
  expect(identityNotice(restored,alice,old,4000)).toBeNull();
  expect(identityNotice(restored,alice,next,2000+ADDRESS_NOTICE_MS)).toBeNull();
});
it("keeps conflicting-identity warnings beyond the temporary notice period",()=>{
  let history=observeIdentity([],alice,old,1000);
  history=observeIdentity(history,bob,old,2000);
  expect(identityNotice(history,bob,old,2000+ADDRESS_NOTICE_MS*2)?.kind).toBe("conflict");
  expect(identityNotice(history,alice,old,3000)?.kind).toBe("conflict");
  expect(conflictingIdentities(history,bob,old,[alice,bob,alice])).toEqual([alice]);
});
it("binds acknowledgment to the approval, identity, address and conflict set",()=>{
  const key=identityAcknowledgmentKey("request",bob,old,[alice]);
  for(const args of [["other",bob,old,[alice]],["request",alice,old,[alice]],["request",bob,next,[alice]],["request",bob,old,[]]] as const)
    expect(identityAcknowledgmentKey(args[0],args[1],args[2],[...args[3]])).not.toBe(key);
});
it("ignores malformed storage and unverified-looking display labels",()=>{
  for(const raw of ['{"__proto__":{}}','[null]','[{}]','not json'])expect(parseIdentityHistory(raw)).toEqual([]);
  expect(observeIdentity([],alice,"Display Name <alice@old.example.com>",1000)).toEqual([]);
  expect(observeIdentity([],"not-a-did",old,1000)).toEqual([]);
});
it("isolates browser history by account and tolerates blocked storage",()=>{
  const values=new Map<string,string>();
  vi.stubGlobal("localStorage",{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)});
  try{
    const first=identityMemory("owner-one"),second=identityMemory("owner-two");
    first.observe(alice,old);let a:unknown,b:unknown;
    const stopA=first.subscribe(value=>a=value),stopB=second.subscribe(value=>b=value);
    expect(a).toHaveLength(1);expect(b).toEqual([]);
    vi.stubGlobal("localStorage",{getItem(){throw new Error("blocked");},setItem(){throw new Error("blocked");}});
    expect(()=>first.observe(alice,next)).not.toThrow();expect(a).toHaveLength(2);
    stopA();stopB();
  }finally{vi.unstubAllGlobals();}
});
