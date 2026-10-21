import { env } from "$env/dynamic/private";
import { error } from "@sveltejs/kit";
import { AccountApiClient } from "../../../../cli/src/account-api.js";

const ADDRESS = "canary@haili.app";
const PROVIDER = "https://haili.app";

export function isConfigured(): boolean {
  return Boolean(env.HAIL_GUI_CREDENTIAL_FILE);
}

export async function canaryAccount() {
  const credentialFile = env.HAIL_GUI_CREDENTIAL_FILE;
  if (!credentialFile) error(503, "Set HAIL_GUI_CREDENTIAL_FILE to the canary account credential file");

  const client = await AccountApiClient.fromCredentialFile(credentialFile, { provider: PROVIDER });
  const account = await client.account();
  if (account.address !== ADDRESS) error(403, `The selected credential is not for ${ADDRESS}`);
  return { account, client };
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
