import {afterEach,expect,it,vi} from 'vitest';
import {loadThreadCount} from './thread-count.js';
const sender='did:plc:'+'b'.repeat(24),owner='did:plc:'+'a'.repeat(24),id='019a15fd-2bd0-7433-8afa-bd0355e0608d';
const root={sender,messageId:id,sent:false,isRead:false,createdAt:'2026-10-31T12:00:00Z',preview:'Hello',inReplyTo:null,parentAvailable:false};
const reply={...root,messageId:'019a15fd-2bd0-7433-8afa-bd0355e0608e',inReplyTo:{sender,messageId:id},parentAvailable:true};
const sent={...reply,sender:owner,sent:true,isRead:true};
const run=()=>loadThreadCount(sender,id,new AbortController().signal);
const respond=(messages:unknown[],truncated=false)=>vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({messages,truncated})));
afterEach(()=>vi.unstubAllGlobals());
it('counts only distinct unread received messages, excluding sent and read messages',async()=>{
 respond([root,reply,reply,sent,{...reply,messageId:'019a15fd-2bd0-7433-8afa-bd0355e0608f',isRead:true}]);
 expect(await run()).toEqual({count:2,truncated:false});
 expect(fetch).toHaveBeenCalledWith(`/api/v1/account/threads/${encodeURIComponent(sender)}/${id}`,expect.objectContaining({credentials:'same-origin',cache:'no-store',redirect:'error',signal:expect.any(AbortSignal)}));
});
it.each([false,true])('hides zero and one unread, even if truncated=%s',async truncated=>{
 respond([{...root,isRead:true},sent],truncated);expect(await run()).toBeNull();
 respond([root,sent],truncated);expect(await run()).toBeNull();
});
it('preserves a lower bound when there are multiple unread messages in a truncated thread',async()=>{
 respond([root,reply],true);expect(await run()).toEqual({count:2,truncated:true});
});
it('updates the badge as messages are read and marked unread again',async()=>{
 respond([root,reply]);expect((await run())?.count).toBe(2);
 respond([root,{...reply,isRead:true}]);expect(await run()).toBeNull();
 respond([root,reply]);expect((await run())?.count).toBe(2);
});
it.each([
 {messages:[{...root,isRead:undefined},reply]}, // Older provider: unknown is not unread.
 {messages:[{...root,isRead:'false'},reply]},
 {messages:[reply]},
 {messages:[{...root,messageId:'invalid'},reply]}
])('omits unknown, invalid and unrelated thread results',async ({messages})=>{
 respond(messages);expect(await run()).toBeNull();
});
it('does not turn API errors or aborted requests into a count',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(new Response('',{status:503})).mockRejectedValueOnce(new DOMException('Aborted','AbortError'));vi.stubGlobal('fetch',fetch);
 expect(await run()).toBeNull();expect(await run()).toBeNull();
});
