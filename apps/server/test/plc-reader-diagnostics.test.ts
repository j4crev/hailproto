import {expect,it} from "vitest";
import {inspectPlcReaders} from "../src/plc/diagnostics.js";
import {publicPlcFixture,publicPlcReaders} from "./public-plc-fixture.js";

it("reports health failures and optional DID evidence disagreement without affecting authority",async()=>{
  const fixture=await publicPlcFixture(),readers=publicPlcReaders([fixture]),now=new Date();
  expect(await inspectPlcReaders(readers,now)).toMatchObject({healthy:true,disagreement:false});
  const unavailable={...readers[1],async health(){throw new Error("offline");}};
  expect(await inspectPlcReaders([readers[0],unavailable],now)).toMatchObject({healthy:false,disagreement:false,
    readers:[{healthy:true},{healthy:false,error:"offline"}]});
  const changedAudit={...readers[1],async audit(did:string){return (await readers[1].audit(did))
    .map(entry=>({...entry,createdAt:new Date(Date.parse(entry.createdAt)+1).toISOString()}));}};
  expect(await inspectPlcReaders([readers[0],changedAudit],now,fixture.did)).toMatchObject({healthy:false,disagreement:true});
});
