import { env } from "$env/dynamic/private";
import { error,redirect } from "@sveltejs/kit";
import { AccountApiClient,AccountApiError } from "../../../../cli/src/account-api.js";

export const PROVIDER = env.HAIL_GUI_PROVIDER?.replace(/\/$/,"")||"https://haili.app";
export const API_ORIGIN=env.HAIL_GUI_API_ORIGIN?.replace(/\/$/,"")||PROVIDER;
export const ORIGIN=env.HAIL_GUI_ORIGIN?.replace(/\/$/,"")||PROVIDER;
type Cookies={get(name:string):string|undefined;delete?(name:string,options:{path:string}):void};

export function isConfigured(cookies?:Cookies): boolean {
  return Boolean(cookies?.get("hail_session")||env.HAIL_GUI_CREDENTIAL_FALLBACK==="true"&&env.HAIL_GUI_CREDENTIAL_FILE);
}

export async function bootstrapAccount() {
  const credentialFile = env.HAIL_GUI_CREDENTIAL_FILE;
  if (!credentialFile) error(503, "Set HAIL_GUI_CREDENTIAL_FILE to the canary account credential file");
  const client = await AccountApiClient.fromCredentialFile(credentialFile, { provider: PROVIDER,transport:API_ORIGIN });
  const account = await client.account();
  return { account, client };
}

export async function canaryAccount(cookies?:Cookies) {
  const session=cookies?.get("hail_session");
  if(session){
    const client=AccountApiClient.fromSession(PROVIDER,session,ORIGIN,API_ORIGIN);
    try{return {account:await client.account(),client};}
    catch(error_){if(error_ instanceof AccountApiError&&error_.status===401){cookies?.delete?.("hail_session",{path:"/"});redirect(303,"/auth/login");}throw error_;}
  }
  if(env.HAIL_GUI_CREDENTIAL_FALLBACK==="true")return bootstrapAccount();
  redirect(303,"/auth/login");
}

export async function senderAvatars(client: AccountApiClient, senderDids: Set<string>) {
  const avatars=new Map<string,{src:string;width:number;height:number}|null>();
  await Promise.all([...senderDids].map(async did=>{
    let avatar:{src:string;width:number;height:number}|null=null;
    try {
      const {payload}=await client.senderProfile(did);
      const asset=payload.version===2?payload.assets?.assets[0]:undefined;
      if(asset?.role==="avatar")avatar={src:`data:image/png;base64,${Buffer.from(asset.data).toString("base64")}`,
        width:asset.width,height:asset.height};
    } catch { /* A missing current profile must not hide a message. */ }
    avatars.set(did,avatar);
  }));
  return avatars;
}
