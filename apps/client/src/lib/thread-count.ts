import {parseThread} from './threads.js';

export async function loadThreadCount(sender:string,messageId:string,signal:AbortSignal):Promise<{count:number;truncated:boolean}|null> {
  try {
    const response=await fetch(`/api/v1/account/threads/${encodeURIComponent(sender)}/${encodeURIComponent(messageId)}`,{
      credentials:'same-origin',cache:'no-store',redirect:'error',signal,
    });
    if(!response.ok)return null;
    const thread=parseThread(await response.json());
    const messages=new Map(thread.messages.map(message=>[JSON.stringify([message.sender,message.messageId]),message]));
    if(!messages.has(JSON.stringify([sender,messageId])))return null;
    const received=[...messages.values()].filter(message=>!message.sent);
    // Older providers do not expose read state. Never interpret missing state as unread.
    if(received.some(message=>message.isRead===undefined))return null;
    const count=received.filter(message=>message.isRead===false).length;
    return count>1?{count,truncated:thread.truncated}:null;
  } catch {return null;}
}
