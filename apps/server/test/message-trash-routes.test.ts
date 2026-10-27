import {expect,it,vi} from 'vitest';
import {createApp} from '../src/app.js';
import type {AppConfig} from '../src/config.js';
import type {AccountApiRepository} from '../src/accounts/repository.js';
import type {AccountMessaging} from '../src/accounts/messaging.js';
import type {GrantRepository} from '../src/grants/repository.js';
import type {GrantService} from '../src/grants/service.js';
it('requires authenticated scoped same-origin web access for Trash mutations',async()=>{
  const session={account_id:crypto.randomUUID(),did:'did:plc:'+'a'.repeat(24),credential_id:crypto.randomUUID(),serving_generation:1,
    passkey_credential_id:'passkey' as string|null,scopes:['messages:read','messages:write'],migration_state:null};
  let authenticated=true;
  const accounts={authenticate:vi.fn(async()=>authenticated?session:null)} as unknown as AccountApiRepository;
  const remove=vi.fn(async()=>({state:'trashed'})),restore=vi.fn(async()=>({restored:1})),saveSettings=vi.fn(async()=>({trashEnabled:false}));
  const messaging={trash:{remove,restore,saveSettings,settings:async()=>({trashEnabled:true})},inboxFeed:async()=>({messages:[],next:null})} as unknown as AccountMessaging;
  const origin='https://example.com',app=createApp({publicOrigin:origin,providerId:'test',passkeys:{origin}} as AppConfig,
    {accountApi:{accounts,grants:{} as GrantRepository,service:{} as GrantService,messaging},async checkReadiness(){return {ready:true};}});
  const path='/api/v1/account/inbox/did:plc:'+ 'b'.repeat(24)+'/019a0000-0000-7000-8000-000000000001/delete';
  const headers={Cookie:'hail_session=fixture',Origin:origin,'Content-Type':'application/json'};
  const post=(url=path,body:unknown={},extra={})=>app.request(url,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
  authenticated=false;expect((await post()).status).toBe(401);authenticated=true;
  expect((await post(path,{}, {Origin:'https://evil.example'})).status).toBe(403);
  session.scopes=['messages:read'];expect((await post()).status).toBe(403);
  session.scopes=['messages:read','messages:write'];session.passkey_credential_id=null;
  expect((await post()).status).toBe(403);session.passkey_credential_id='passkey';
  expect((await post(path.replace('/delete','/permanent-delete'))).status).toBe(403);
  expect(remove).not.toHaveBeenCalled();expect((await post()).status).toBe(200);expect(remove).toHaveBeenCalledTimes(1);
  expect((await post(path,{permanent:true})).status).toBe(400);
  expect((await post('/api/v1/account/message-preferences',{trashEnabled:false})).status).toBe(200);
  expect(saveSettings).toHaveBeenCalledWith(session,false);
  expect((await post('/api/v1/account/trash/restore',{messages:[]})).status).toBe(200);
  expect(restore).toHaveBeenCalledWith(session,[]);
  expect((await app.request('/api/v1/account/trash?unknown=1',{headers})).status).toBe(400);
  session.passkey_credential_id=null;
  session.scopes=['messages:read'];expect((await post(path.replace('/delete','/permanent-delete'))).status).toBe(403);
  session.scopes=['messages:write'];expect((await post(path.replace('/delete','/permanent-delete'))).status).toBe(200);
  expect(remove.mock.calls.at(-1)?.at(-1)).toBe(true);
});
