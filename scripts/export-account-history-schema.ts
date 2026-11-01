/** Generate/check against fresh migrations only; never read production data. */
import {SQL} from 'bun';
import {ProviderDatabase} from '../apps/server/src/db/database.js';
import {accountHistorySchema} from './lib/account-history-schema.js';
const adminUrl=process.env.DATABASE_TEST_ADMIN_URL;
if(!adminUrl)throw Error('DATABASE_TEST_ADMIN_URL for disposable PostgreSQL is required');
const admin=new SQL(adminUrl),name='hail_schema_'+crypto.randomUUID().replaceAll('-','');
let db:ProviderDatabase|undefined;
try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const url=new URL(adminUrl);url.pathname='/'+name;db=new ProviderDatabase(url.toString());await db.migrate();
  const schema=await accountHistorySchema(db.sql),text=JSON.stringify(schema,null,2)+'\n';
  const target=new URL('../spec/schemas/account-history-v7-v8.json',import.meta.url);
  if(process.argv.includes('--check')){if(await Bun.file(target).text()!==text)throw Error('Account-history schema drift: review the protocol and regenerate');}
  else await Bun.write(target,text);
  console.info('Account-history schema '+(process.argv.includes('--check')?'matches migrated export projections':'written'));
}finally{await db?.close();await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await admin.close();}
