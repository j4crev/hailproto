import {expect,it} from "vitest";
import {connectionCode,connectionHomeLink,connectApproval,signedConnectionFile,type ConnectApproval} from "./connections.js";
import {encodeDeterministic} from "@hailproto/codec/cbor";
import {encodeBase64Url} from "@hailproto/codec/base64url";
import {returnPath} from "./auth-routing.js";

it("reads only a complete identity-pinned fragment code and keeps login destinations local",()=>{
  const value={id:"01954144-8097-7a9d-a7a8-ef29a823eaf1",did:"did:plc:"+"a".repeat(24),token:"x".repeat(43)};
  const fragment="#"+new URLSearchParams(value);
  expect(connectionCode(fragment)).toEqual(value);
  for(const bad of [fragment+"&token=extra",fragment+"&purpose=subscription",fragment.replace(encodeURIComponent(value.did),"someone"),fragment.replace(value.token,"short"),"#id=missing"])
    expect(()=>connectionCode(bad)).toThrow();
  expect(returnPath("/connect")).toBe("/connect");
  expect(returnPath("/connect?token=secret#token=secret")).toBe("/connect");
  expect(returnPath("https://evil.example/connect")).toBe("/");
});
it("keeps provider handoff fragment-only and rejects vault uploads before any network operation",()=>{
  const code={id:"01954144-8097-7a9d-a7a8-ef29a823eaf1",did:"did:plc:"+"a".repeat(24),token:"A".repeat(43)};
  const link=new URL(connectionHomeLink("https://home.example.com",code));expect(link.search).toBe("");expect(connectionCode(link.hash)).toEqual(code);
  for(const origin of ["http://home.example.com","https://home.example.com/login","https://user:password@home.example.com","https://127.0.0.1"])
    expect(()=>connectionHomeLink(origin,code)).toThrow();
  const payload={type:"hail.connection-invitation",version:1,invitation_id:code.id,from:code.did,token_hash:{algorithm:"sha-256",value:new Uint8Array(32)},issued_at:1,expires_at:null,key_id:code.did+"#hail-identity"};
  const proposal={payload:{...payload,token_hash:{algorithm:"sha-256",value:encodeBase64Url(new Uint8Array(32))}}} as unknown as NonNullable<ConnectApproval["ownerSigning"]>;
  const parts=encodeDeterministic([new Uint8Array([1]),{},encodeDeterministic(payload),new Uint8Array(64)]),cose=new Uint8Array(parts.length+1);cose[0]=0xd2;cose.set(parts,1);
  expect(signedConnectionFile(cose,proposal)).toBe(encodeBase64Url(cose));
  expect(()=>signedConnectionFile(new TextEncoder().encode(JSON.stringify({type:"hailp.user-vault",secret:"never-upload"})),proposal)).toThrow("not a vault");
  expect(()=>signedConnectionFile(cose,{...proposal,payload:{...proposal.payload,from:"did:plc:"+"b".repeat(24)}})).toThrow("exact consent");
});
it("validates resumable exact-action reviews without treating an expired review as approval",()=>{
  const review={requestId:"01954144-8097-7a9d-a7a8-ef29a823eaf1",action:"connect",review:{address:"friend@example.com"},
    expiresAt:new Date(Date.now()+300000).toISOString(),result:null,options:{challenge:"x"}};
  expect(connectApproval(review)).toEqual(review);
  expect(()=>connectApproval({...review,options:null})).toThrow();
  expect(connectApproval({...review,options:null,expiresAt:new Date(0).toISOString()}).result).toBeNull();
  expect(()=>connectApproval({...review,action:"subscribe"})).toThrow();
});
