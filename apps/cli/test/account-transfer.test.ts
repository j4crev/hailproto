import {createHash,randomBytes,randomUUID} from "node:crypto";
import {mkdtemp,readFile,rm,stat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {decodeBase64Url,decodeDeterministic,encodeBase64Url,encodeDeterministic,type HailValue} from "@hailproto/codec";
import {base58btc} from "multiformats/bases/base58";
import {expect,it,vi} from "vitest";
import {createUserVault} from "../src/vault.js";
import {cancelTransfer,transferOffer,transferStatus,selectTransferAddress} from "../src/account-transfer.js";
import type {AccountApiClient} from "../src/account-api.js";

it("reviews signed Offers and cancels with identity-only exact retries, rejecting changed subjects and stale evidence", async () => {
  const generated=await createUserVault(),directory=await mkdtemp(join(tmpdir(),"hail-transfer-"));
  const hash=(bytes:Uint8Array)=>new Uint8Array(createHash("sha256").update(bytes).digest());
  const operational=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]);
  const key=`did:key:${base58btc.encode(new Uint8Array([0xed,1,...new Uint8Array(await crypto.subtle.exportKey("raw",operational.publicKey))]))}`;
  const sign=async (value:Record<string,HailValue>)=>{
    const bytes=encodeDeterministic(value),tag=new TextEncoder().encode(`${value.type}.v1\0`),input=new Uint8Array(tag.length+bytes.length);
    input.set(tag);input.set(bytes,tag.length);
    return {payload:encodeBase64Url(bytes),signature:encodeBase64Url(new Uint8Array(await crypto.subtle.sign("Ed25519",operational.privateKey,input)))};
  };
  try {
    const vault=structuredClone(generated.vault);vault.did=`did:plc:${"a".repeat(24)}`;vault.recovery.ciphertext="AA";
    const vaultPath=join(directory,"vault.json"),path=join(directory,"state.json");
    await writeFile(vaultPath,JSON.stringify(vault),{mode:0o600});
    const account={provider:"https://source.example.com",accountId:randomUUID(),did:vault.did,identityPublicKey:vault.identity.publicDidKey,
      custodyProfile:"owner-controlled",migrationState:null as string|null,scopes:["account:read","account:write"]};
    let offer:Awaited<ReturnType<typeof sign>>|undefined,receipt:Awaited<ReturnType<typeof sign>>|undefined;
    let approval:Record<string,any>,lostOffer=true,lostCancel=true,confirmed=true;
    const requests:{path:string;body:unknown}[]=[];
    const status=()=>({type:"hailp.transfer-status",version:1,...account,phase:account.migrationState??"offer-ready",nonce:approval.nonce,
      transferId:offer?(decodeDeterministic(decodeBase64Url(offer.payload)) as Record<string,any>).transfer_id:null,
      destinationServiceBase:approval.destination_service_base,originConfirmed:confirmed,offer});
    const client={account:async()=>({...account}),request:async(endpoint:string,body?:{payload:string;signature:string})=>{
      requests.push({path:endpoint,body});
      if(endpoint==="/transfers")return status();
      if(endpoint==="/transfers/offer") {
        approval=decodeDeterministic(decodeBase64Url(body!.payload)) as Record<string,any>;
        if(!offer)offer=await sign({type:"hail.transfer-offer",version:1,did:account.did,nonce:approval.nonce,transfer_id:randomUUID(),
          source_service_base:approval.source_service_base,destination_service_base:approval.destination_service_base,
          grant_digest:hash(decodeBase64Url(body!.payload)),invitation_digest:randomBytes(32),invitation_challenge:randomBytes(32),
          destination_rotation_key:generated.vault.recovery.publicDidKey,destination_messaging_key:key,
          issued_at:approval.issued_at,expires_at:approval.expires_at});
        if(lostOffer){lostOffer=false;throw new Error("Lost Offer response");}return status();
      }
      const cancellation=decodeDeterministic(decodeBase64Url(body!.payload)) as Record<string,any>;
      if(!receipt)receipt=await sign({type:"hail.transfer-cancellation-receipt",version:1,did:account.did,nonce:cancellation.nonce,
        grant_digest:cancellation.grant_digest,invitation_digest:(decodeDeterministic(decodeBase64Url(offer!.payload)) as Record<string,any>).invitation_digest,
        destination_domain:"target.example.com",source_service_base:`${account.provider}/hail`,issued_at:cancellation.issued_at,expires_at:cancellation.issued_at+604800});
      if(lostCancel){lostCancel=false;throw new Error("Lost cancellation response");}
      return {type:"hailp.transfer-cancellation",version:1,cancelled:true,sourceMessagingPublicKey:key,receipt};
    }} as unknown as AccountApiClient;
    let prompts=0;const secret=async()=>{prompts++;return encodeBase64Url(generated.recoverySecret);};
    const prepare=(destination="https://target.example.com")=>transferOffer(client,destination,vaultPath,path,secret);
    await expect(prepare("http://target.example.com")).rejects.toThrow("canonical public HTTPS");
    await expect(prepare()).rejects.toThrow("Lost Offer");
    expect((await prepare()).phase).toBe("offer-ready");
    expect(prompts).toBe(1);
    expect(requests.filter(r=>r.path==="/transfers/offer")[0]!.body).toEqual(requests.filter(r=>r.path==="/transfers/offer")[1]!.body);
    expect((await stat(path)).mode&0o777).toBe(0o600);
    expect((await transferStatus(client)).phase).toBe("offer-ready");
    await expect(prepare("https://other.example.com")).rejects.toThrow("changed");
    confirmed=false;await expect(prepare()).rejects.toThrow("destination-origin");confirmed=true;
    const original=offer!,payload=decodeDeterministic(decodeBase64Url(original.payload)) as Record<string,HailValue>;
    offer=await sign({...payload,transfer_id:randomUUID()});await expect(prepare()).rejects.toThrow("Offer changed");
    offer=await sign({...payload,destination_service_base:"https://other.example.com/hail"});await expect(prepare()).rejects.toThrow("reviewed DID");
    offer=await sign({...payload,issued_at:1,expires_at:2});await expect(prepare()).rejects.toThrow("reviewed DID");offer=original;
    account.custodyProfile="managed";await expect(prepare()).rejects.toThrow("owner-controlled");account.custodyProfile="owner-controlled";
    account.scopes=["account:read"];await expect(prepare()).rejects.toThrow("write authority");account.scopes.push("account:write");
    const selectionPath=join(directory,"selection-state.json");
    await writeFile(selectionPath,await readFile(path),{mode:0o600});
    let reservation:Awaited<ReturnType<typeof sign>>,lostReservation=true,badReservation=false,reservationStatus=202,targetPending=true;
    const targetRequests:{url:string;body:any}[]=[];
    const transport=(async(url:string,init:RequestInit)=>{
      expect(init.redirect).toBe("error");expect(init.credentials).toBe("omit");expect(new Headers(init.headers).has("Authorization")).toBe(false);
      const body=JSON.parse(init.body as string);targetRequests.push({url,body});
      if(url.endsWith("/cancellations")) {
        expect(body.cancellation).toEqual(JSON.parse(await readFile(path,"utf8")).cancellation);
        expect(body.receipt).toEqual(receipt);
        if(targetPending){targetPending=false;return new Response(null,{status:503});}return new Response(null,{status:204});
      }
      expect(url).toBe("https://target.example.com/.well-known/hail/transfers/reservations");
      const selection=decodeDeterministic(decodeBase64Url(body.payload)) as Record<string,any>;
      if(!reservation)reservation=await sign({type:"hail.transfer-reservation",version:1,did:selection.did,nonce:selection.nonce,
        transfer_id:selection.transfer_id,offer_digest:selection.offer_digest,selection_digest:hash(decodeBase64Url(body.payload)),
        address:selection.address,issued_at:selection.issued_at,expires_at:selection.expires_at});
      if(lostReservation){lostReservation=false;throw new Error("Lost reservation response");}
      const wire=badReservation?await sign({...decodeDeterministic(decodeBase64Url(reservation.payload)) as Record<string,HailValue>,selection_digest:randomBytes(32)}):reservation;
      return new Response(JSON.stringify(wire),{status:reservationStatus,headers:{"Content-Type":"application/hail-transfer+json"}});
    }) as typeof fetch;
    const select=(username="alice")=>selectTransferAddress(client,username,vaultPath,selectionPath,secret,transport);
    await expect(select("alice..bob")).rejects.toThrow("canonical Hail");
    await expect(select()).rejects.toThrow("Lost reservation");
    expect((await select()).requestAcknowledged).toBe(false);
    expect(targetRequests[0]!.body).toEqual(targetRequests[1]!.body);
    await expect(select("bob")).rejects.toThrow("reviewed address/Offer");
    badReservation=true;await expect(select()).rejects.toThrow("signed selection");badReservation=false;
    account.migrationState="fenced";reservationStatus=200;
    expect((await select()).requestAcknowledged).toBe(true);
    expect(prompts).toBe(2);account.migrationState=null;
    account.migrationState="fenced";await expect(cancelTransfer(client,vaultPath,path,secret)).rejects.toThrow("original owner-controlled");account.migrationState=null;
    const cancel=()=>cancelTransfer(client,vaultPath,path,secret,transport);
    await expect(cancel()).rejects.toThrow("Lost cancellation");
    await expect(cancel()).rejects.toThrow("Destination cancellations response invalid");
    const clock=vi.spyOn(Date,"now").mockReturnValue(Date.now()+3601*1000);
    try {expect(await cancel()).toMatchObject({cancelled:true,targetAcknowledged:true});}finally{clock.mockRestore();}
    expect(prompts).toBe(3);
    const cancellations=requests.filter(r=>r.path==="/transfers/cancel");expect(cancellations[0]!.body).toEqual(cancellations[1]!.body);
    await expect(prepare()).rejects.toThrow("cancelled");
    const saved=JSON.parse(await readFile(path,"utf8"));expect(saved.receipt).toEqual(receipt);
    receipt=await sign({...decodeDeterministic(decodeBase64Url(receipt!.payload)) as Record<string,HailValue>,invitation_digest:randomBytes(32)});
    await writeFile(path,JSON.stringify({...saved,receipt}));
    await expect(cancel()).rejects.toThrow("original transfer");
  }finally{generated.recoverySecret.fill(0);await rm(directory,{recursive:true,force:true});}
});
