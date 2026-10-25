import type { Hono } from "hono";
import type { TransferInvitationReceiver } from "./invitation-receiver.js";
import type { TransferAddressReservation } from "./address-selection.js";
import type { MigrationFenceService } from "./fence.js";
import type { TransferFinalRequestPublisher } from "./final-request-publisher.js";
import type { TransferGrantSubmission } from "./grant-submission.js";
import type { TransferRateLimit } from "./rate-limit.js";
import type { TransferCancellationService } from "./cancellation.js";
import type { TransferCancellationReceiver } from "./cancellation-receiver.js";
import type { PortableTransferCompletion } from "./poc-completion.js";
import type { ManagedTransferInvitationReceiver } from "./managed-invitation-receiver.js";
import type { ManagedTransferAddressReservation } from "./managed-address-selection.js";
import type { ManagedTransferFencePublisher } from "./managed-fence-publisher.js";
import type { ManagedMigrationFenceService } from "./managed-fence.js";
import type {ManagedMigrationCompletion} from "./managed-completion.js";
import { decodeDeterministic } from "@hailproto/codec";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import { boundedTransferBody, parseInvitationWire, parseFinalRequestWire,
  parseRequestWire, parseCancellationWire, requestWire,
  TRANSFER_MEDIA_TYPE } from "./wire.js";
import { parseManagedInvitationWire } from "./wire.js";
import {clientAddress} from "../http/rate-limit.js";
import type {ConnectionHandoverStage} from "./connection-handover-stage.js";
import type {ConnectionReconstruction} from './connection-reconstruction.js';

export function registerConnectionReconstructionRoutes(app:Hono,reconstruction:ConnectionReconstruction,rateLimit?:TransferRateLimit):void {
  app.post('/hail/transfers/connection-progress/:phase',async context=>{
    context.header('Cache-Control','no-store');context.header('Referrer-Policy','no-referrer');
    if(context.req.header('Authorization')||context.req.header('Cookie')||context.req.header('Origin'))return context.body(null,403);
    if(rateLimit&&!await rateLimit.admit('request',clientAddress(context.req.raw)))return context.body(null,429);
    if(context.req.header('Content-Type')!==TRANSFER_MEDIA_TYPE||context.req.header('Content-Encoding'))return context.body(null,415);
    const phase=context.req.param('phase');if(!['freeze','transition'].includes(phase))return context.body(null,404);
    try{
      const input=parseJsonWithoutDuplicateKeys(new TextDecoder('utf-8',{fatal:true}).decode(await boundedTransferBody(context.req.raw.body,context.req.header('Content-Length')??null,200000)));
      return context.json(phase==='freeze'?await reconstruction.acceptFreeze(input):await reconstruction.acceptTransition(input),200,{'Content-Type':TRANSFER_MEDIA_TYPE});
    }catch{return context.body(null,400);}
  });
}

export function registerConnectionHandoverRoutes(app:Hono,stage:Pick<ConnectionHandoverStage,"accept">,rateLimit?:TransferRateLimit):void {
  app.post("/hail/transfers/connection-handovers",async context=>{
    context.header("Cache-Control","no-store");context.header("Referrer-Policy","no-referrer");
    if(context.req.header("Authorization")||context.req.header("Cookie")||context.req.header("Origin"))return context.body(null,403);
    if(rateLimit&&!await rateLimit.admit("request",clientAddress(context.req.raw)))return context.body(null,429);
    if(context.req.header("Content-Type")!==TRANSFER_MEDIA_TYPE||context.req.header("Content-Encoding"))return context.body(null,415);
    try{
      const input=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(await boundedTransferBody(context.req.raw.body,context.req.header("Content-Length")??null,200000)));
      return context.json(await stage.accept(input),200,{"Content-Type":TRANSFER_MEDIA_TYPE});
    }catch{return context.body(null,400);}
  });
}

