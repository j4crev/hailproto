import type {Hono} from "hono";
import {getCookie} from "hono/cookie";
import type {AuthenticationResponseJSON} from "@simplewebauthn/server";
import {decodeBase64Url,encodeBase64Url} from "@hailproto/codec";
import {AccountConnections,ConnectionError} from "./connections.js";
import type {AccountApiRepository} from "./repository.js";
import {PasskeyError} from "./passkeys.js";
import {accountRequestBytes} from "./routes.js";
import {parseJsonWithoutDuplicateKeys} from "../discovery/strict-json.js";
import {FixedWindowRateLimit,clientAddress} from "../http/rate-limit.js";
import {withServingGeneration} from "../db/serving.js";

export function registerConnectionRoutes(app:Hono,connections:AccountConnections,accounts:AccountApiRepository,origin:string){
  const source=new FixedWindowRateLimit(),account=new FixedWindowRateLimit();
  if(connections.federation)app.post("/hail/connections/:step",async c=>{
    c.header("Cache-Control","no-store");c.header("Referrer-Policy","no-referrer");
    try{
      if(source.take(clientAddress(c.req.raw),120)!==null)throw new ConnectionError(429);
      if(c.req.header("Authorization")||c.req.header("Cookie")||c.req.header("Origin"))throw new ConnectionError(403);
      if(c.req.header("Content-Type")!=="application/json"||c.req.header("Content-Encoding"))throw new ConnectionError(415);
      const step=c.req.param("step");if(!["state","admit","commit","disconnect","sync"].includes(step))throw new ConnectionError(404);
      const bytes=await accountRequestBytes(c.req.raw,131072);if(!bytes)throw new ConnectionError(413);
      let input:Record<string,unknown>;
      try{input=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as Record<string,unknown>;
        if(!input||typeof input!=="object"||Array.isArray(input))throw new Error();}catch{throw new ConnectionError(400);}
      return c.json(await connections.federation!.handle(step as "state"|"admit"|"commit"|"disconnect"|"sync",input));
    }catch(error){return new Response(JSON.stringify({error:"Connection exchange not accepted"}),{status:error instanceof ConnectionError?error.status:503,
      headers:{"Content-Type":"application/json","Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});}
  });
  app.post("/hail/connections/invitations/review",async c=>{
    c.header("Cache-Control","no-store");c.header("Referrer-Policy","no-referrer");
    try{
      if(source.take(clientAddress(c.req.raw),60)!==null)throw new ConnectionError(429);
      if(c.req.header("Authorization")||c.req.header("Cookie")||c.req.header("Origin"))throw new ConnectionError(403);
      if(c.req.header("Content-Type")!=="application/json"||c.req.header("Content-Encoding"))throw new ConnectionError(415);
      const bytes=await accountRequestBytes(c.req.raw,2048);if(!bytes)throw new ConnectionError(413);
      let input:Record<string,unknown>;
      try{input=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as Record<string,unknown>;
        if(!input||typeof input!=="object"||Array.isArray(input))throw new Error();}catch{throw new ConnectionError(400);}
      return c.json(await connections.exportInvitation(input));
    }catch(error){return new Response(JSON.stringify({error:"Connection invitation unavailable"}),{status:error instanceof ConnectionError?error.status:503,
      headers:{"Content-Type":"application/json","Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});}
  });
  app.all("/api/v1/account/connections/:step?",async c=>{
    c.header("Cache-Control","no-store");c.header("Referrer-Policy","no-referrer");c.header("Vary","Cookie");
    const supplied=c.req.header("Origin");
    if(supplied!==origin&&!(c.req.method==="GET"&&supplied===undefined))return c.json({error:"Connection origin refused"},403);
    try{
      if(source.take(clientAddress(c.req.raw),60)!==null)throw new ConnectionError(429,"Wait before retrying connection requests.");
      if(c.req.header("Authorization"))throw new ConnectionError(403);
      const session=await accounts.authenticate(undefined,getCookie(c,"hail_session"));
      if(!session)throw new ConnectionError(401,"Sign in with your passkey first.");
      if(account.take(session.account_id,60)!==null)throw new ConnectionError(429,"Wait before retrying connection requests.");
      return await withServingGeneration(session.account_id,session.serving_generation??1,async()=>{
        const step=c.req.param("step");
        if(c.req.method==="GET")return c.json(step?await connections.status(session,step):await connections.list(session));
        if(c.req.method!=="POST")throw new ConnectionError(405);
        if(c.req.header("Content-Type")!=="application/json"||c.req.header("Content-Encoding"))throw new ConnectionError(415);
        const bytes=await accountRequestBytes(c.req.raw,65_536);if(!bytes)throw new ConnectionError(413);
        let input:Record<string,unknown>;
        try{input=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as Record<string,unknown>;
          if(!input||typeof input!=="object"||Array.isArray(input))throw new Error();}catch{throw new ConnectionError(400);}
        if(step==="review")return c.json(await connections.review(session,input));
        if(step==="prepare")return c.json(await connections.prepare(session,input));
        if(step==="commit"){
          if(Object.keys(input).some(key=>!["requestId","response","cose"].includes(key))||typeof input.requestId!=="string"||
            input.response!==undefined&&(!input.response||typeof input.response!=="object"||Array.isArray(input.response)))throw new ConnectionError(400);
          let external:Uint8Array|undefined;
          if(input.cose!==undefined){
            if(typeof input.cose!=="string"||input.cose.length>21846)throw new ConnectionError(400);
            try{external=decodeBase64Url(input.cose);if(external.length>16384||encodeBase64Url(external)!==input.cose)throw new Error();}catch{throw new ConnectionError(400);}
          }
          return c.json(await connections.commit(session,input.requestId,input.response as AuthenticationResponseJSON|undefined,external));
        }
        throw new ConnectionError(404);
      });
    }catch(error){
      const status=error instanceof ConnectionError||error instanceof PasskeyError?error.status:503;
      return new Response(JSON.stringify({error:error instanceof ConnectionError?error.message:"Connection not confirmed. Check the original approval before retrying."}),
        {status,headers:{"Content-Type":"application/json","Cache-Control":"no-store","Referrer-Policy":"no-referrer",...(status===429||status===503?{"Retry-After":"15"}:{})}});
    }
  });
}
