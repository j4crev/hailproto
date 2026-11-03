import {canaryAccount} from '$lib/server/canary.js';
import {parseDraftList} from '@racrproto/client-support/drafts';
export async function load({cookies,url}){
  const {account,client}=await canaryAccount(cookies,url),after=url.searchParams.get('after');
  const [result,preferences]=await Promise.all([client.request('/drafts'+(after?'?after='+encodeURIComponent(after):''),undefined,'/api/v1/account',20_000_000),client.request('/message-preferences')]);
  return {account,...parseDraftList(result),paged:after!==null,trashEnabled:preferences.trashEnabled!==false};
}
