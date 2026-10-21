import { P256Keypair } from "@atproto/crypto";
import { cidForCbor } from "@atproto/common";
import { didForCreateOp, formatDidDoc, signOperation, validateOperationLog, type Operation } from "@did-plc/lib";
import { base58btc } from "multiformats/bases/base58";
import type { PlcDirectoryClient } from "../src/plc/client.js";
import { PlcHailDidResolver } from "../src/plc/resolver.js";
import type { IndependentPlcObserver } from "../src/plc/observers.js";

export async function publicEdKey(){
  const pair=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]);
  return {pair,didKey:`did:key:${base58btc.encode(new Uint8Array([0xed,1,...new Uint8Array(await crypto.subtle.exportKey("raw",pair.publicKey))]))}`};
}

export async function publicPlcFixture(base="https://peer.example.com/hail"){
  const owner=await P256Keypair.create(),identity=await publicEdKey(),messaging=await publicEdKey();
  const genesis=await signOperation({type:"plc_operation",prev:null,rotationKeys:[owner.did()],
    verificationMethods:{"hail-identity":identity.didKey,"hail-messaging":messaging.didKey},alsoKnownAs:[],
    services:{hail:{type:"HailMessaging",endpoint:base}}},owner);
  return {did:await didForCreateOp(genesis),owner,identity,messaging,log:[genesis] as Operation[]};
}

export function publicPlcReaders(fixtures: Awaited<ReturnType<typeof publicPlcFixture>>[]):[IndependentPlcObserver,IndependentPlcObserver]{
  const read=(did:string)=>{const fixture=fixtures.find(entry=>entry.did===did);if(!fixture)throw new Error("Unknown fixture DID");return fixture;};
  const plc:PlcDirectoryClient={
    async health(){return{};},async sendOperation(){throw new Error("Read-only fixture");},
    async getOperationLog(did){return read(did).log;},
    async getDocumentData(did){return (await validateOperationLog(did,read(did).log))!;},
    async getDocument(did){return formatDidDoc(await this.getDocumentData(did));},
    async getAuditableLog(did){return Promise.all(read(did).log.map(async(operation,index)=>({did,operation,
      cid:(await cidForCbor(operation)).toString(),nullified:false,createdAt:new Date(1_800_000_000_000+index*1000).toISOString()})));},
  };
  const reader=(name:string)=>({origin:`https://reader-${name}.example.com`,operator:`reader-${name}`,
    resolver:new PlcHailDidResolver(plc),audit:(did:string)=>plc.getAuditableLog(did),
    health:async()=>({lastCommittedOpTime:new Date().toISOString()})});
  return [reader("one"),reader("two")];
}
