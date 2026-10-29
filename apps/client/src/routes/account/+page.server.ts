import {loadAccountSecurity} from "$lib/server/account-security.js";
import {editableProfile, type ProfileDefinition} from "$lib/sender-profile.js";
import {AccountApiError} from "../../../../cli/src/account-api.js";
import {canaryAccount} from "$lib/server/canary.js";
export async function load({cookies, url}) {
  const {account, client} = await canaryAccount(cookies, url);
  const [profile,security]=await Promise.all([
    client.profile().catch(cause=>{if(cause instanceof AccountApiError && cause.status===404)return null;throw cause;}),
    loadAccountSecurity(client),
  ]);
  let revision = 0;
  let definition: ProfileDefinition = {version: 2, display_name: account.address.split('@')[0], offers_uncategorized: false, categories: [{id: "general", label: "General"}]};
  if (profile) {
    const {payload}=profile;
    if (payload.did !== account.did) throw new Error("Sender Profile belongs to another account");
    revision = payload.revision;
    definition = editableProfile(payload);
  }
  return {account, revision, definition, security};
}
