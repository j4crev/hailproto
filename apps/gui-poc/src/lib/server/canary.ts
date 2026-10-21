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

export async function senderAddresses(client: AccountApiClient, senderDids: Set<string>): Promise<Map<string, string>> {
  let grantPage: Record<string, unknown>;
  try { grantPage = await client.request("/grants"); }
  catch { return new Map(); }
  const grantRows = Array.isArray(grantPage.grants) ? grantPage.grants : [];
  const relevantGrantIds = grantRows.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    return row.localRole === "grantor" && row.status === "active" && typeof row.grantee === "string" &&
      senderDids.has(row.grantee) && typeof row.grantId === "string" ? [row.grantId] : [];
  });
  const addresses = new Map<string, string>();
  await Promise.all(relevantGrantIds.map(async (id) => {
    try {
      const { payload } = await client.grant(id);
      addresses.set(payload.grantee, payload.consent_context.grantee_address);
    } catch { /* A missing display hint must not hide a message. */ }
  }));
  return addresses;
}

export interface SenderPresentation {
  address: string | null;
  avatar: { src: string; width: number; height: number } | null;
}

export async function senderPresentations(client: AccountApiClient, senderDids: Set<string>): Promise<Map<string, SenderPresentation>> {
  const addresses=await senderAddresses(client,senderDids),presentations=new Map<string,SenderPresentation>();
  await Promise.all([...senderDids].map(async did=>{
    let avatar:SenderPresentation["avatar"]=null;
    try {
      const {payload}=await client.senderProfile(did);
      const asset=payload.version===2?payload.assets?.assets[0]:undefined;
      if(asset?.role==="avatar")avatar={src:`data:image/png;base64,${Buffer.from(asset.data).toString("base64")}`,
        width:asset.width,height:asset.height};
    } catch { /* A missing current profile must not hide a message. */ }
    presentations.set(did,{address:addresses.get(did)??null,avatar});
  }));
  return presentations;
}
