import {Hono} from 'hono';
import {expect,it,vi} from 'vitest';
import {registerAccountApiRoutes} from '../src/accounts/routes.js';
import {UserGrantError} from '../src/grants/service.js';

it('correlates rejected connection batches without logging bodies, credentials or unexpected error text',async()=>{
  const id='00000000-0000-7000-8000-000000000001',log=vi.spyOn(console,'error').mockImplementation(()=>{});
  let failure:Error=new UserGrantError(409,'Finish or cancel open message batches first');
  const app=new Hono(),accounts={authenticate:async()=>({account_id:id,serving_generation:1,scopes:['messages:write'],migration_state:null})};
  registerAccountApiRoutes(app,accounts as never,{} as never,{} as never,'https://example.com',undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,
    {createConnections:async()=>{throw failure;}} as never);
  const send=()=>app.request('/api/v1/account/connection-messages',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer private-credential'},
    body:JSON.stringify({publicationId:id,text:'private message text',connections:[]})});
  try{
    expect((await send()).status).toBe(409);
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({requestId:id,outcome:'rejected',status:409,reason:'Finish or cancel open message batches first'});
    failure=new Error('private database detail');
    expect((await send()).status).toBe(503);
    const output=JSON.stringify(log.mock.calls);
    for(const secret of ['private message text','private-credential','private database detail'])expect(output).not.toContain(secret);
    expect(JSON.parse(log.mock.calls[1]![0]).frames.length).toBeGreaterThan(0);
  }finally{log.mockRestore();}
});
