import {loadConfig} from "../config.js";
import {ProviderDatabase} from "../db/database.js";
import {canonicalizeHailAddress} from "../identity/address.js";

const [action,address,extra]=Bun.argv.slice(2);
if(!["grant","revoke"].includes(action??"")||!address||extra)throw new Error("Usage: bun src/cli/provider-operator.ts <grant|revoke> <address>");
const config=loadConfig(),db=new ProviderDatabase(config.databaseUrl);
try{
  await db.migrate();
  const canonical=canonicalizeHailAddress(address);
  if(canonical.split("@")[1]!==new URL(config.publicOrigin).hostname)throw new Error("Account must belong to this provider");
  if(action==="grant"){
    const rows=await db.sql`INSERT INTO provider_operators(account_id,serving_generation)
      SELECT a.id,g.generation FROM provider_accounts a JOIN account_serving_generations g ON g.account_id=a.id WHERE canonical_address=${canonical} AND address_released_at IS NULL AND onboarding_state='active'
      AND NOT EXISTS (SELECT 1 FROM provider_migration_fences WHERE account_id=a.id)
      AND EXISTS (SELECT 1 FROM account_passkeys WHERE account_id=a.id AND revoked_at IS NULL)
      ON CONFLICT(account_id) DO UPDATE SET granted_at=clock_timestamp(),serving_generation=excluded.serving_generation RETURNING account_id`;
    if(!rows.length)throw new Error("Grant requires an active local account with a passkey");
  }else await db.sql`DELETE FROM provider_operators WHERE account_id IN (SELECT id FROM provider_accounts WHERE canonical_address=${canonical} AND address_released_at IS NULL)`;
  console.info(JSON.stringify({action,address:canonical}));
}finally{await db.close();}
