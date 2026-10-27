import type {Hono} from "hono";
import {getCookie} from "hono/cookie";
import type {AccountApiRepository} from "../accounts/repository.js";
import {accountRequestBytes} from "../accounts/routes.js";
import {parseJsonWithoutDuplicateKeys} from "../discovery/strict-json.js";
import {FixedWindowRateLimit} from "../http/rate-limit.js";
import {OperatorError, type OperatorInvitations} from "./invitations.js";

import {statsRanges, type OperatorStatistics, type StatsRange} from "./stats.js";

export function registerOperatorRoutes(app:Hono,accounts:AccountApiRepository,invitations:OperatorInvitations,origin:string,statistics?:OperatorStatistics){
  const rate=new FixedWindowRateLimit();
  for(const path of ["/api/v1/operator/invitations","/api/v1/operator/stats"])app.all(path,async context=>{
    const isStats=context.req.path.endsWith("/stats");
    context.header("Cache-Control","no-store");
    context.header("Referrer-Policy","no-referrer");
    if(isStats&&context.req.method!=="GET")return context.json({error:"Use GET"},405);
    if(!["GET","POST"].includes(context.req.method))return context.json({error:"Use GET or POST"},405);
    // The dashboard's server client forwards Origin even on GET. Bearer API credentials never confer operator authority.
    if(context.req.header("Origin")!==origin)return context.json({error:"Origin refused"},403);
    try{
      const session=await accounts.authenticate(undefined,getCookie(context,"hail_session"));
      if(!session)return context.json({error:"Sign in with a passkey"},401);
      if(!session.passkey_credential_id||session.migration_state||!await invitations.authorized(session.account_id))
        return context.json({error:"Provider operator access required"},403);
      const retry=rate.take(session.account_id,30);
      if(retry!==null){context.header("Retry-After",String(retry));return context.json({error:"Rate limited"},429);}
      if(isStats){
        const range=context.req.query("range")??"day";
        if(!Object.hasOwn(statsRanges,range))return context.json({error:"Use day, week or month"},400);
        if(!statistics)return context.json({error:"Statistics unavailable"},503);
        return context.json(await statistics.read(range as StatsRange));
      }
      if(context.req.method==="GET")return context.json(await invitations.list());
      if(!session.passkey_verified_at||Date.now()-session.passkey_verified_at.getTime()>10*60_000)
        return context.json({error:"Sign in again before creating invitations"},403);
      if(context.req.header("Content-Type")!=="application/json"||context.req.header("Content-Encoding"))return context.json({error:"Use JSON"},415);
      const bytes=await accountRequestBytes(context.req.raw,4096);
      if(!bytes)return context.json({error:"Request too large"},413);
      let input:Record<string,unknown>;
      try{
        input=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as Record<string,unknown>;
        if(!input||typeof input!=="object"||Array.isArray(input))throw new Error();
      }catch{return context.json({error:"Invalid request"},400);}
      return context.json(await invitations.create(session.account_id,input));
    }catch(error){
      if(error instanceof OperatorError)return context.json({error:error.message},error.status);
      if(isStats)return context.json({error:"Statistics unavailable"},503);
      // Never expose email addresses, invitation bearers or upstream diagnostics.
      return context.json({error:"Invitation delivery unconfirmed; retry the same request"},503);
    }
  });
}
