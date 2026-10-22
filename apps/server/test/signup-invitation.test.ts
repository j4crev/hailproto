import { randomBytes } from "node:crypto";
import { encodeBase64Url } from "@hailproto/codec/base64url";
import { expect,it } from "vitest";
import { createSignupInvitation,verifySignupInvitation } from "../src/onboarding/invitation.js";

it("binds an invitation to one provider, purpose, signing key and bounded admission lifetime",()=>{
  const key=encodeBase64Url(randomBytes(32)),origin="https://provider.example.com",now=1_790_000_000;
  const invitation=createSignupInvitation(origin,key,now),id=verifySignupInvitation(invitation,origin,key,now);
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(verifySignupInvitation(invitation,origin,key,now+3600)).toBe(id);
  expect(()=>verifySignupInvitation(invitation,"https://other.example.com",key,now)).toThrow();
  expect(()=>verifySignupInvitation(invitation,origin,encodeBase64Url(randomBytes(32)),now)).toThrow();
  expect(()=>verifySignupInvitation(invitation,origin,key,now+7*86400)).toThrow();
  expect(()=>verifySignupInvitation(invitation,origin,key,now-301)).toThrow();
  expect(()=>verifySignupInvitation(invitation+".extra",origin,key,now)).toThrow();
  expect(()=>verifySignupInvitation("x".repeat(2049),origin,key,now)).toThrow();
  expect(()=>createSignupInvitation("http://provider.example.com",key,now)).toThrow();
});
