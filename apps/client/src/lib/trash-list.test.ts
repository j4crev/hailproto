import {expect, it, vi} from 'vitest';
import {render} from 'svelte/server';
vi.mock('$app/navigation',()=>({afterNavigate:()=>{},invalidateAll:vi.fn()}));
vi.mock('$app/state',()=>({page:{data:{}}}));
import Trash from '../routes/trash/+page.svelte';

it('renders sent and received Trash entries in one selectable list with the sending account initial',()=>{
  const {body}=render(Trash,{props:{data:{
    account:{did:'owner',address:'j4@haili.app'},trashEnabled:true,
    messages:[{sender:'sender',senderAddress:'alice@example.com',messageId:'same-id',title:'Received item',preview:'',deliveredAt:'2026-11-01T12:00:00Z',trashedAt:'2026-11-03T12:00:00Z',avatar:null}],
    sent:{messages:[{kind:'message',messageId:'same-id',title:'Sent item',preview:'',createdAt:'2026-11-02T12:00:00Z',trashedAt:'2026-11-04T15:30:00Z',recipientSummary:{address:'alice@example.com'}}],next:null},
    drafts:{drafts:[],next:null},
  } as never}});
  expect(body.match(/class="compact-list"/g)).toHaveLength(1);
  expect(body).toContain('aria-label="Select sent message: Sent item"');
  expect(body).toContain('aria-label="Select message from alice@example.com"');
  expect(body).toContain('<span aria-hidden="true">J</span>');
  expect(body).toContain('href="/sent/send/message/same-id?trash=true"');
  expect(body.indexOf('Select sent message:')).toBeLessThan(body.indexOf('Select message from'));
  expect(body).not.toContain('Trashed sent messages');
  expect(body).not.toContain('Restore Sent item to Sent');
  expect(body.match(/>Trashed /g)).toHaveLength(2);
  expect(body).toContain('datetime="2026-11-04T15:30:00.000Z"');
});

it('keeps sent-only Trash selectable without showing the empty state',()=>{
  const {body}=render(Trash,{props:{data:{
    account:{did:'owner',address:'bob@example.com'},trashEnabled:true,messages:[],
    sent:{messages:[{kind:'category',messageId:'id',title:'Announcement',preview:'',category:'general',createdAt:'2026-11-02T12:00:00Z',trashedAt:'2026-11-04T15:30:00Z'}],next:null},drafts:{drafts:[],next:null},
  } as never}});
  expect(body).toContain('aria-label="Select sent message: Announcement"');
  expect(body).toContain('<span aria-hidden="true">B</span>');
  expect(body).not.toContain('empty-symbol');
});
