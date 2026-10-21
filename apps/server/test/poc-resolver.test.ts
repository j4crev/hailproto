import {expect,it} from "vitest";
import {PrivatePocManagedResolver} from "../src/plc/poc-resolver.js";

it("labels one configured registry read as local POC evidence",async()=>{
  const did=`did:plc:${"a".repeat(24)}`,resolved={did,identityDidKey:"did:key:zidentity",messagingDidKey:"did:key:zmessaging",
    serviceBase:"https://provider.example/hail",evidence:{document:{},data:{},log:[{type:"plc_operation",sig:"x"}]}};
  const result=await new PrivatePocManagedResolver({resolve:async()=>resolved}).resolve(did);
  expect(result.evidence.verification).toMatchObject({profile:"poc-local",operationCid:expect.any(String),digest:expect.any(String)});
});
