import type {Context,Hono} from "hono";
import {deleteCookie,getCookie,setCookie} from "hono/cookie";
import type {AuthenticationResponseJSON,RegistrationResponseJSON} from "@simplewebauthn/server";
import {accountRequestBytes} from "./routes.js";
import type {AccountApiRepository} from "./repository.js";
import {PasskeyAuth,PasskeyError} from "./passkeys.js";
import {parseJsonWithoutDuplicateKeys} from "../discovery/strict-json.js";
import {clientAddress,FixedWindowRateLimit} from "../http/rate-limit.js";

const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const COOKIE="hail_session";
const OPERATIONS:Record<string,string>={
  "/api/v1/auth/passkeys/registration/options":"passkey.registration-options","/api/v1/auth/passkeys/registration":"passkey.registration",
  "/api/v1/auth/passkeys":"passkey.list","/api/v1/auth/passkeys/manage":"passkey.manage",
  "/api/v1/auth/passkeys/sessions/revoke":"session.revoke","/api/v1/auth/passkeys/recovery/options":"passkey.recovery-options",
  "/api/v1/auth/passkeys/recovery":"passkey.recovery","/api/v1/auth/passkeys/authentication/options":"passkey.authentication-options",
  "/api/v1/auth/passkeys/authentication":"passkey.authentication","/api/v1/auth/authorization/prepare":"authorization.prepare",
  "/api/v1/auth/authorization/details":"authorization.details","/api/v1/auth/authorization/complete":"authorization.complete",
  "/api/v1/auth/authorization/token":"authorization.token","/api/v1/auth/logout":"session.logout"};
export interface PasskeyAuditEvent {type:"hail.auth";operation:string;outcome:"accepted"|"refused"|"failed";status:number}

