import { decodeBase64Url, encodeDeterministic, inspectSignedPayload, verifySignedPayload, createWebCryptoVerifier, type HailGrantScope, type HailValue } from "@hailproto/codec";
import { isDeepStrictEqual } from "node:util";
import { base58btc } from "multiformats/bases/base58";
import { privateFile, savePrivateBytes } from "./grant-revocation.js";
import { unlockUserIdentity, type UserVaultFile } from "./vault.js";
import { readRecoverySecret } from "./cli/private-input.js";
import type { AccountApiClient } from "./account-api.js";

export function selectedScope(category:string|string[]|null):HailGrantScope {
  if(category===null)return {type:"uncategorized"};
  const values=typeof category==="string"?[category]:category;
  if(!values.length||new Set(values).size!==values.length||values.some(value=>!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)))throw new Error("Select unique category IDs; wildcards are not allowed");
  return {type:"categories",values:[...values].sort()};
}
export const sameGrantValue=(a:unknown,b:unknown)=>Buffer.from(encodeDeterministic(a as HailValue)).equals(Buffer.from(encodeDeterministic(b as HailValue)));
export async function createGrant(client: AccountApiClient, sender: string, category: string|string[] | null,
  vaultPath: string, output: string, expiresAt?: number | null) {
  const account = await client.account();
  const scope=selectedScope(category);
  if (account.migrationState || !account.scopes.includes("grants:write")) throw new Error("Account cannot write Grants");
  if(account.custodyProfile==="managed") {
    if(vaultPath)throw new Error("Managed signing does not take the owner's identity vault");
    const path=`${output}.request.json`;
    let input:{sender:string;category:string|string[]|null;expiresAt:number|null};
    try{input=JSON.parse(new TextDecoder().decode(await privateFile(path,16384)));}
    catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="ENOENT"))throw error;
      input={sender,category,expiresAt:expiresAt===undefined?Math.floor(Date.now()/1000)+7*86400:expiresAt};
      await savePrivateBytes(path,new TextEncoder().encode(JSON.stringify(input)));}
    if(input.sender!==sender||!isDeepStrictEqual(selectedScope(input.category),scope)||(expiresAt!==undefined&&input.expiresAt!==expiresAt))throw new Error("Managed Grant retry changed requested permission");
    const result=await client.request("/grants/managed",Array.isArray(input.category)?{sender:input.sender,scope,expiresAt:input.expiresAt}:input);
    const grant=await client.grant(result.grantId as string);
    try{await savePrivateBytes(output,grant.representation);}catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="EEXIST"))throw error;
      if(!Buffer.from(await privateFile(output,262144)).equals(Buffer.from(grant.representation)))throw new Error("Managed Grant output conflicts");}
    return result;
  }
  if(!vaultPath)throw new Error("Owner-controlled Grant creation requires --vault");
  let saved: Uint8Array | null = null;
  try { saved = await privateFile(output,262_144); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const expiry = expiresAt === undefined ? saved ? inspectSignedPayload("hail.grant",saved).payload.expires_at :
    Math.floor(Date.now()/1000)+7*86400 : expiresAt;
  const payload = saved ? inspectSignedPayload("hail.grant",saved).payload : await client.propose(sender,category,expiry);
  if (payload.grantor !== account.did || payload.status !== "active" || payload.revision !== 1 || payload.previous !== null ||
    payload.consent_context.grantee_address !== sender.toLowerCase() || payload.expires_at !== expiry ||
    !sameGrantValue(payload.scope,[scope])) {
    throw new Error("Grant proposal or saved output does not match the requested permission");
  }
  const secret = decodeBase64Url(await readRecoverySecret());
  try {
    const user = await unlockUserIdentity(JSON.parse(new TextDecoder().decode(await privateFile(vaultPath,16_384))) as UserVaultFile,secret);
    if (user.vault.did !== account.did) throw new Error("Vault does not belong to the authenticated account");
    const signed = saved ?? await user.signGrant(payload);
    const publicBytes = base58btc.decode(user.vault.identity.publicDidKey.slice(8));
    await verifySignedPayload("hail.grant",signed,createWebCryptoVerifier(async kid => {
      if (kid !== `${account.did}#hail-identity`) throw new Error("Wrong Grant signer");
      return crypto.subtle.importKey("raw",Uint8Array.from(publicBytes.slice(2)),"Ed25519",false,["verify"]);
    }));
    if (!saved) await savePrivateBytes(output,signed);
    return client.submit(signed);
  } finally { secret.fill(0); }
}