export function registerManagedTransferRoutes(app:Hono,receiver?:ManagedTransferInvitationReceiver,
  rateLimit?:TransferRateLimit,reservations?:ManagedTransferAddressReservation,
  publisher?:Pick<ManagedTransferFencePublisher,"publish">,fence?:ManagedMigrationFenceService,
  completion?:ManagedMigrationCompletion):void {
  if(receiver)app.post("/.well-known/hail/transfers/managed-invitations",async context=>{
    if(rateLimit&&!await rateLimit.admit("invitation",clientAddress(context.req.raw)))return new Response(null,{status:429,headers:{"Cache-Control":"no-store"}});
    if(context.req.header("content-type")!==TRANSFER_MEDIA_TYPE||context.req.header("content-encoding")!==undefined)
      return new Response(null,{status:415,headers:{"Cache-Control":"no-store"}});
    try {
      const {grant,acknowledgement}=parseManagedInvitationWire(await boundedTransferBody(context.req.raw.body,
        context.req.header("content-length")??null));
      const offer=await receiver.receive(grant,acknowledgement);
      return new Response(Uint8Array.from(requestWire(offer)),{status:200,
        headers:{"Content-Type":TRANSFER_MEDIA_TYPE,"Cache-Control":"no-store"}});
    } catch {return new Response(null,{status:400,headers:{"Cache-Control":"no-store"}});}
  });
  if(reservations&&publisher)app.post("/.well-known/hail/transfers/managed-reservations",async context=>{
    if(rateLimit&&!await rateLimit.admit("reservation",clientAddress(context.req.raw)))return new Response(null,{status:429,headers:{"Cache-Control":"no-store"}});
    if(context.req.header("content-type")!==TRANSFER_MEDIA_TYPE||context.req.header("content-encoding")!==undefined)
      return new Response(null,{status:415,headers:{"Cache-Control":"no-store"}});
    try {
      const selection=parseRequestWire(await boundedTransferBody(context.req.raw.body,
        context.req.header("content-length")??null));
      const reserved=await reservations.reserve(selection);
      try {await publisher.publish(reserved.prepared.transferId);}
      catch {return new Response(Uint8Array.from(requestWire(reserved.reservation)),{status:202,
        headers:{"Content-Type":TRANSFER_MEDIA_TYPE,"Cache-Control":"no-store"}});}
      return new Response(Uint8Array.from(requestWire(reserved.reservation)),{status:200,
        headers:{"Content-Type":TRANSFER_MEDIA_TYPE,"Cache-Control":"no-store"}});
    } catch(error) {
      return new Response(null,{status:error instanceof Error&&error.message==="Address not available"?409:
        error instanceof Error&&error.message.includes("rate limited")?429:400,headers:{"Cache-Control":"no-store"}});
    }
  });
  if(fence)app.post("/hail/transfers/managed-requests",async context=>{
    if(rateLimit&&!await rateLimit.admit("request",clientAddress(context.req.raw)))return new Response(null,{status:429,headers:{"Cache-Control":"no-store"}});
    if(context.req.header("content-type")!==TRANSFER_MEDIA_TYPE||context.req.header("content-encoding")!==undefined)
      return new Response(null,{status:415,headers:{"Cache-Control":"no-store"}});
    try {
      const {selection,reservation,request}=parseFinalRequestWire(await boundedTransferBody(context.req.raw.body,
        context.req.header("content-length")??null));
      if(!await fence.previouslyAccepted(request,selection,reservation))await fence.begin(request,selection,reservation);
      return new Response(null,{status:204,headers:{"Cache-Control":"no-store"}});
    } catch {return new Response(null,{status:400,headers:{"Cache-Control":"no-store"}});}
  });
  if(fence)app.post("/.well-known/hail/transfers/managed-retirements",async context=>{
    if(rateLimit&&!await rateLimit.admit("request",clientAddress(context.req.raw)))return new Response(null,{status:429});
    if(context.req.header("Content-Type")!==TRANSFER_MEDIA_TYPE||context.req.header("Content-Encoding")!==undefined)
      return new Response(null,{status:415});
    try {
      const signed=parseRequestWire(await boundedTransferBody(context.req.raw.body,context.req.header("Content-Length")??null));
      const receipt=decodeDeterministic(signed.payloadBytes) as {did:string;transfer_id:string};
      if(typeof receipt.did!=="string"||!/^did:plc:[a-z2-7]{24}$/.test(receipt.did)||typeof receipt.transfer_id!=="string"||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(receipt.transfer_id))throw new Error("Invalid retirement receipt subject");
      await fence.retire(receipt.did,receipt.transfer_id,signed);
      return new Response(null,{status:204,headers:{"Cache-Control":"no-store"}});
    } catch {return new Response(null,{status:400,headers:{"Cache-Control":"no-store"}});}
  });
  if(completion)app.post("/.well-known/hail/transfers/managed-completions",async context=>{
    if(rateLimit&&!await rateLimit.admit("request",clientAddress(context.req.raw)))return new Response(null,{status:429});
    if(context.req.header("Content-Type")!==TRANSFER_MEDIA_TYPE||context.req.header("Content-Encoding")!==undefined)
      return new Response(null,{status:415});
    try {
      const input=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(
        await boundedTransferBody(context.req.raw.body,context.req.header("Content-Length")??null,100_000_000)));
      return context.json(await completion.complete(input),200,{"Content-Type":TRANSFER_MEDIA_TYPE,"Cache-Control":"no-store"});
    } catch {return new Response(null,{status:400,headers:{"Cache-Control":"no-store"}});}
  });
}

