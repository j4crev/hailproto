import {beforeEach,expect,it,vi} from 'vitest';
const {request}=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('$lib/server/canary.js',()=>({canaryAccount:async()=>({client:{request}})}));
import {actions} from '../routes/message/[sender]/[messageId]/+page.server.js';
import {composeBlocks} from './compose.js';
const id='019a15fd-2bd0-7433-8afa-bd0355e0608d',out='019a15fd-2bd0-7433-8afa-bd0355e0608e';
const source={sender:'did:plc:'+'a'.repeat(24),recipient:'did:plc:'+'b'.repeat(24),messageId:id,deliveredAt:'2026-10-29T10:00:00Z',category:null,reply:{allowed:true,until:2000000000},replyAvailable:true,body:{version:1,profile:'spt-1',blocks:composeBlocks('','Original')}};
async function send(allowReply=false){
  const body=new FormData();
  for(const [k,v] of Object.entries({messageId:out,text:'Response',replyUntil:'2000000000',...(allowReply?{allowReply:'yes'}:{})}))body.set(k,v);
  return actions.reply({params:{sender:source.sender,messageId:id},request:new Request('https://example.com',{method:'POST',body}),cookies:{},url:new URL('https://example.com')} as never);
}
beforeEach(()=>request.mockReset());
it('sends subscription quotes through the original invitation',async()=>{
  request.mockResolvedValueOnce(source).mockResolvedValueOnce({messageId:out});
  await expect(send(true)).rejects.toMatchObject({status:303,location:'/sent/'+out});
  expect(request.mock.calls[1]).toMatchObject(['/messages',{messageId:out,replyTo:id,inReplyTo:{sender:source.sender,messageId:id},replyUntil:2000000000,body:{profile:'spt-2'}}]);
  expect(request.mock.calls[1][1]).not.toHaveProperty('connectionId');
});
it('sends connection quotes to one exact connection without reply authority',async()=>{
  request.mockResolvedValueOnce({...source,kind:'connection',reply:{allowed:false},replyAvailable:false,connection:{id,epoch:7,active:true}}).mockResolvedValueOnce({messageId:out});
  await expect(send()).rejects.toMatchObject({status:303});
  expect(request.mock.calls[1]).toMatchObject(['/messages',{connectionId:id,connectionEpoch:7,recipientDid:source.sender,inReplyTo:{sender:source.sender,messageId:id}}]);
  expect(request.mock.calls[1][1]).not.toHaveProperty('replyTo');
  expect(request.mock.calls[1][1]).not.toHaveProperty('replyUntil');
});
it('retains the request identity, text and invitation deadline after a lost response',async()=>{
  request.mockResolvedValueOnce(source).mockRejectedValueOnce(new Error('lost'));
  expect(await send(true)).toMatchObject({status:502,data:{messageId:out,text:'Response',replyUntil:2000000000,allowReply:true}});
});
it('does not send from a trashed or inactive connection source',async()=>{
  request.mockResolvedValueOnce({...source,trashedAt:source.deliveredAt});
  expect(await send()).toMatchObject({status:502});expect(request).toHaveBeenCalledTimes(1);
  request.mockReset().mockResolvedValueOnce({...source,kind:'connection',reply:{allowed:false},replyAvailable:false,connection:{id,epoch:1,active:false}});
  expect(await send()).toMatchObject({status:409});expect(request).toHaveBeenCalledTimes(1);
});
