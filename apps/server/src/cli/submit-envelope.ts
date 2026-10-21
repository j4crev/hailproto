import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import { EnvelopeRepository } from "../envelopes/repository.js";
import { submitEnvelope } from "../envelopes/submission.js";
import { createHailDidResolver } from "../plc/public-resolver.js";
import { DeliveryStatusReceiver } from "../delivery/status-receiver.js";
import { OnboardingRepository } from "../onboarding/repository.js";
import { SafeHttpsTransport } from "../discovery/safe-fetch.js";
const [sender,id]=Bun.argv.slice(2);
if(!sender||!id||Bun.argv.length!==4)throw new Error("Usage: bun run envelope:submit -- <sender-did> <message-id>");
const config=loadConfig(),db=new ProviderDatabase(config.databaseUrl);
try{await db.migrate();const resolver=createHailDidResolver(config,db.sql);
  console.info(JSON.stringify(await submitEnvelope(sender,id,new EnvelopeRepository(db.sql),resolver,
    new DeliveryStatusReceiver(db.sql,new OnboardingRepository(db.sql),resolver,config.hailServiceBase),new SafeHttpsTransport())));
}finally{await db.close();}
