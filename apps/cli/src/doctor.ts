import {AccountApiError,type AccountApiClient,ACCOUNT_API_SCOPES} from "./account-api.js";
import {ClientError} from "./client-error.js";

export async function doctor(client:AccountApiClient,required:string[]=[],inspectAccount=true,action?:string){
  if(required.some(scope=>!ACCOUNT_API_SCOPES.includes(scope as typeof ACCOUNT_API_SCOPES[number])))throw new ClientError("USAGE_ERROR","Unknown required scope");
  const checks:Record<string,unknown>={},blockers:{code:string;message:string}[]=[];
  const failure=(error:unknown)=>({code:error instanceof AccountApiError?error.code:error instanceof ClientError?error.code:"CLIENT_ERROR",
    message:error instanceof Error?error.message:"Diagnostic failed"});
  try{
    const capabilities=await client.request("/capabilities",undefined,"/api/v1");
    if(capabilities.type!=="hailp.capabilities"||capabilities.version!==1||!capabilities.features||!capabilities.signup)
      throw new ClientError("RESPONSE_ERROR","Invalid provider capabilities");
    checks.provider={reachable:true,...capabilities};
    if(action&&Array.isArray(capabilities.passkeyRequired)&&capabilities.passkeyRequired.includes(action))blockers.push({code:"PASSKEY_REQUIRED",message:`${action} requires a passkey`});
    if((capabilities.signup as {mode?:string}).mode==="invite")blockers.push({code:"SIGNUP_INVITATION_REQUIRED",message:"Signup requires an invitation"});
  }catch(error){checks.provider={reachable:error instanceof AccountApiError,error:failure(error)};blockers.push(failure(error));}
  if(inspectAccount)try{
    const account=await client.account();checks.account=account;
    for(const scope of required)if(!account.scopes.includes(scope as typeof ACCOUNT_API_SCOPES[number]))blockers.push({code:"MISSING_SCOPE",message:`This workflow requires ${scope}; select an explicitly authorized credential`});
    if(account.credential&&Date.parse(account.credential.expiresAt)<=Date.now())blockers.push({code:"CREDENTIAL_EXPIRED",message:"Selected credential has expired"});
    if(account.migrationState)blockers.push({code:"ACCOUNT_FENCED",message:`Account migration state is ${account.migrationState}`});
  }catch(error){checks.account={error:failure(error)};blockers.push(failure(error));}
  if(!inspectAccount&&required.length)blockers.push({code:"CREDENTIAL_REQUIRED",message:"Select a credential to check required scopes"});
  return {readOnly:true,checks,blockers,ok:blockers.length===0};
}
