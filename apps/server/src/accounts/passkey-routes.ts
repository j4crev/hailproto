import type {Context,Hono} from "hono";
import {deleteCookie,getCookie,setCookie} from "hono/cookie";
import type {AuthenticationResponseJSON,RegistrationResponseJSON} from "@simplewebauthn/server";
import {accountRequestBytes} from "./routes.js";
import type {AccountApiRepository} from "./repository.js";
import {PasskeyAuth,PasskeyError} from "./passkeys.js";
import {parseJsonWithoutDuplicateKeys} from "../discovery/strict-json.js";

const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const COOKIE="hail_session";

async function input(request:Request){
  if(request.headers.get("content-type")!=="application/json"||request.headers.has("content-encoding"))throw new PasskeyError(400);
  const bytes=await accountRequestBytes(request,65_536);if(!bytes)throw new PasskeyError(400);
  let value:unknown;try{value=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{throw new PasskeyError(400);}
  if(!value||typeof value!=="object"||Array.isArray(value))throw new PasskeyError(400);
  return value as Record<string,unknown>;
}

export function registerPasskeyRoutes(app:Hono,passkeys:PasskeyAuth,accounts:AccountApiRepository){
  let window=Date.now(),requests=0;
  app.use("/api/v1/auth/*",async(context,next)=>{
    context.header("Cache-Control","no-store");
    const origin=context.req.header("Origin"),registration=context.req.path.includes("/registration");
    if(origin!==passkeys.origin&&!(registration&&origin===undefined))return context.json({type:"about:blank",title:"Forbidden",status:403},403);
    if(Date.now()-window>=60_000){window=Date.now();requests=0;}
    if(++requests>120){context.header("Retry-After","60");return context.json({type:"about:blank",title:"Too Many Requests",status:429},429);}
    await next();
  });
  const run=async(context:Context,operation:()=>Promise<unknown>)=>{
    try{return context.json(await operation());}
    catch(error){
      const status=error instanceof PasskeyError?error.status:503;
      if(status===503)context.header("Retry-After","30");
      return context.json({type:"about:blank",title:status===400?"Bad Request":status===401?"Unauthorized":status===403?"Forbidden":
        status===404?"Not Found":status===409?"Conflict":status===429?"Too Many Requests":"Service Unavailable",status},status);
    }
  };
  app.post("/api/v1/auth/passkeys/registration/options",context=>run(context,async()=>{
    const session=await accounts.authenticate(context.req.header("Authorization"),getCookie(context,COOKIE));
    if(!session)throw new PasskeyError(401);
    return passkeys.registrationOptions(session);
  }));
  app.post("/api/v1/auth/passkeys/registration",context=>run(context,async()=>{
    const session=await accounts.authenticate(context.req.header("Authorization"),getCookie(context,COOKIE));
    if(!session)throw new PasskeyError(401);
    const value=await input(context.req.raw);
    if(Object.keys(value).length!==3||typeof value.challengeId!=="string"||!UUID.test(value.challengeId)||
      typeof value.label!=="string"||!value.response||typeof value.response!=="object"||Array.isArray(value.response))throw new PasskeyError(400);
    return passkeys.register(session,value.challengeId,value.response as RegistrationResponseJSON,value.label);
  }));
  app.get("/api/v1/auth/passkeys",context=>run(context,async()=>{
    const session=await accounts.authenticate(context.req.header("Authorization"),getCookie(context,COOKIE));
    if(!session)throw new PasskeyError(401);return passkeys.list(session);
  }));
  app.post("/api/v1/auth/passkeys/manage",context=>run(context,async()=>{
    const session=await accounts.authenticate(context.req.header("Authorization"),getCookie(context,COOKIE));
    if(!session)throw new PasskeyError(401);const value=await input(context.req.raw);
    if(typeof value.credentialId!=="string")throw new PasskeyError(400);
    if(Object.keys(value).length===2&&typeof value.label==="string")return passkeys.rename(session,value.credentialId,value.label);
    if(Object.keys(value).length===2&&value.revoke===true)return passkeys.revoke(session,value.credentialId);
    throw new PasskeyError(400);
  }));
  app.post("/api/v1/auth/passkeys/authentication/options",context=>run(context,()=>passkeys.authenticationOptions()));
  app.post("/api/v1/auth/passkeys/authentication",context=>run(context,async()=>{
    const value=await input(context.req.raw);
    if(Object.keys(value).length!==2||typeof value.challengeId!=="string"||!UUID.test(value.challengeId)||
      !value.response||typeof value.response!=="object"||Array.isArray(value.response))throw new PasskeyError(400);
    const session=await passkeys.authenticate(value.challengeId,value.response as AuthenticationResponseJSON);
    await passkeys.logout(getCookie(context,COOKIE));
    setCookie(context,COOKIE,session.token,{httpOnly:true,secure:passkeys.origin.startsWith("https://"),sameSite:"Lax",path:"/",maxAge:43_200});
    return {authenticated:true,expiresAt:session.expiresAt.toISOString()};
  }));
  app.post("/api/v1/auth/logout",context=>run(context,async()=>{
    await passkeys.logout(getCookie(context,COOKIE));
    deleteCookie(context,COOKIE,{secure:passkeys.origin.startsWith("https://"),path:"/"});
    return {loggedOut:true};
  }));
}
