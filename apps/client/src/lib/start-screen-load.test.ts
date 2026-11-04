import {beforeEach,expect,it,vi} from 'vitest';
const fixture=vi.hoisted(()=>({request:vi.fn(),configured:true}));
vi.mock('$lib/server/canary.js',()=>({
  isConfigured:()=>fixture.configured,
  canaryAccount:async()=>({account:{did:'owner'},client:{request:fixture.request}}),
  senderAvatars:async()=>new Map(),
}));
vi.mock('$lib/server/registration.js',()=>({registration:async()=>null}));
import {load} from '../routes/+page.server.js';
beforeEach(()=>{
  fixture.configured=true;
  fixture.request.mockReset().mockImplementation(async(path:string)=>path==='/message-preferences'?{startScreen:'feed'}:{messages:[],next:null});
});
const home=(path:string)=>load({url:new URL(path,'https://example.com'),cookies:{},fetch,setHeaders:vi.fn()} as never);
it('defaults to Feed for an account without a chosen start screen',async()=>{
  expect(await home('/')).toMatchObject({configured:true,view:'subscriptions'});
  expect(fixture.request).toHaveBeenCalledWith('/message-preferences');
});
it('opens Inbox at home and preserves other query parameters',async()=>{
  fixture.request.mockResolvedValue({startScreen:'inbox'});
  await expect(home('/?after=cursor')).rejects.toMatchObject({status:307,location:'/?after=cursor&view=connections'});
  expect(fixture.request).toHaveBeenCalledTimes(1);
});
it.each(['subscriptions','connections'])('honors explicit %s navigation and pagination',async(view)=>{
  expect(await home(`/?view=${view}&after=cursor`)).toMatchObject({view,paged:true});
  expect(fixture.request).not.toHaveBeenCalledWith('/message-preferences');
  expect(fixture.request.mock.calls[0][0]).toBe(view==='connections'?'/connection-inbox?after=cursor':'/inbox?include=body&kind=subscriptions&after=cursor');
});
it('keeps anonymous home and explicit sign-in return paths unchanged',async()=>{
  fixture.configured=false;
  expect(await home('/')).toMatchObject({configured:false,returnTo:'/'});
  fixture.configured=true;
  expect(await home('/?next=%2Fsettings')).toMatchObject({configured:false,returnTo:'/settings'});
  expect(fixture.request).not.toHaveBeenCalled();
});
