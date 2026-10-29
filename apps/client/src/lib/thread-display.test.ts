import {expect,it} from 'vitest';
import {render} from 'svelte/server';
import QuotedMessage from './QuotedMessage.svelte';
import MessageThread from './MessageThread.svelte';
import {replyBody} from './reply.js';
import {parseBody} from './messages.js';
import {parseThread} from './threads.js';
import {composeBlocks} from './compose.js';
const sender='did:plc:'+'a'.repeat(24),id='019a15fd-2bd0-7433-8afa-bd0355e0608d';
it('renders quotes collapsed, preserves the response, and escapes content',()=>{
  const source={sender,messageId:id,recipient:'did:plc:'+'b'.repeat(24),category:null,deliveredAt:'2026-10-29T10:00:00Z',body:{version:1,profile:'spt-1',blocks:composeBlocks('','<script>original</script>')}};
  const parsed=parseBody(replyBody(source,source,'My response'));
  const {body}=render(QuotedMessage,{props:parsed});
  expect(body).toContain('My response');
  expect(body).toContain('Show quoted message');
  expect(body).toContain('&lt;script>');
  expect(body).not.toContain('<script>');
  expect(body).not.toMatch(/<details[^>]*\bopen/);
});
it('highlights the selected message and links the original across sent/inbox views',()=>{
  const parent={sender,messageId:id,sent:true,createdAt:'2026-10-29T10:00:00Z',preview:'Original',inReplyTo:null,parentAvailable:false};
  const reply={...parent,sender:'did:plc:'+'b'.repeat(24),messageId:'019a15fd-2bd0-7433-8afa-bd0355e0608e',sent:false,inReplyTo:{sender,messageId:id},parentAvailable:true};
  const thread=parseThread({messages:[parent,reply],truncated:false});
  const {body}=render(MessageThread,{props:{thread,selected:reply}});
  expect(body).toContain('aria-current="page"');
  expect(body).toContain('/sent/'+id);
  expect(body).toContain('View original');
  const missing=render(MessageThread,{props:{thread:{messages:[{...reply,parentAvailable:false}],truncated:false},selected:reply}}).body;
  expect(missing).toContain('Original unavailable');
  expect(()=>parseThread({messages:[{...reply,messageId:'bad/path'}],truncated:false})).toThrow();
});
it('shows the known peer address while keeping You and DID fallbacks',()=>{
  const peer='did:plc:'+'b'.repeat(24);
  const own={sender,messageId:id,sent:true,createdAt:'2026-10-29T10:00:00Z',preview:'Original',inReplyTo:null,parentAvailable:false};
  const reply={...own,sender:peer,messageId:'019a15fd-2bd0-7433-8afa-bd0355e0608e',sent:false,inReplyTo:{sender,messageId:id},parentAvailable:true};
  const thread=parseThread({messages:[own,reply],truncated:false});
  const props={thread,selected:reply,peer:{did:peer,address:'friend@haili.app'}};
  const {body}=render(MessageThread,{props});
  expect(body).toContain('friend@haili.app');
  expect(body).toContain('You');
  expect(body).toContain('aria-current="page"');
  expect(body).not.toContain('>'+peer+' ·');
  const unknown=render(MessageThread,{props:{...props,peer:{did:peer,address:null}}}).body;
  expect(unknown).toContain(peer+' ·');
  const mismatch=render(MessageThread,{props:{...props,peer:{did:sender,address:'someone-else@haili.app'}}}).body;
  expect(mismatch).not.toContain('someone-else@haili.app');
  expect(mismatch).toContain(peer+' ·');
});

it('keeps body previews compact and omits empty previews',()=>{
  const message={sender,messageId:id,sent:true,createdAt:'2026-10-29T10:00:00Z',preview:'Actual message body',inReplyTo:{sender:'did:plc:'+'b'.repeat(24),messageId:id},parentAvailable:false};
  const props={thread:{messages:[message],truncated:false},selected:message};
  const body=render(MessageThread,{props}).body;
  expect(body).toContain('Actual message body');
  expect(body).toContain('line-clamp-2');
  const empty=render(MessageThread,{props:{...props,thread:{messages:[{...message,preview:''}],truncated:false}}}).body;
  expect(empty).not.toContain('line-clamp-2');
});
