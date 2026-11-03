import {parseDraftList} from "@racrproto/client-support/drafts";
import {canaryAccount,senderAvatars} from '$lib/server/canary.js';
import {parseMessage,messageListSummary,parseSentSends} from '$lib/messages.js';
export async function load({cookies,url}){
  const {account,client}=await canaryAccount(cookies,url);
  const after=url.searchParams.get('after');
  const [result,preferences,sentResult,draftsResult]=await Promise.all([
    client.request('/trash'+(after?'?after='+encodeURIComponent(after):''),undefined,'/api/v1/account',2_000_000),
    client.request('/message-preferences'),
    client.request('/sent?include=sends&trash=true'+(url.searchParams.get('sentAfter')?'&after='+encodeURIComponent(url.searchParams.get('sentAfter')!):''),undefined,'/api/v1/account',2_000_000),
    client.request('/drafts?trash=true'+(url.searchParams.get('draftAfter')?'&after='+encodeURIComponent(url.searchParams.get('draftAfter')!):''),undefined,'/api/v1/account',20_000_000),
  ]);
  if(!Array.isArray(result.messages)||!(result.next===null||typeof result.next==='string'))throw new Error('Invalid Trash response');
  const messages=result.messages.map((row:any)=>{
    if(typeof row.trashedAt!=='string'||!Number.isFinite(Date.parse(row.trashedAt)))throw new Error('Invalid Trash date');
    const message=parseMessage(row);return {...message,trashedAt:row.trashedAt,...messageListSummary(message)};
  });
  const avatars=await senderAvatars(client,new Set<string>(messages.map(message=>message.sender)));
  return {drafts:parseDraftList(draftsResult),draftPaged:url.searchParams.has('draftAfter'),sent:parseSentSends(sentResult),sentPaged:url.searchParams.has('sentAfter'),account,trashEnabled:preferences.trashEnabled!==false,paged:after!==null,next:result.next,messages:messages.map(message=>({...message,avatar:avatars.get(message.sender)??null}))};
}
