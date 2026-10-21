import { createHash,randomBytes,randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { encodeBase64Url,decodeBase64Url } from "@hailproto/codec";
import { assureValidSig, didForCreateOp, type Operation } from "@did-plc/lib";
import { cidForCbor } from "@atproto/common";
import { AccountApiClient } from "./account-api.js";
import { privateFile,savePrivateBytes } from "./grant-revocation.js";
import { unlockUserVault,reviewManagedGenesis,type UserVaultFile } from "./vault.js";
import { readRecoverySecret } from "./cli/private-input.js";
import { MANAGED_CUSTODY_PROFILE_VERSION } from "./managed-profile.js";

export async function writeState(path:string,data:unknown) {
  const temporary=`${path}.tmp-${randomUUID()}`;
  await savePrivateBytes(temporary,new TextEncoder().encode(JSON.stringify(data)));
  await rename(temporary,path);
}
export async function createAccount(provider:string,address:string,custody:"owner-controlled"|"managed",
  vaultPath:string,statePath:string,credentialPath:string,recoveryInput:()=>Promise<string>=readRecoverySecret,
  monitor?:{origin:string;publicKey:string;attestationPath?:string}) {
  let state: {provider:string;address:string;custody:string;token:string;preparation?:Record<string,unknown>;
    operation?:Operation;binding?:string|null;did?:string;monitorOrigin?:string;monitorKey?:string};
  try {state=JSON.parse(new TextDecoder().decode(await privateFile(statePath,64000)));}
  catch(error) {
    if(!(error instanceof Error&&"code" in error&&error.code==="ENOENT"))throw error;
    state={provider,address,custody,token:`hailp_${encodeBase64Url(randomBytes(32))}`,
      ...(monitor?{monitorOrigin:monitor.origin,monitorKey:monitor.publicKey}:{})};
    await savePrivateBytes(statePath,new TextEncoder().encode(JSON.stringify(state)));
  }
  if(state.provider!==provider||state.address!==address||state.custody!==custody||state.monitorOrigin!==monitor?.origin||state.monitorKey!==monitor?.publicKey)throw new Error("Signup state belongs to another request");
  const secret=decodeBase64Url(await recoveryInput());
  try {
    const user=await unlockUserVault(JSON.parse(new TextDecoder().decode(await privateFile(vaultPath,16384))) as UserVaultFile,secret);
    const originallyUnbound=user.vault.did===null;
    const client=AccountApiClient.signup(provider,state.token);
    const prepared=state.preparation ?? await client.request("",{address,recoveryKey:user.vault.recovery.publicDidKey,
      identityKey:user.vault.identity.publicDidKey,custody,backupVerified:true,
       signupHash:encodeBase64Url(new Uint8Array(createHash("sha256").update(state.token).digest())),
       ...(monitor?{monitorOrigin:monitor.origin,monitorKey:monitor.publicKey}:{})},"/api/v1/onboarding");
    if(prepared.address!==address.toLowerCase()||prepared.userRecoveryKey!==user.vault.recovery.publicDidKey||prepared.custodyProfile!==custody||
      (custody==="managed" ? prepared.managedProfileVersion!==MANAGED_CUSTODY_PROFILE_VERSION &&
        (monitor!==undefined||prepared.managedProfileVersion!==undefined) :
        prepared.managedProfileVersion!==null&&prepared.managedProfileVersion!==undefined)||
      (custody==="owner-controlled"&&prepared.userIdentityKey!==user.vault.identity.publicDidKey)||
       prepared.sourceServiceBase!==`${provider}/hail`||typeof prepared.accountId!=="string"||
       !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(prepared.accountId)||
      typeof prepared.providerRotationKey!=="string"||typeof prepared.providerMessagingKey!=="string"||typeof prepared.userIdentityKey!=="string"||
       new Set([prepared.userRecoveryKey,prepared.providerRotationKey,prepared.providerMessagingKey,prepared.userIdentityKey]).size!==4||
       (monitor&&(prepared.monitorOrigin!==monitor.origin||prepared.monitorPublicKey!==monitor.publicKey)))throw new Error("Signup preparation does not match selected provider, custody and owner recovery");
    state.preparation=prepared;await writeState(statePath,state);
    const unsigned={type:"plc_operation" as const,prev:null,rotationKeys:[user.vault.recovery.publicDidKey,prepared.providerRotationKey],
      verificationMethods:{"hail-identity":prepared.userIdentityKey,"hail-messaging":prepared.providerMessagingKey},
      alsoKnownAs:[],services:{hail:{type:"HailMessaging",endpoint:`${provider}/hail`}}};
    if(custody==="managed")reviewManagedGenesis(unsigned,user.vault);
    if(!state.operation) {
      if(user.vault.did)throw new Error("Bound vault requires its original signup state");
      const signed=custody==="managed"?await user.signManagedGenesis(unsigned):await user.signPlcOperation(unsigned);
      await user.bindDid(signed.did,signed.operation,custody==="managed");
      state.operation=signed.operation;state.did=signed.did;
      const now=Math.floor(Date.now()/1000);
      state.binding=custody==="managed"?null:encodeBase64Url(await user.signAddressBinding({type:"hail.address-binding",version:1,
        address:address.toLowerCase(),did:signed.did,issued_at:now,expires_at:now+90*86400,key_id:`${signed.did}#hail-identity`}));
      await writeState(statePath,state);
    }
    const {sig,...retained}=state.operation;
    if(!isDeepStrictEqual(retained,unsigned)||await didForCreateOp(state.operation)!==state.did)throw new Error("Retained signup operation does not match the exact reviewed genesis");
    await assureValidSig([user.vault.recovery.publicDidKey],state.operation);
    if(user.vault.did===null) {await user.bindDid(state.did!,state.operation,custody==="managed");await writeState(vaultPath,user.vault);}
    else if(originallyUnbound)await writeState(vaultPath,user.vault);
    if(user.vault.did!==state.did)throw new Error("Signup state and vault DID differ");
    let monitorAttestation:Record<string,unknown>|undefined;
    if(monitor?.attestationPath) {
      monitorAttestation=JSON.parse(new TextDecoder().decode(await privateFile(monitor.attestationPath,16384)));
      if(!monitorAttestation||typeof monitorAttestation!=="object"||Array.isArray(monitorAttestation)||
        monitorAttestation.monitorDidKey!==monitor.publicKey||typeof monitorAttestation.payload!=="string"||
        typeof monitorAttestation.signature!=="string")throw new Error("Monitor attestation file does not match the selected monitor key");
    }
    const result=await client.request(`/${prepared.accountId}`,{operation:state.operation,binding:state.binding ?? null,
      ...(monitorAttestation?{monitor:{payload:monitorAttestation.payload,signature:monitorAttestation.signature}}:{})},"/api/v1/onboarding");
    if(monitor&&!monitorAttestation&&result.monitorRequired!==true)throw new Error("Public signup activated without the required monitor checkpoint");
    if(monitorAttestation&&result.monitorRequired===true)throw new Error("Provider did not accept the submitted monitor attestation");
    if(result.monitorRequired===true) {
      const operationCid=(await cidForCbor(state.operation)).toString();
      if(result.did!==state.did||result.operationCid!==operationCid)throw new Error("Provider monitor enrollment checkpoint differs from retained genesis");
      return {did:state.did,address,custody,stateFile:statePath,monitorRequired:true,operationCid};
    }
    const credential=result.credential as Record<string,unknown>;
    if(result.did!==state.did||!credential||credential.type!=="hailp.api-credential"||credential.version!==1||
      credential.provider!==provider||credential.accountId!==prepared.accountId||credential.token!==state.token||
      typeof credential.credentialId!=="string"||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(credential.credentialId)||
      !Array.isArray(credential.scopes)||credential.scopes.some(scope=>typeof scope!=="string")||
      typeof credential.expiresAt!=="string"||!Number.isFinite(Date.parse(credential.expiresAt)))throw new Error("Signup returned another account or credential");
    try {await savePrivateBytes(credentialPath,new TextEncoder().encode(JSON.stringify(credential)));}
    catch(error) {
      if(!(error instanceof Error&&"code" in error&&error.code==="EEXIST"))throw error;
      const saved=JSON.parse(new TextDecoder().decode(await privateFile(credentialPath,16384)));
      if(!isDeepStrictEqual(saved,credential))throw new Error("Credential output conflicts");
    }
    return {did:state.did,address,custody,credentialFile:credentialPath};
  } finally {secret.fill(0);}
}
