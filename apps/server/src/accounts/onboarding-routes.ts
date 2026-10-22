import { randomUUID,timingSafeEqual } from "node:crypto";
import { decodeBase64Url } from "@hailproto/codec";
import type { Hono } from "hono";
import type { SQL } from "bun";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import type { ActivationService } from "../onboarding/activation.js";
import type { PrivatePocOnboarding } from "../onboarding/private-poc.js";
import type { PublicOnboarding } from "../onboarding/public.js";
import { AccountApiRepository, ALL_ACCOUNT_SCOPES, tokenHash } from "./repository.js";
import { accountRequestBytes } from "./routes.js";
import {clientAddress,FixedWindowRateLimit} from "../http/rate-limit.js";

export interface SelfServiceOnboarding { sql: SQL; onboarding: PrivatePocOnboarding | PublicOnboarding;
  activation?: ActivationService; provider: string; profile?: "private-poc" | "strict-public-v1"; }

export function registerSelfServiceOnboarding(app: Hono, dependencies: SelfServiceOnboarding) {
  const rateLimit=new FixedWindowRateLimit();
  app.all("/api/v1/onboarding/:id?", async context => {
    context.header("Cache-Control","no-store");
    if (context.req.method !== "POST") return context.json({error:"Use POST"},405);
    const retry=rateLimit.take(clientAddress(context.req.raw),20);
    if(retry!==null){context.header("Retry-After",String(retry));return context.json({error:"Rate limited"},429);}
    if (context.req.header("Content-Type") !== "application/json" || context.req.header("Content-Encoding") !== undefined) return context.json({error:"Use uncoded JSON"},415);
    const id = context.req.param("id");
    let token: string | undefined;
    try {
      if (id) {
        if (!/^[0-9a-f-]{36}$/.test(id)) return context.json({error:"Invalid account"},400);
        token = /^Bearer (hailp_[A-Za-z0-9_-]{43})$/.exec(context.req.header("Authorization") ?? "")?.[1];
        const table=dependencies.profile==="strict-public-v1"?"public_onboarding_preparations":"private_poc_onboarding_preparations";
        const rows = await dependencies.sql<{signup_token_hash:Uint8Array|null}[]>`
          SELECT signup_token_hash FROM ${dependencies.sql.unsafe(table)} WHERE account_id=${id}`;
        if (!token || !rows[0]?.signup_token_hash || !timingSafeEqual(Buffer.from(tokenHash(token)),Buffer.from(rows[0].signup_token_hash))) return context.json({error:"Unauthorized signup"},401);
      }
      const bytes = await accountRequestBytes(context.req.raw);
      if (!bytes || bytes.length>64000) return context.json({error:"Request too large"},413);
      const input = parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as Record<string,unknown>;
      if (!input || typeof input !== "object" || Array.isArray(input)) return context.json({error:"Invalid request"},400);
      if (!id) {
        if (Object.keys(input).some(k=>!["address","recoveryKey","identityKey","custody","backupVerified","signupHash","monitorOrigin","monitorKey"].includes(k)) ||
          typeof input.address !== "string" || typeof input.recoveryKey !== "string" || input.recoveryKey.length>256 || typeof input.identityKey !== "string" || input.identityKey.length>256 ||
          typeof input.signupHash !== "string" || input.backupVerified !== true || !["owner-controlled","managed"].includes(input.custody as string)) return context.json({error:"Invalid preparation"},400);
        const hash=decodeBase64Url(input.signupHash);if(hash.length!==32)return context.json({error:"Invalid signup hash"},400);
        if(dependencies.profile==="strict-public-v1") {
          if(typeof input.monitorOrigin!=="string"||typeof input.monitorKey!=="string"||input.monitorOrigin.length>2048||input.monitorKey.length>256)return context.json({error:"Public signup requires monitor origin/key"},400);
          return context.json(await (dependencies.onboarding as PublicOnboarding).prepare(input.address,input.recoveryKey,input.identityKey,true,
            input.custody as "managed"|"owner-controlled",input.monitorOrigin,input.monitorKey,hash));
        }
        if(input.monitorOrigin!==undefined||input.monitorKey!==undefined)return context.json({error:"Private signup does not accept public monitor claims"},400);
        return context.json(await (dependencies.onboarding as PrivatePocOnboarding).prepare(input.address,input.recoveryKey,input.identityKey,true,input.custody as "managed"|"owner-controlled",hash));
      }
      if (Object.keys(input).some(k=>!["operation","binding","monitor","enrollmentToken"].includes(k)) || !input.operation || typeof input.operation !== "object" ||
        (input.binding !== null && typeof input.binding !== "string")) return context.json({error:"Invalid signed registration"},400);
      if(input.enrollmentToken!==undefined&&(typeof input.enrollmentToken!=="string"||!/^hailp_[A-Za-z0-9_-]{43}$/.test(input.enrollmentToken)||input.enrollmentToken===token))
        return context.json({error:"Invalid passkey enrollment"},400);
      const operation=new TextEncoder().encode(JSON.stringify(input.operation));
      const binding=input.binding === null ? new Uint8Array() : decodeBase64Url(input.binding as string);
      let monitor:{payloadBytes:Uint8Array;signature:Uint8Array}|undefined;
      if(input.monitor!==undefined) {
        if(!input.monitor||typeof input.monitor!=="object"||Array.isArray(input.monitor)||
          Object.keys(input.monitor).some(k=>!["payload","signature"].includes(k))||
          typeof (input.monitor as Record<string,unknown>).payload!=="string"||typeof (input.monitor as Record<string,unknown>).signature!=="string")
          return context.json({error:"Invalid monitor attestation"},400);
        const encoded=input.monitor as {payload:string;signature:string};
        monitor={payloadBytes:decodeBase64Url(encoded.payload),signature:decodeBase64Url(encoded.signature)};
      }
      let result:{did:string;state:string};
      if(dependencies.profile==="strict-public-v1") {
        const registered=await (dependencies.onboarding as PublicOnboarding).register(id,operation,binding);
        result=registered;
        if(!monitor)return context.json({did:result.did,state:result.state,
          operationCid:registered.operationCid,monitorRequired:true},202);
        await (dependencies.onboarding as PublicOnboarding).activate(id,monitor);
      } else {
        if(monitor)return context.json({error:"Private signup does not accept public monitor claims"},400);
        result=await (dependencies.onboarding as PrivatePocOnboarding).register(id,operation,binding);
        await dependencies.activation!.activate(id);
      }
      const address = await dependencies.sql<{canonical_address:string}[]>`SELECT canonical_address FROM provider_accounts WHERE id=${id}`;
      const credential=await new AccountApiRepository(dependencies.sql).issue(address[0]!.canonical_address,true,token,[...ALL_ACCOUNT_SCOPES]);
      let enrollment;
      if(typeof input.enrollmentToken==="string"){
        const hash=tokenHash(input.enrollmentToken),rows=await dependencies.sql.begin(async tx=>{
          if((await tx`SELECT id FROM account_api_credentials WHERE token_hash=${hash}`).length)throw new Error("Enrollment token conflicts");
          await tx`INSERT INTO account_passkey_enrollment_capabilities(id,token_hash,account_id,serving_generation,expires_at)
            SELECT ${randomUUID()},${hash},${id},generation,clock_timestamp()+interval '10 minutes'
            FROM account_serving_generations WHERE account_id=${id} ON CONFLICT (token_hash) DO NOTHING`;
          return tx<{account_id:string;serving_generation:number|string;expires_at:Date}[]>`SELECT capability.account_id,capability.serving_generation,capability.expires_at
            FROM account_passkey_enrollment_capabilities capability JOIN account_serving_generations generation
              ON generation.account_id=capability.account_id AND generation.generation=capability.serving_generation
            WHERE capability.token_hash=${hash}`;
        }),capability=rows[0];
        if(!capability||capability.account_id!==id)throw new Error("Enrollment token conflicts");
        enrollment={type:"hailp.passkey-enrollment",version:1,provider:dependencies.provider,accountId:id,token:input.enrollmentToken,
          url:`${dependencies.provider}/auth/recover#token=${encodeURIComponent(input.enrollmentToken)}`,expiresAt:capability.expires_at.toISOString()};
      }
      return context.json({did:result.did,credential:{type:"hailp.api-credential",version:1,provider:dependencies.provider,...credential},...(enrollment?{enrollment}:{})});
    } catch { return context.json({error:"Signup not completed; retain artifacts and retry the same request"},409); }
  });
}
