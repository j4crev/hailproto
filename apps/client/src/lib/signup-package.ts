import { decodeBase64Url, encodeBase64Url } from "@hailproto/codec/base64url";
import { readRecoveryPackage, extractRecoveryVault, type RecoveryPackage } from "../../../../packages/hail-client-support/src/recovery-package.js";
import { openPending, pendingKey, sealPending, type PendingSignup, type SignupPolicy } from "./signup.js";
export { readRecoveryPackage };

export async function makeRecoveryPackage(pending: PendingSignup, key: CryptoKey): Promise<string> {
  if (!pending.operation || !pending.did) throw new Error("Sign the original identity before saving");
  const value: RecoveryPackage = {type:"hail.recovery-package",version:1,
    vault:{...pending.vault,did:pending.did},operation:pending.operation,setup:await sealPending(pending,key)};
  const text=JSON.stringify(value,null,2);
  await readRecoveryPackage(text);
  return text;
}
export async function openRecoveryPackage(text:string, secret:string, policy:SignupPolicy, expected?:PendingSignup) {
  const raw=decodeBase64Url(secret,32);
  try {
    const vault=await extractRecoveryVault(text,raw),file=await readRecoveryPackage(text),key=await pendingKey(secret);
    const pending=await openPending(file.setup,key,policy);
    if(JSON.stringify({...pending.vault,did:pending.did})!==JSON.stringify(vault)||
       JSON.stringify(pending.operation)!==JSON.stringify(file.operation)||
       expected&&(pending.signupId!==expected.signupId||pending.token!==expected.token||
         pending.enrollmentToken!==expected.enrollmentToken||pending.address!==expected.address||
         JSON.stringify(pending.operation)!==JSON.stringify(expected.operation)))throw new Error("This is not the saved package for this setup");
    return {pending,key};
  } finally {raw.fill(0);}
}

// A commitment proves which saved identity was verified without giving the
// provider its publishable signature before the user confirms publication.
export async function recoveryOperationDigest(operation:NonNullable<PendingSignup["operation"]>){
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(operation)))));
}
