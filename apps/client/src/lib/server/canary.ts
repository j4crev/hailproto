import {accountRead} from "./account-reads.js";
import { env } from "$env/dynamic/private";
import { error,redirect } from "@sveltejs/kit";
import { AccountApiClient,AccountApiError } from "../../../../../packages/hail-client-support/src/account-api.js";
import {loginPath} from "$lib/auth-routing.js";

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

export function canaryAccount(cookies?:Cookies,url?:URL) {
  return accountRead(cookies?.get("hail_session") ?? "credential-fallback", () => loadAccount(cookies,url));
}

async function loadAccount(cookies?:Cookies,url?:URL) {
  const session=cookies?.get("hail_session");
  if(session){
    const client=AccountApiClient.fromSession(PROVIDER,session,ORIGIN,API_ORIGIN);
    try{return {account:await client.account(),client};}
    catch(error_){if(error_ instanceof AccountApiError&&error_.status===401){cookies?.delete?.("hail_session",{path:"/"});redirect(303,loginPath(url));}throw error_;}
  }
  if(env.HAIL_GUI_CREDENTIAL_FALLBACK==="true")return bootstrapAccount();
  redirect(303,loginPath(url));
}

export async function senderAvatars(client: AccountApiClient, senderDids: Set<string>) {
  // Browser image requests run after page rendering; no API/identity wait here.
  return new Map([...senderDids].filter(did=>/^did:plc:[a-z2-7]{24}$/.test(did)).map(did=>[did,{
    src:`/api/v1/account/senders/${encodeURIComponent(did)}/avatar/image`,width:44,height:44,
  }]));
}