export function registerTransferRoutes(app: Hono, receiver: TransferInvitationReceiver,
  reservations?: TransferAddressReservation, fence?: MigrationFenceService,
  publisher?: Pick<TransferFinalRequestPublisher, "publish">,
  grantSubmission?: TransferGrantSubmission, rateLimit?: TransferRateLimit,
  cancellation?: TransferCancellationService,
  cancellationReceiver?: TransferCancellationReceiver,completion?:PortableTransferCompletion): void {
  if(completion) {
    app.post("/.well-known/hail/transfers/completions",async context=>{
      if(rateLimit&&!await rateLimit.admit("request",clientAddress(context.req.raw)))return new Response(null,{status:429});
      if(context.req.header("Content-Type")!==TRANSFER_MEDIA_TYPE||context.req.header("Content-Encoding")!==undefined)return new Response(null,{status:415});
      context.header("Cache-Control","no-store");
      try {
        const input=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(await boundedTransferBody(context.req.raw.body,context.req.header("Content-Length")??null,100000000)));
        return context.json(await completion.complete(input),200,{"Content-Type":TRANSFER_MEDIA_TYPE});
      }catch{return new Response(null,{status:400,headers:{"Cache-Control":"no-store"}});}
    });
    if(fence)app.post("/.well-known/hail/transfers/retirements",async context=>{
      if(rateLimit&&!await rateLimit.admit("request",clientAddress(context.req.raw)))return new Response(null,{status:429});
      if(context.req.header("Content-Type")!==TRANSFER_MEDIA_TYPE||context.req.header("Content-Encoding")!==undefined)return new Response(null,{status:415});
      try {
        const signed=parseRequestWire(await boundedTransferBody(context.req.raw.body,context.req.header("Content-Length")??null));
        const receipt=decodeDeterministic(signed.payloadBytes) as {did:string;transfer_id:string};
        if(typeof receipt.did!=="string"||!/^did:plc:[a-z2-7]{24}$/.test(receipt.did)||typeof receipt.transfer_id!=="string"||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(receipt.transfer_id))throw new Error("Invalid retirement receipt subject");
        await fence.retire(receipt.did,receipt.transfer_id,signed);return new Response(null,{status:204,headers:{"Cache-Control":"no-store"}});
      }catch{return new Response(null,{status:400,headers:{"Cache-Control":"no-store"}});}
    });
  }
  app.post("/.well-known/hail/transfers/invitations", async (context) => {
    if(rateLimit&&!await rateLimit.admit("invitation",clientAddress(context.req.raw)))return new Response(null,{status:429});
    if (context.req.header("content-type") !== TRANSFER_MEDIA_TYPE ||
      context.req.header("content-encoding") !== undefined) {
      return new Response(null, { status: 415, headers: { "Cache-Control": "no-store" } });
    }
    try {
      const { grant, invitation } = parseInvitationWire(await boundedTransferBody(
        context.req.raw.body, context.req.header("content-length") ?? null));
      const signedRequest = await receiver.receive(grant, invitation);
      return new Response(Uint8Array.from(requestWire(signedRequest)), { status: 200, headers: {
        "Content-Type": TRANSFER_MEDIA_TYPE, "Cache-Control": "no-store",
      } });
    } catch {
      return new Response(null, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
  });
  if (grantSubmission) app.post("/hail/transfers/grants", async (context) => {
    if(rateLimit&&!await rateLimit.admit("grant",clientAddress(context.req.raw)))return new Response(null,{status:429});
    if (context.req.header("content-type") !== TRANSFER_MEDIA_TYPE ||
      context.req.header("content-encoding") !== undefined) return new Response(null, { status: 415 });
    try {
      const signed = parseRequestWire(await boundedTransferBody(context.req.raw.body,
        context.req.header("content-length") ?? null));
      const offer = await grantSubmission.submit(signed);
      if (!offer) return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
      return new Response(Uint8Array.from(requestWire(offer)), { status: 200,
        headers: { "Content-Type": TRANSFER_MEDIA_TYPE, "Cache-Control": "no-store" } });
    } catch (error) {
      return new Response(null, { status: error instanceof Error && error.message.includes("rate limited") ? 429 : 400,
        headers: { "Cache-Control": "no-store" } });
    }
  });
  if (reservations && publisher) app.post("/.well-known/hail/transfers/reservations", async (context) => {
    if(rateLimit&&!await rateLimit.admit("reservation",clientAddress(context.req.raw)))return new Response(null,{status:429});
    if (context.req.header("content-type") !== TRANSFER_MEDIA_TYPE ||
      context.req.header("content-encoding") !== undefined) return new Response(null, { status: 415 });
    try {
      const selection = parseRequestWire(await boundedTransferBody(context.req.raw.body,
        context.req.header("content-length") ?? null));
      const reserved = await reservations.reserve(selection);
      // The reservation survives a failed or ambiguous push; retrying the
      // same signed selection resumes publication without choosing a new name.
      try { await publisher.publish(reserved.prepared.transferId); }
      catch { return new Response(Uint8Array.from(requestWire(reserved.receipt)), { status: 202,
        headers: { "Content-Type": TRANSFER_MEDIA_TYPE, "Cache-Control": "no-store" } }); }
      return new Response(Uint8Array.from(requestWire(reserved.receipt)), { status: 200,
        headers: { "Content-Type": TRANSFER_MEDIA_TYPE, "Cache-Control": "no-store" } });
    } catch (error) {
      return new Response(null, { status: error instanceof Error && error.message === "Address not available" ? 409 :
        error instanceof Error && error.message.includes("rate limited") ? 429 : 400,
        headers: { "Cache-Control": "no-store" } });
    }
  });
  if (fence) app.post("/hail/transfers/requests", async (context) => {
    if(rateLimit&&!await rateLimit.admit("request",clientAddress(context.req.raw)))return new Response(null,{status:429});
    if (context.req.header("content-type") !== TRANSFER_MEDIA_TYPE ||
      context.req.header("content-encoding") !== undefined) return new Response(null, { status: 415 });
    try {
      const { selection, reservation, request } = parseFinalRequestWire(await boundedTransferBody(
        context.req.raw.body, context.req.header("content-length") ?? null));
      if (await fence.previouslyAccepted(request, selection, reservation)) {
        return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      }
      await fence.begin(request, selection, reservation);
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    } catch { return new Response(null, { status: 400, headers: { "Cache-Control": "no-store" } }); }
  });
  if (cancellation) app.post("/hail/transfers/cancellations", async (context) => {
    if(rateLimit&&!await rateLimit.admit("grant",clientAddress(context.req.raw)))return new Response(null,{status:429});
    if (context.req.header("content-type") !== TRANSFER_MEDIA_TYPE ||
      context.req.header("content-encoding") !== undefined) return new Response(null, { status: 415 });
    try {
      const signed = parseRequestWire(await boundedTransferBody(context.req.raw.body,
        context.req.header("content-length") ?? null));
      const receipt = await cancellation.cancel(signed);
      return new Response(Uint8Array.from(requestWire(receipt)), { status: 200,
        headers: { "Content-Type": TRANSFER_MEDIA_TYPE, "Cache-Control": "no-store" } });
    } catch { return new Response(null, { status: 400, headers: { "Cache-Control": "no-store" } }); }
  });
  if (cancellationReceiver) app.post("/.well-known/hail/transfers/cancellations", async (context) => {
    if(rateLimit&&!await rateLimit.admit("invitation",clientAddress(context.req.raw)))return new Response(null,{status:429});
    if (context.req.header("content-type") !== TRANSFER_MEDIA_TYPE ||
      context.req.header("content-encoding") !== undefined) return new Response(null, { status: 415 });
    try {
      const { cancellation: signed, receipt } = parseCancellationWire(await boundedTransferBody(
        context.req.raw.body, context.req.header("content-length") ?? null));
      await cancellationReceiver.receive(signed, receipt);
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    } catch { return new Response(null, { status: 400, headers: { "Cache-Control": "no-store" } }); }
  });
}
