import {expect,it} from 'vitest';
import {parseConversation} from './connection-threads.js';
import {parseInboxFeed} from './messages.js';
const sender='did:plc:'+'a'.repeat(24),messageId='019a15fd-2bd0-7433-8afa-bd0355e0608d';
const row={sender,messageId,sent:false,isRead:false,createdAt:'2026-10-31T00:00:00.000Z',senderAddress:'a@example.com',title:'Hello',preview:'A reply',recipients:[]};
const page={selected:{sender,messageId,sent:false},start:2,total:3,newerUnread:2,messages:[row]};
it('preserves the selected message and surrounding window without sorting by read state',()=>{
  expect(parseConversation(page)).toEqual(page);
  expect(parseConversation({...page,messages:[{...row,isRead:true}]}).messages[0]?.isRead).toBe(true);
});
it('rejects malformed conversation windows and identities',()=>{
  for(const change of [{start:-1},{total:2},{newerUnread:-1},{selected:{...page.selected,sender:'invalid'}},{messages:[{...row,isRead:'false'}]}])expect(()=>parseConversation({...page,...change})).toThrow();
});
it('preserves provider grouping and exact unread counts for Inbox selection',()=>{
  const conversation={unreadCount:2,lastActivity:row.createdAt,messages:[{sender,messageId,isRead:false}]};
  const message={sender,messageId,recipient:sender,category:null,deliveredAt:row.createdAt,isRead:false,conversation,body:{version:1,profile:'spt-1',blocks:[]}};
  expect(parseInboxFeed({messages:[message],next:'page-two'}).messages[0]?.conversation).toEqual(conversation);
  expect(()=>parseInboxFeed({messages:[{...message,conversation:{...conversation,unreadCount:-1}}],next:null})).toThrow();
});
