import type { Hono } from "hono";
import type { StandaloneDomains } from "./standalone-domains.js";
import { CustomDomainError } from "./domain-proof.js";
import { accountRequestBytes } from "./routes.js";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import { clientAddress, FixedWindowRateLimit } from "../http/rate-limit.js";

export function registerStandaloneDomainRoutes(app:Hono,domains:StandaloneDomains,origin:string){
  const rate=new FixedWindowRateLimit(),starts=new FixedWindowRateLimit();
  app.all('/api/v1/domain-signup/:action?',async c=>{
    c.header('Cache-Control','no-store');c.header('Referrer-Policy','no-referrer');
    try{
      const ip=clientAddress(c.req.raw),action=c.req.param('action');
      if(c.req.header('Origin')!==origin&&!(c.req.method==='GET'&&c.req.header('Origin')===undefined))throw new CustomDomainError(403,'Request origin refused.');
      if(rate.take(ip,20)!==null)throw new CustomDomainError(429,'Wait before retrying.');
      if(new URL(c.req.url).search||action&&action!=='verify')throw new CustomDomainError(400,'Invalid domain setup request.');
      const token=/^Bearer (haild_[A-Za-z0-9_-]{43})$/.exec(c.req.header('Authorization')??'')?.[1];
      if(c.req.method==='GET'&&!action){if(!token)throw new CustomDomainError(403,'Domain setup authority is required.');return c.json(await domains.status(token));}
      if(c.req.method!=='POST')return c.json({error:'Use POST for this operation.'},405);
      if(c.req.header('Content-Type')!=='application/json'||c.req.header('Content-Encoding'))return c.json({error:'Use JSON.'},415);
      const bytes=await accountRequestBytes(c.req.raw,2048);if(!bytes)return c.json({error:'Request too large.'},413);
      let input:Record<string,unknown>;
      try{input=parseJsonWithoutDuplicateKeys(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as Record<string,unknown>;
        if(!input||typeof input!=='object'||Array.isArray(input)||
          (action?Object.keys(input).length!==0:Object.keys(input).join(',')!=='address'||typeof input.address!=='string'))throw new Error();
      }catch{throw new CustomDomainError(400,'Invalid domain setup request.');}
      if(action){if(!token)throw new CustomDomainError(403,'Domain setup authority is required.');return c.json(await domains.verify(token));}
      if(c.req.header('Authorization'))throw new CustomDomainError(400,'Start a new setup without a previous token.');
      if(starts.take(ip,5)!==null)throw new CustomDomainError(429,'Too many new setups. Wait before retrying.');
      return c.json(await domains.start(input.address as string));
    }catch(error){
      if(error instanceof CustomDomainError){if(error.status===429)c.header('Retry-After','60');return c.json({error:error.message},error.status);}
      const pg=error as {code?:string;errno?:string};
      if(pg?.code==='23505'||pg?.errno==='23505')return c.json({error:'Domain or address was claimed by another setup.'},409);
      return c.json({error:'Domain setup is unavailable. Retain this tab and retry.'},503);
    }
  });
}
