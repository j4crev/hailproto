import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { decodeBase64Url, encodeBase64Url } from "@hailproto/codec/base64url";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";

function signature(payload: string, key: string) {
  return createHmac("sha256", decodeBase64Url(key,32)).update(`hail.signup.invitation.v1\0${payload}`).digest();
}
export function createSignupInvitation(origin: string, key: string, now = Math.floor(Date.now()/1000)) {
  const url=new URL(origin);
  if(url.protocol!=="https:"||url.origin!==origin)throw new Error("Invitation requires a canonical HTTPS provider origin");
  const payload=encodeBase64Url(new TextEncoder().encode(JSON.stringify({type:"hail.signup.invitation",version:1,
    id:randomUUID(),provider:origin,issuedAt:now,expiresAt:now+7*86400})));
  return `${payload}.${encodeBase64Url(signature(payload,key))}`;
}
export function verifySignupInvitation(token: string, origin: string, key: string, now = Math.floor(Date.now()/1000)): string {
  if(token.length>2048)throw new Error("Invalid invitation");
  const [payload,supplied,...extra]=token.split(".");
  if(!payload||!supplied||extra.length||!timingSafeEqual(Buffer.from(decodeBase64Url(supplied,32)),signature(payload,key)))throw new Error("Invalid invitation");
  const value=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(decodeBase64Url(payload))) as Record<string,unknown>;
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==6||value.type!=="hail.signup.invitation"||value.version!==1||
    value.provider!==origin||typeof value.id!=="string"||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value.id)||
    typeof value.issuedAt!=="number"||!Number.isSafeInteger(value.issuedAt)||typeof value.expiresAt!=="number"||!Number.isSafeInteger(value.expiresAt)||
    value.issuedAt>now+300||value.expiresAt<=now||value.expiresAt<=value.issuedAt||value.expiresAt-value.issuedAt>7*86400)throw new Error("Expired or invalid invitation");
  return value.id;
}
