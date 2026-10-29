import {expect,it} from 'vitest';
import {encodePayload, type HailSpt2Body} from '@hailproto/codec';
import {composeBlocks} from './compose.js';
import {forwardBody,forwardHref,forwardSource} from './forward.js';
import {forwardedAttribution,parseBody} from './messages.js';

const source={sender:'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',senderAddress:'alice@example.com',messageId:'019a15fd-2bd0-7433-8afa-bd0355e0608d',recipient:'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',deliveredAt:'2026-10-29T10:00:00Z',category:'general',body:{version:1,profile:'spt-2',blocks:composeBlocks('Original subject','**Original** [link](https://example.com)\n\n- List item')}};
it('preserves subject, rich body and literal provenance without copying reply authority',()=>{
  const input=structuredClone(source);
  const body=forwardBody(forwardSource({...input,reply:{allowed:true,until:2000000000},replyAvailable:true},input),'My note');
  const parsed=parseBody(body);
  expect(parsed.paragraphs).toEqual(['Original subject','My note','Forwarded message',`From: alice@example.com\nSender DID: ${source.sender}\nOriginally received: ${source.deliveredAt}\nMessage ID: ${source.messageId}`,'Original link','List item']);
  expect(body.blocks.slice(-2)).toEqual(source.body.blocks.slice(1));
  expect(input).toEqual(source);
  expect(body).not.toHaveProperty('reply');
  expect(()=>encodePayload('hail.body.spt-2',body as unknown as HailSpt2Body)).not.toThrow();
});
it('upgrades plain messages so the entire forward is delivered, with no note required',()=>{
  const input={...source,body:{version:1,profile:'spt-1',blocks:composeBlocks('','Plain original')}};
  const body=forwardBody(forwardSource(input,input),'');
  expect(body.profile).toBe('spt-2');
  expect(parseBody(body).paragraphs.at(-1)).toBe('Plain original');
});
it('preserves bundled image position and asset manifest',()=>{
  const asset={id:'header',role:'header',media_type:'image/png',loading:'bundled',size:1,width:1,height:1,data:'AA'};
  const image={_type:'spt.image',asset:'header',alt:'Original image'};
  const input={...source,body:{...source.body,profile:'spt-3',assets:{version:1,assets:[asset]},blocks:[image,...source.body.blocks]}};
  const body=forwardBody(forwardSource(input,input),'Note');
  expect(body.blocks[0]).toEqual(image);
  expect(body).toMatchObject({assets:input.body.assets});
  expect(parseBody(body).header?.alt).toBe('Original image');
});
it('rejects mismatched and trashed sources and encodes local source references',()=>{
  expect(()=>forwardSource(source,{...source,sender:'someone else'})).toThrow();
  expect(()=>forwardSource(source,{...source,messageId:'different'})).toThrow();
  expect(()=>forwardSource({...source,trashedAt:source.deliveredAt},source)).toThrow();
  const url=new URL(forwardHref(source),'https://example.com');
  expect(url.searchParams.get('forwardSender')).toBe(source.sender);
  expect(url.searchParams.get('audience')).toBe('connections');
});

it('recognizes complete forwarded attribution, including already-sent messages',()=>{
  const blocks=parseBody(forwardBody(forwardSource(source,source),'A note\nwith a line break')).blocks;
  const attribution=forwardedAttribution(blocks);
  expect(attribution?.heading).toBe(blocks[2]);
  expect(attribution?.metadata).toBe(blocks[3]);
  expect(forwardedAttribution(blocks.slice(1))).not.toBeNull();
  expect(forwardedAttribution(parseBody({version:1,profile:'spt-2',blocks:composeBlocks('','Forwarded message\n\nJust discussing the feature')}).blocks)).toBeNull();
});