async function input(request:Request){
  if(request.headers.get("content-type")!=="application/json"||request.headers.has("content-encoding"))throw new PasskeyError(400);
  const bytes=await accountRequestBytes(request,65_536);if(!bytes)throw new PasskeyError(400);
  let value:unknown;try{value=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{throw new PasskeyError(400);}
  if(!value||typeof value!=="object"||Array.isArray(value))throw new PasskeyError(400);
  return value as Record<string,unknown>;
}

export function registerPasskeyRoutes(app:Hono,passkeys:PasskeyAuth,accounts:AccountApiRepository,
  audit:(event:PasskeyAuditEvent)=>void=event=>console.info(JSON.stringify(event))){
  const rateLimit=new FixedWindowRateLimit();
  const record=(context:Context,status:number)=>audit({type:"hail.auth",operation:OPERATIONS[context.req.path]??"unknown",
    outcome:status<400?"accepted":status<500?"refused":"failed",status});
  app.use("/api/v1/auth/*",async(context,next)=>{
    context.header("Cache-Control","no-store");
    const origin=context.req.header("Origin"),trustedServer=context.req.path.includes("/registration")||
      ["/api/v1/auth/authorization/prepare","/api/v1/auth/authorization/token"].includes(context.req.path);
    if(origin!==passkeys.origin&&!(trustedServer&&origin===undefined)){record(context,403);return context.json({type:"about:blank",title:"Forbidden",status:403},403);}
    const retry=rateLimit.take(clientAddress(context.req.raw),120);
    if(retry!==null){context.header("Retry-After",String(retry));record(context,429);return context.json({type:"about:blank",title:"Too Many Requests",status:429},429);}
    await next();
  });
  const run=async(context:Context,operation:()=>Promise<unknown>)=>{
    try{const result=await operation();record(context,200);return context.json(result);}
    catch(error){
      const status=error instanceof PasskeyError?error.status:503;
      if(status===503)context.header("Retry-After","30");
      record(context,status);
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
  app.post("/api/v1/auth/passkeys/sessions/revoke",context=>run(context,async()=>{
    const session=await accounts.authenticate(context.req.header("Authorization"),getCookie(context,COOKIE));
    if(!session)throw new PasskeyError(401);
    let sessionIds:string[]|undefined;
    if(context.req.raw.body!==null){
      const value=await input(context.req.raw);
      if(Object.keys(value).length!==1||!Array.isArray(value.sessionIds)||!value.sessionIds.length||
        value.sessionIds.some(id=>typeof id!=="string"||!UUID.test(id)))throw new PasskeyError(400);
      sessionIds=value.sessionIds as string[];
    }
    const result=await passkeys.revokeSessions(session,sessionIds);
    if(!sessionIds||sessionIds.includes(session.credential_id))
      deleteCookie(context,COOKIE,{secure:passkeys.origin.startsWith("https://"),path:"/"});
    return result;
  }));
  app.post("/api/v1/auth/authorization/prepare",context=>run(context,async()=>passkeys.prepareAuthorization(await input(context.req.raw))));
  app.post("/api/v1/auth/authorization/details",context=>run(context,async()=>{
    const value=await input(context.req.raw);
    if(Object.keys(value).length!==2||typeof value.requestId!=="string"||typeof value.state!=="string")throw new PasskeyError(400);
    return passkeys.authorizationDetails(value.requestId,value.state);
  }));
  app.post("/api/v1/auth/authorization/complete",context=>run(context,async()=>{
    const session=await accounts.authenticate(context.req.header("Authorization"),getCookie(context,COOKIE));
    if(!session)throw new PasskeyError(401);const value=await input(context.req.raw);
    if(Object.keys(value).length!==3||typeof value.requestId!=="string"||typeof value.state!=="string"||typeof value.code!=="string")
      throw new PasskeyError(400);
    return passkeys.completeAuthorization(session,value.requestId,value.state,value.code);
  }));
  app.post("/api/v1/auth/authorization/token",context=>run(context,async()=>passkeys.exchangeAuthorization(await input(context.req.raw))));
  app.post("/api/v1/auth/passkeys/recovery/options",context=>run(context,async()=>{
    const value=await input(context.req.raw);
    if(Object.keys(value).length!==1||typeof value.token!=="string")throw new PasskeyError(400);
    return passkeys.recoveryOptions(value.token);
  }));
  app.post("/api/v1/auth/passkeys/recovery",context=>run(context,async()=>{
    const value=await input(context.req.raw);
    if(Object.keys(value).length!==4||typeof value.token!=="string"||typeof value.challengeId!=="string"||
      typeof value.label!=="string"||!value.response||typeof value.response!=="object"||Array.isArray(value.response))throw new PasskeyError(400);
    return passkeys.recover(value.token,value.challengeId,value.response as RegistrationResponseJSON,value.label);
  }));
  app.post("/api/v1/auth/passkeys/authentication/options",context=>run(context,()=>passkeys.authenticationOptions()));
  app.post("/api/v1/auth/passkeys/authentication",context=>run(context,async()=>{
    const value=await input(context.req.raw);
    if(Object.keys(value).length!==2||typeof value.challengeId!=="string"||!UUID.test(value.challengeId)||
      !value.response||typeof value.response!=="object"||Array.isArray(value.response))throw new PasskeyError(400);
    const session=await passkeys.authenticate(value.challengeId,value.response as AuthenticationResponseJSON);
    await passkeys.logout(getCookie(context,COOKIE));
    setCookie(context,COOKIE,session.token,{httpOnly:true,secure:passkeys.origin.startsWith("https://"),sameSite:"Lax",path:"/",maxAge:passkeys.sessionPolicy.absoluteSeconds});
    return {authenticated:true,expiresAt:session.expiresAt.toISOString()};
  }));
  app.post("/api/v1/auth/logout",context=>run(context,async()=>{
    await passkeys.logout(getCookie(context,COOKIE));
    deleteCookie(context,COOKIE,{secure:passkeys.origin.startsWith("https://"),path:"/"});
    return {loggedOut:true};
  }));
}
