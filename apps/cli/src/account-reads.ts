import { setTimeout as sleep } from "node:timers/promises";
import { AccountApiError, type AccountApiClient } from "./account-api.js";
import { ClientError } from "./client-error.js";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DID = /^did:plc:[a-z2-7]{24}$/;

export function validCursor(kind: "grants" | "credentials" | "inbox", value: unknown): value is string {
  return typeof value === "string" && (kind === "inbox" ? /^[A-Za-z0-9_-]{1,1024}$/.test(value) : (kind === "grants" ? ID : UUID).test(value));
}

export async function listPages(client: AccountApiClient, kind: "grants" | "credentials" | "inbox", after?: string, pages = 1) {
  if (!Number.isInteger(pages) || pages < 1 || pages > 100 || after !== undefined && !validCursor(kind, after)) throw new ClientError("USAGE_ERROR", "Invalid page count or continuation cursor");
  const field = kind === "inbox" ? "messages" : kind;
  const items: Record<string, unknown>[] = [], seen = new Set(after ? [after] : []);
  let cursor = after, next: string | null = null, size = 0;
  let first: Record<string, unknown> = {};
  for (let page = 0; page < pages; page++) {
    const result = await client.request(`/${kind}${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`);
    size += Buffer.byteLength(JSON.stringify(result));
    const rows = result[field];
    if (size > 8 * 1024 * 1024 || !Array.isArray(rows) || rows.length > 50 ||
      rows.some(row => !row || typeof row !== "object" || Array.isArray(row) ||
        !(kind === "credentials" ? UUID.test(row.credentialId) : kind === "grants" ? ID.test(row.grantId) : ID.test(row.messageId) && DID.test(row.sender))) ||
      result.next !== null && !validCursor(kind, result.next) || result.next !== null && !rows.length) {
      throw new ClientError("RESPONSE_ERROR", "Provider returned an invalid or oversized list page");
    }
    if (page === 0) first = result;
    items.push(...rows);
    next = result.next as string | null;
    if (next === null) break;
    if (seen.has(next)) throw new ClientError("RESPONSE_ERROR", "Provider returned a repeated continuation cursor");
    seen.add(next); cursor = next;
  }
  return { ...first, [field]: items, next };
}

export async function waitForStatus(client: AccountApiClient, id: string, seconds?: number, interval = 2) {
  if (!ID.test(id) || seconds !== undefined && (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) ||
    !Number.isInteger(interval) || interval < 1 || interval > 30) throw new ClientError("USAGE_ERROR", "Invalid message ID or wait bounds");
  const signal = seconds === undefined ? undefined : AbortSignal.timeout(seconds * 1000);
  let last: Record<string, unknown> | undefined;
  let failure: unknown;
  while (!signal?.aborted) {
    let delay = interval;
    try {
      const result = await client.request(`/messages/${id}`, undefined, undefined, undefined, signal);
      if (result.messageId !== id || !["indeterminate", "accepted", "on-hold", "delivered", "failed", "cancelled"].includes(result.state as string) ||
        (result.state === "indeterminate" ? result.revision !== null : !Number.isSafeInteger(result.revision) || Number(result.revision) < 1)) {
        throw new ClientError("RESPONSE_ERROR", "Provider returned invalid message status");
      }
      last = result;
      if (seconds === undefined) return result;
      if (["delivered", "failed", "cancelled"].includes(result.state as string)) return { ...result, wait: { completed: true, timedOut: false } };
    } catch (error) {
      failure = error;
      if (signal?.aborted) break;
      if (!signal || !(error instanceof AccountApiError) || ![429, 503].includes(error.status)) throw error;
      delay = Math.max(interval, error.retryAfterSeconds ?? interval);
    }
    try { await sleep(delay * 1000, undefined, { signal: signal! }); }
    catch (error) { if (!signal?.aborted) throw error; }
  }
  if (!last) throw failure ?? new ClientError("TRANSPORT_ERROR", "Status wait deadline elapsed before any status was observed");
  return { ...last, wait: { completed: false, timedOut: true } };
}

/** Reuse the last printed cursor after interruption; results may replay, never imply acknowledgement. */
export async function waitForInbox(client:AccountApiClient,from?:string,after?:string,seconds=60,interval=2,externalSignal?:AbortSignal) {
  if(from!==undefined&&!DID.test(from)||after!==undefined&&!validCursor("inbox",after)||
    !Number.isInteger(seconds)||seconds<1||seconds>300||!Number.isInteger(interval)||interval<1||interval>30)
    throw new ClientError("USAGE_ERROR","Invalid inbox wait selection or bounds");
  const deadline=AbortSignal.timeout(seconds*1000),signal=externalSignal?AbortSignal.any([deadline,externalSignal]):deadline;
  let cursor=after;
  while(!signal.aborted){
    let delay=interval;
    try{
      const query=new URLSearchParams({...from?{from}:{},...cursor?{after:cursor}:{}});
      const result=await client.request(`/inbox/updates?${query}`,undefined,undefined,undefined,signal);
      if(!Array.isArray(result.messages)||result.messages.length>50||!validCursor("inbox",result.cursor)||typeof result.hasMore!=="boolean"||
        result.messages.some(r=>!r||!ID.test(r.messageId)||!DID.test(r.sender)||from!==undefined&&r.sender!==from))
        throw new ClientError("RESPONSE_ERROR","Invalid inbox update page");
      cursor=result.cursor;
      if(result.messages.length)return {...result,contentTrust:"untrusted",wait:{completed:true,timedOut:false,interrupted:false}};
    }catch(error){
      if(signal.aborted)break;
      if(!(error instanceof AccountApiError)||![429,503].includes(error.status))throw error;
      delay=Math.max(interval,error.retryAfterSeconds??interval);
    }
    try{await sleep(delay*1000,undefined,{signal});}catch(error){if(!signal.aborted)throw error;}
  }
  return {messages:[],cursor:cursor??null,hasMore:false,wait:{completed:false,timedOut:deadline.aborted,interrupted:externalSignal?.aborted??false}};
}
