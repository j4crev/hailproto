import {expect,it} from "vitest";
import {connectionCode,connectApproval} from "./connections.js";
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
it("validates resumable exact-action reviews without treating an expired review as approval",()=>{
  const review={requestId:"01954144-8097-7a9d-a7a8-ef29a823eaf1",action:"connect",review:{address:"friend@example.com"},
    expiresAt:new Date(Date.now()+300000).toISOString(),result:null,options:{challenge:"x"}};
  expect(connectApproval(review)).toEqual(review);
  expect(()=>connectApproval({...review,options:null})).toThrow();
  expect(connectApproval({...review,options:null,expiresAt:new Date(0).toISOString()}).result).toBeNull();
  expect(()=>connectApproval({...review,action:"subscribe"})).toThrow();
});
