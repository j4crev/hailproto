import {beforeEach,expect,it,vi} from 'vitest';
const fixture=vi.hoisted(()=>({request:vi.fn(),avatars:vi.fn()}));
vi.mock('$lib/server/canary.js',()=>({canaryAccount:async()=>({account:{did:'owner'},client:{request:fixture.request}}),senderAvatars:fixture.avatars}));
import {load as trash} from '../routes/trash/+page.server.js';
import {load as connections} from '../routes/connections/+page.server.js';
const event=()=>({url:new URL('https://example.com/'),cookies:{},setHeaders:vi.fn()}) as never;
beforeEach(()=>{vi.clearAllMocks();fixture.avatars.mockResolvedValue(new Map([['sender',{src:'data:image/png;base64,AQID',width:44,height:44}]]));});
it('adds sender avatars to Trash without changing restoration identity',async()=>{
  fixture.request.mockResolvedValue({messages:[{sender:'sender',messageId:'message',recipient:'owner',deliveredAt:'2026-10-27T12:00:00Z',trashedAt:'2026-10-28T12:00:00Z',category:null,body:{version:1,profile:'spt-1',blocks:[]}}],next:null});
  const result=await trash(event());
  expect(result.messages[0]).toMatchObject({sender:'sender',messageId:'message',avatar:{width:44}});
  expect(fixture.avatars.mock.calls[0][1]).toEqual(new Set(['sender']));
});
it('loads connection portraits and preserves the component retry path on API failure',async()=>{
  fixture.request.mockResolvedValue({preview:true,codes:[],connections:[{id:'id',did:'sender',address:'sender@example.com'}]});
  expect(await connections(event())).toMatchObject({initialList:{connections:[{did:'sender'}]},avatars:{sender:{width:44}}});
  fixture.request.mockRejectedValue(new Error('Unavailable'));fixture.avatars.mockResolvedValue(new Map());
  expect(await connections(event())).toMatchObject({initialList:null,avatars:{}});
});
