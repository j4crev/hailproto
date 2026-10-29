import {expect,it} from 'vitest';
import {decodePayload,encodePayload} from '@hailproto/codec';
import {composeBlocks} from './compose.js';
import {parseMessage,messageDisplayContent,messageListSummary} from './messages.js';
import {replyBody,replyExcerpt,replyQuoteIndex} from './reply.js';

const source={sender:'did:plc:'+'a'.repeat(24),recipient:'did:plc:'+'b'.repeat(24),messageId:'019a15fd-2bd0-7433-8afa-bd0355e0608d',senderAddress:'alice@example.com',deliveredAt:'2026-10-29T10:00:00Z',category:'general',body:{version:1,profile:'spt-2',blocks:composeBlocks('Subject','**Original** text')}};
it('quotes an authenticated source as portable text, with literal reply text',()=>{
  const body=replyBody(source,source,'**My reply**');
  expect(decodePayload('hail.body.spt-2',encodePayload('hail.body.spt-2',body))).toEqual(body);
  const message=parseMessage({...source,body});
  expect(messageDisplayContent(message.blocks).title).toBe('Subject');
  expect(messageListSummary(message).title).toBe('Subject');
  expect(messageDisplayContent(message.blocks).blocks[0].spans[0].text).toBe('**My reply**');
  expect(message.paragraphs.at(-1)).toBe('Original text');
  expect(replyQuoteIndex(message.blocks)).toBe(2);
  expect(body).not.toHaveProperty('authorization');
});
it('quotes only the immediate reply and bounds large original text',()=>{
  const first=replyBody(source,source,'First reply');
  const second=replyBody({...source,body:first},source,'Second reply');
  expect(parseMessage({...source,body:second}).paragraphs.at(-1)).toBe('First reply');
  expect(messageDisplayContent(parseMessage({...source,body:second}).blocks).title).toBe('Subject');
  expect(second.blocks.filter(b=>b.style==='h1')).toHaveLength(1);
  const long=parseMessage({...source,body:{...source.body,blocks:composeBlocks('','😀'.repeat(5000))}});
  expect(replyExcerpt(long)).toBe('😀'.repeat(4096)+'\n[Excerpt shortened]');
});
it('rejects mismatched or removed originals and blank or oversized replies',()=>{
  expect(()=>replyBody({...source,trashedAt:source.deliveredAt},source,'Hello')).toThrow();
  expect(()=>replyBody(source,{...source,sender:source.recipient},'Hello')).toThrow();
  expect(()=>replyBody(source,source,' ')).toThrow();
  expect(()=>replyBody(source,source,'x'.repeat(65537))).toThrow();
});
it('quotes image alt context without copying assets above the response',()=>{
  const image={_type:'spt.image',asset:'header',alt:'Picture'};
  const body={...source.body,profile:'spt-3',assets:{version:1,assets:[{id:'header',role:'header',media_type:'image/png',loading:'bundled',size:1,width:1,height:1,data:'AA'}]},blocks:[image,...source.body.blocks]};
  const reply=replyBody({...source,body},source,'Response');
  expect(reply.profile).toBe('spt-2');
  expect(messageDisplayContent(parseMessage({...source,body:reply}).blocks).title).toBe('Subject');
  expect(parseMessage({...source,body:reply}).paragraphs.at(-1)).not.toContain('Subject');
  expect(reply).not.toHaveProperty('assets');
  expect(parseMessage({...source,body:reply}).paragraphs.at(-1)).toContain('[Image in original message]');
});

it('keeps untitled replies untitled and preserves headings within quoted content',()=>{
  const input={...source,body:{...source.body,blocks:composeBlocks('','Opening paragraph\n\n# Body heading')}};
  const reply=replyBody(input,input,'Response');
  const parsed=parseMessage({...input,body:reply});
  expect(messageDisplayContent(parsed.blocks).title).toBe('');
  expect(parsed.paragraphs[0]).toBe('Response');
  expect(parsed.paragraphs.at(-1)).toBe('Opening paragraph\n\nBody heading');
});
