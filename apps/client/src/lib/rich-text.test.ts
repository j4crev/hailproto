import {expect,it} from 'vitest';
import {render} from 'svelte/server';
import RichText from './RichText.svelte';
import {composeBlocks} from './compose.js';
import {parseBody} from './messages.js';

it('renders ordinary blocks as spaced paragraphs and preserves line breaks',()=>{
  const blocks=parseBody({version:1,profile:'spt-2',blocks:composeBlocks('','First line\nSecond line\n\nNext paragraph')}).blocks;
  const {body}=render(RichText,{props:{blocks}});
  expect(body).not.toContain('<normal');
  expect(body.match(/<p\b/g)).toHaveLength(2);
  expect(body).toContain('whitespace-pre-wrap');
  expect(body).toContain('First line\nSecond line');
});

it('separates a forwarded heading and metadata from the note and original',()=>{
  const metadata='From: alice@example.com\nSender DID: did:plc:aaaaaaaaaaaaaaaaaaaaaaaa\nOriginally received: 2026-10-29T10:00:00Z\nMessage ID: 019a15fd-2bd0-7433-8afa-bd0355e0608d';
  const blocks=parseBody({version:1,profile:'spt-2',blocks:composeBlocks('','Note\n\nForwarded message\n\n'+metadata+'\n\nOriginal content')}).blocks;
  const {body}=render(RichText,{props:{blocks}});
  expect(body).toContain('forward-heading');
  expect(body).toContain('forward-metadata');
  expect(body.match(/<p\b/g)).toHaveLength(4);
});
