import {expect,it} from "vitest";
import {base58btc} from "multiformats/bases/base58";
import {signMonitorAttestation,signOnboardingMonitorAttestation,verifyMonitorAttestation,
  verifyOnboardingMonitorAttestation} from "../src/migration/monitor-attestation.js";

async function key(){
  const pair=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]),raw=new Uint8Array(await crypto.subtle.exportKey("raw",pair.publicKey));
  return {pair,did:`did:key:${base58btc.encode(new Uint8Array([0xed,1,...raw]))}`};
}

it("verifies per-DID monitor attestations without a global export sequence",async()=>{
  const {pair,did:publicKey}=await key(),now=Math.floor(Date.now()/1000),did=`did:plc:${"a".repeat(24)}`,cid="bafkreiexample";
  const transfer=await signMonitorAttestation({type:"hail.plc-monitor-attestation",version:3,did,
    transfer_id:"00000000-0000-0000-0000-000000000000",operation_cid:cid,monitor_origin:"https://monitor.example.com",
    coverage_since:now-60,observed_at:now,bootstrap_cid:cid,bootstrap_state_digest:"A".repeat(43)},pair.privateKey);
  expect(await verifyMonitorAttestation(transfer,publicKey,now)).toMatchObject({version:3,did});
  const onboarding=await signOnboardingMonitorAttestation({type:"hail.plc-onboarding-monitor-attestation",version:2,did,
    operation_cid:cid,monitor_origin:"https://monitor.example.com",coverage_since:now-60,observed_at:now,
    bootstrap_state_digest:"A".repeat(43)},pair.privateKey);
  expect(await verifyOnboardingMonitorAttestation(onboarding,publicKey,now)).toMatchObject({version:2,did});
});
