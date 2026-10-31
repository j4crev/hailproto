export interface ConversationRow {
  sender:string;messageId:string;sent:boolean;isRead:boolean;createdAt:string;senderAddress:string|null;title:string;preview:string;
  recipients:{did:string;address:string|null}[];
}
export interface ConversationPage {selected:{sender:string;messageId:string;sent:boolean};total:number;start:number;newerUnread:number;messages:ConversationRow[]}
const did=/^did:plc:[a-z2-7]{24}$/,id=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const conversationKey=(m:{sender:string;messageId:string})=>m.sender+'/'+m.messageId;
export function parseConversation(value:unknown):ConversationPage {
  const page=value as ConversationPage;
  if(!page||!page.selected||!did.test(page.selected.sender)||!id.test(page.selected.messageId)||typeof page.selected.sent!=='boolean'||
    !Number.isSafeInteger(page.total)||page.total<1||!Number.isSafeInteger(page.start)||page.start<0||!Number.isSafeInteger(page.newerUnread)||page.newerUnread<0||
    !Array.isArray(page.messages)||page.messages.length>30||page.start+page.messages.length>page.total)throw Error('Invalid conversation');
  for(const row of page.messages)if(!row||!did.test(row.sender)||!id.test(row.messageId)||typeof row.sent!=='boolean'||typeof row.isRead!=='boolean'||
    typeof row.createdAt!=='string'||!Number.isFinite(Date.parse(row.createdAt))||typeof row.title!=='string'||typeof row.preview!=='string'||row.senderAddress!==null&&typeof row.senderAddress!=='string'||
    !Array.isArray(row.recipients)||row.recipients.some(r=>!r||!did.test(r.did)||r.address!==null&&typeof r.address!=='string'))throw Error('Invalid conversation row');
  return page;
}
