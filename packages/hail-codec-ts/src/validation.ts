import { createHash } from "node:crypto";
import { HailCodecError } from "./errors.js";
import { assertHailValue } from "./cbor.js";
import { SIGNED_PROFILES, type HailKeyRole } from "./profiles.js";
import type {
  HailPayloadType,
  HailSignedPayloadType,
} from "./types.js";
import type { HailAssetManifest, HailPayloadByType } from "./models.js";
import { parse as parseDomain } from "tldts";
import { toASCII, toUnicode } from "tr46";

type HailRecord = Record<string, unknown>;

const DID_PATTERN = /^did:plc:[a-z2-7]{24}$/;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CATEGORY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const MESSAGE_TYPES = new Set([
  "personal",
  "newsletter",
  "promotion",
  "receipt",
  "invoice",
  "ticket",
  "boarding-pass",
  "account-alert",
  "security-alert",
  "package-update",
  "calendar-event",
]);
const DELIVERY_STATES = new Set([
  "accepted",
  "on-hold",
  "delivered",
  "failed",
  "cancelled",
]);
const HOLD_REASONS = new Set([
  "sender-unreachable",
  "body-temporarily-unavailable",
  "body-transfer-interrupted",
  "sender-rate-limited",
  "receiver-resource-constrained",
]);
const FAILURE_REASONS = new Set([
  "body-authorization-failed",
  "body-integrity-failed",
  "body-invalid",
  "body-unsupported",
  "delivery-expired",
  "receiver-policy-rejected",
]);
const CANCELLATION_REASONS = new Set([
  "recipient-cancelled",
  "receiver-administrative-cancellation",
]);
const LOCAL_PART_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function fail(message: string, path = "$."): never {
  throw new HailCodecError("schema-violation", message, path);
}

function record(value: unknown, path: string): HailRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Uint8Array
  ) {
    fail("must be a map", path);
  }
  return value as HailRecord;
}

function exactKeys(
  value: HailRecord,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("unknown member", `${path}.${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("required member is absent", `${path}.${key}`);
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string") fail("must be text", path);
  return value;
}

function integer(
  value: unknown,
  path: string,
  minimum = 0,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fail(`must be an integer greater than or equal to ${minimum}`, path);
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail("must be a boolean", path);
  return value;
}

function bytes(
  value: unknown,
  length: number,
  path: string,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    fail(`must be exactly ${length} bytes`, path);
  }
  return value;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail("must be an array", path);
  return value;
}

function did(value: unknown, path: string): string {
  const result = text(value, path);
  if (!DID_PATTERN.test(result)) fail("must be a canonical did:plc identifier", path);
  return result;
}

function uuid(value: unknown, path: string): string {
  const result = text(value, path);
  if (!UUID_V7_PATTERN.test(result)) fail("must be a canonical UUIDv7", path);
  return result;
}

function category(value: unknown, path: string): string {
  const result = text(value, path);
  if (!CATEGORY_PATTERN.test(result)) fail("must be a canonical category ID", path);
  return result;
}

function hailAddress(value: unknown, path: string): string {
  const address = text(value, path);
  const separator = address.lastIndexOf("@");
  const local = address.slice(0, separator);
  const domain = address.slice(separator + 1);
  if (
    address.length > 254 ||
    local.length > 63 ||
    !LOCAL_PART_PATTERN.test(local) ||
    domain.length === 0 ||
    domain.length > 253 ||
    !domain.includes(".") ||
    domain !== domain.toLowerCase() ||
    domain.split(".").some((label) => !DOMAIN_LABEL_PATTERN.test(label))
  ) {
    fail("must be a canonical ASCII Hail address", path);
  }
  const idnaOptions = {
    checkBidi: true,
    checkHyphens: true,
    checkJoiners: true,
    ignoreInvalidPunycode: false,
    transitionalProcessing: false,
    useSTD3ASCIIRules: true,
    verifyDNSLength: true,
  } as const;
  const unicodeDomain = toUnicode(domain, idnaOptions);
  const canonicalDomain = toASCII(domain, idnaOptions);
  if (unicodeDomain.error || canonicalDomain === null) {
    fail("must contain a valid IDNA domain", path);
  }
  if (canonicalDomain !== domain) {
    fail("domain must use its canonical ASCII IDNA form", path);
  }
  const parsedDomain = parseDomain(domain, {
    allowPrivateDomains: true,
    validateHostname: true,
  });
  if (
    parsedDomain.domain === null ||
    (!parsedDomain.isIcann && !parsedDomain.isPrivate)
  ) {
    fail("domain must end in a recognized public suffix", path);
  }
  return address;
}

function profileText(
  value: unknown,
  minimum: number,
  maximum: number,
  path: string,
): string {
  const result = text(value, path);
  const size = new TextEncoder().encode(result).length;
  if (
    size < minimum ||
    size > maximum ||
    result.normalize("NFC") !== result ||
    CONTROL_OR_FORMAT.test(result)
  ) {
    fail(`must be NFC plain text from ${minimum} through ${maximum} UTF-8 bytes`, path);
  }
  return result;
}

function digest(value: unknown, path: string): void {
  const item = record(value, path);
  exactKeys(item, ["algorithm", "value"], [], path);
  if (text(item.algorithm, `${path}.algorithm`) !== "sha-256") {
    fail("must equal sha-256", `${path}.algorithm`);
  }
  bytes(item.value, 32, `${path}.value`);
}

function keyId(value: unknown, signer: string, role: HailKeyRole, path: string): void {
  if (text(value, path) !== `${signer}#${role}`) {
    fail(`must identify the signer's #${role} key`, path);
  }
}

function validateAddressBinding(payload: HailRecord): void {
  exactKeys(
    payload,
    ["version", "type", "address", "did", "issued_at", "expires_at", "key_id"],
    [],
    "$",
  );
  const signer = did(payload.did, "$.did");
  hailAddress(payload.address, "$.address");
  const issuedAt = integer(payload.issued_at, "$.issued_at");
  const expiresAt = integer(payload.expires_at, "$.expires_at");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 7_776_000) {
    fail("must be after issued_at and no more than 90 days later", "$.expires_at");
  }
  keyId(payload.key_id, signer, "hail-identity", "$.key_id");
}

function validateSenderProfile(payload: HailRecord): void {
  const version = integer(payload.version, "$.version", 1);
  if (version !== 1 && version !== 2) fail("must equal integer 1 or 2", "$.version");
  exactKeys(
    payload,
    [
      "type",
      "version",
      "did",
      "revision",
      "display_name",
      "offers_uncategorized",
      "categories",
      "updated_at",
      "key_id",
    ],
    version === 1 ? ["description"] : ["description", "assets"],
    "$",
  );
  const signer = did(payload.did, "$.did");
  integer(payload.revision, "$.revision", 1);
  profileText(payload.display_name, 1, 128, "$.display_name");
  if (payload.description !== undefined) {
    profileText(payload.description, 1, 1_024, "$.description");
  }
  boolean(payload.offers_uncategorized, "$.offers_uncategorized");
  const categories = array(payload.categories, "$.categories");
  if (categories.length > 100) fail("must contain at most 100 entries", "$.categories");
  let previous = "";
  categories.forEach((entry, index) => {
    const path = `$.categories[${index}]`;
    const item = record(entry, path);
    exactKeys(item, ["id", "label"], ["description"], path);
    const id = category(item.id, `${path}.id`);
    if (id <= previous) fail("IDs must be unique and bytewise ascending", `${path}.id`);
    previous = id;
    profileText(item.label, 1, 128, `${path}.label`);
    if (item.description !== undefined) {
      profileText(item.description, 1, 1_024, `${path}.description`);
    }
  });
  if (version === 2 && payload.assets !== undefined) {
    validateAssetManifest(payload.assets);
    const assets = record(payload.assets, "$.assets").assets as HailRecord[];
    if (assets.length !== 1 || assets[0]?.role !== "avatar") {
      fail("must contain exactly one avatar asset", "$.assets");
    }
  }
  integer(payload.updated_at, "$.updated_at");
  keyId(payload.key_id, signer, "hail-messaging", "$.key_id");
}

function validateGrant(payload: HailRecord): void {
  exactKeys(
    payload,
    [
      "type",
      "version",
      "grant_id",
      "revision",
      "previous",
      "grantor",
      "grantee",
      "scope",
      "status",
      "issued_at",
      "updated_at",
      "expires_at",
      "consent_context",
      "key_id",
    ],
    [],
    "$",
  );
  uuid(payload.grant_id, "$.grant_id");
  const revision = integer(payload.revision, "$.revision", 1);
  if (revision === 1 ? payload.previous !== null : !(payload.previous instanceof Uint8Array)) {
    fail("must be null for revision 1 and a digest for later revisions", "$.previous");
  }
  if (revision > 1) bytes(payload.previous, 32, "$.previous");
  const signer = did(payload.grantor, "$.grantor");
  did(payload.grantee, "$.grantee");
  const scope = array(payload.scope, "$.scope");
  if (scope.length !== 1) fail("must contain exactly one selector", "$.scope");
  const selector = record(scope[0], "$.scope[0]");
  const selectorType = text(selector.type, "$.scope[0].type");
  if (selectorType === "categories") {
    exactKeys(selector, ["type", "values"], [], "$.scope[0]");
    const values = array(selector.values, "$.scope[0].values");
    if (values.length === 0) fail("must not be empty", "$.scope[0].values");
    let previous = "";
    values.forEach((entry, index) => {
      const current = category(entry, `$.scope[0].values[${index}]`);
      if (current <= previous) fail("must be unique and bytewise ascending", `$.scope[0].values[${index}]`);
      previous = current;
    });
  } else if (selectorType === "uncategorized") {
    exactKeys(selector, ["type"], [], "$.scope[0]");
  } else {
    fail("unknown scope selector", "$.scope[0].type");
  }
  const status = text(payload.status, "$.status");
  if (status !== "active" && status !== "revoked") fail("unknown grant status", "$.status");
  const issuedAt = integer(payload.issued_at, "$.issued_at");
  const updatedAt = integer(payload.updated_at, "$.updated_at");
  if (updatedAt < issuedAt) fail("must not precede issued_at", "$.updated_at");
  if (payload.expires_at !== null) integer(payload.expires_at, "$.expires_at");
  const consent = record(payload.consent_context, "$.consent_context");
  exactKeys(
    consent,
    ["grantee_address", "address_binding_hash", "sender_profile_hash"],
    [],
    "$.consent_context",
  );
  hailAddress(consent.grantee_address, "$.consent_context.grantee_address");
  digest(consent.address_binding_hash, "$.consent_context.address_binding_hash");
  digest(consent.sender_profile_hash, "$.consent_context.sender_profile_hash");
  keyId(payload.key_id, signer, "hail-identity", "$.key_id");
}

function connectionExpiry(payload:HailRecord,confirmation=false):void {
  const issued=integer(payload.issued_at,"$.issued_at");
  if(payload.expires_at!==null){const until=integer(payload.expires_at,"$.expires_at");
    if(until<=issued||confirmation&&until-issued>300)fail("invalid connection validity window","$.expires_at");
  }else if(confirmation)fail("confirmation must expire","$.expires_at");
}

function validateConnectionInvitation(payload:HailRecord):void {
  exactKeys(payload,["type","version","invitation_id","from","token_hash","issued_at","expires_at","key_id"],[],"$");
  uuid(payload.invitation_id,"$.invitation_id");
  const owner=did(payload.from,"$.from");digest(payload.token_hash,"$.token_hash");
  connectionExpiry(payload);keyId(payload.key_id,owner,"hail-identity","$.key_id");
}

function validateConnectionConfirmation(payload:HailRecord):void {
  exactKeys(payload,["type","version","confirmation_id","from","to","invitation_id","invitation_hash","issued_at","expires_at","key_id"],[],"$");
  uuid(payload.confirmation_id,"$.confirmation_id");uuid(payload.invitation_id,"$.invitation_id");
  const actor=did(payload.from,"$.from");did(payload.to,"$.to");
  if(payload.from===payload.to)fail("cannot connect to self","$.to");
  digest(payload.invitation_hash,"$.invitation_hash");connectionExpiry(payload,true);
  keyId(payload.key_id,actor,"hail-identity","$.key_id");
}

function validateConnectionControl(payload:HailRecord):void {
  exactKeys(payload,["type","version","operation","from","to","request_id","connection_id","epoch","state","proof_hash","issued_at","expires_at","key_id"],[],"$");
  const actor=did(payload.from,"$.from");did(payload.to,"$.to");
  if(payload.from===payload.to)fail("distinct parties required","$.to");
  uuid(payload.request_id,"$.request_id");integer(payload.epoch,"$.epoch");
  if(!["probe","offer","connect","disconnect","snapshot","admission","ack"].includes(String(payload.operation)))fail("unknown operation","$.operation");
  if(!["empty","active","disconnected"].includes(String(payload.state)))fail("unknown state","$.state");
  if(payload.state==="empty"){
    if(payload.connection_id!==null||payload.epoch!==0)fail("empty pair has no epoch","$.connection_id");
  }else{uuid(payload.connection_id,"$.connection_id");integer(payload.epoch,"$.epoch",1);}
  digest(payload.proof_hash,"$.proof_hash");
  const receipt=["snapshot","admission","ack"].includes(String(payload.operation));
  integer(payload.issued_at,"$.issued_at");
  if(receipt){if(payload.expires_at!==null)fail("durable receipts do not expire","$.expires_at");}
  else connectionExpiry(payload,true);
  keyId(payload.key_id,actor,"hail-messaging","$.key_id");
}

function validateConnectionGrant(payload:HailRecord):void {
  exactKeys(payload,["type","version","grant_id","connection_id","revision","previous","grantor","grantee","status","issued_at","updated_at","expires_at","consent_context","key_id"],[],"$");
  uuid(payload.grant_id,"$.grant_id");uuid(payload.connection_id,"$.connection_id");
  const revision=integer(payload.revision,"$.revision",1);
  if(revision===1){if(payload.previous!==null)fail("initial revision has no predecessor","$.previous");}
  else bytes(payload.previous,32,"$.previous");
  const owner=did(payload.grantor,"$.grantor");did(payload.grantee,"$.grantee");
  if(payload.grantor===payload.grantee)fail("cannot connect to self","$.grantee");
  if(payload.status!=="active"&&payload.status!=="revoked")fail("unknown connection grant status","$.status");
  connectionExpiry(payload);
  if(integer(payload.updated_at,"$.updated_at")<Number(payload.issued_at))fail("must not precede issued_at","$.updated_at");
  const consent=record(payload.consent_context,"$.consent_context");
  exactKeys(consent,["grantee_address","address_binding_hash","invitation_hash","confirmation_hash"],[],"$.consent_context");
  hailAddress(consent.grantee_address,"$.consent_context.grantee_address");
  for(const field of ["address_binding_hash","invitation_hash","confirmation_hash"])digest(consent[field],`$.consent_context.${field}`);
  keyId(payload.key_id,owner,"hail-identity","$.key_id");
}

function validateEnvelope(payload: HailRecord): void {
  exactKeys(
    payload,
    [
      "type",
      "version",
      "message_id",
      "from",
      "to",
      "authorization",
      "created_at",
      "expires_at",
      "body",
      "reply",
    ],
    payload.version === 3 ? ["category", "message_type", "in_reply_to"] : ["category", "message_type"],
    "$",
  );
  uuid(payload.message_id, "$.message_id");
  did(payload.from, "$.from");
  did(payload.to, "$.to");
  const authorization = record(payload.authorization, "$.authorization");
  const authorizationType = text(authorization.type, "$.authorization.type");
  if (authorizationType === "grant") {
    if(payload.version!==1)fail("subscription authorization uses envelope version 1","$.version");
    exactKeys(authorization, ["type", "grant_id"], [], "$.authorization");
    uuid(authorization.grant_id, "$.authorization.grant_id");
  } else if (authorizationType === "reply") {
    if(payload.version!==1&&payload.version!==3)fail("reply authorization uses envelope version 1 or 3","$.version");
    exactKeys(authorization, ["type", "reply_to"], [], "$.authorization");
    uuid(authorization.reply_to, "$.authorization.reply_to");
    if (payload.category !== undefined) fail("must be absent for replies", "$.category");
  } else if(authorizationType==="connection"){
    if(payload.version!==2&&payload.version!==3)fail("connection authorization requires envelope version 2 or 3","$.version");
    exactKeys(authorization,["type","connection_id","epoch"],[],"$.authorization");
    uuid(authorization.connection_id,"$.authorization.connection_id");integer(authorization.epoch,"$.authorization.epoch",1);
    if(payload.category!==undefined)fail("connections do not use subscription categories","$.category");
  } else {
    fail("unknown authorization type", "$.authorization.type");
  }
  if (payload.version === 3) {
    const parent = record(payload.in_reply_to, "$.in_reply_to");
    exactKeys(parent, ["sender", "message_id"], [], "$.in_reply_to");
    did(parent.sender, "$.in_reply_to.sender");
    uuid(parent.message_id, "$.in_reply_to.message_id");
    if (parent.sender !== payload.to || payload.from === payload.to) fail("parent must be sent by the other participant", "$.in_reply_to.sender");
    if (authorizationType === "reply" && parent.message_id !== authorization.reply_to) fail("parent must match reply authorization", "$.in_reply_to.message_id");
  }
  if (payload.category !== undefined) category(payload.category, "$.category");
  if (payload.message_type !== undefined && !MESSAGE_TYPES.has(text(payload.message_type, "$.message_type"))) {
    fail("unknown message type", "$.message_type");
  }
  const createdAt = integer(payload.created_at, "$.created_at");
  const expiresAt = integer(payload.expires_at, "$.expires_at");
  if (expiresAt <= createdAt || expiresAt - createdAt > 604_800) {
    fail("must be after created_at and no more than seven days later", "$.expires_at");
  }
  const body = record(payload.body, "$.body");
  exactKeys(
    body,
    ["digest", "size", "media_type", "profile", "available_until", "access"],
    [],
    "$.body",
  );
  digest(body.digest, "$.body.digest");
  const size = integer(body.size, "$.body.size", 1);
  if (size > 262_144) fail("must not exceed 262144 octets", "$.body.size");
  if (text(body.media_type, "$.body.media_type") !== "application/hail-body+cbor") {
    fail("unsupported body media type", "$.body.media_type");
  }
  if (!["spt-1", "spt-2", "spt-3"].includes(text(body.profile, "$.body.profile"))) fail("unsupported body profile", "$.body.profile");
  const availableUntil = integer(body.available_until, "$.body.available_until");
  if (availableUntil < createdAt + 2_592_000 || availableUntil < expiresAt + 300) {
    fail("does not satisfy the required availability window", "$.body.available_until");
  }
  const access = record(body.access, "$.body.access");
  exactKeys(access, ["type", "token", "expires_at"], [], "$.body.access");
  if (text(access.type, "$.body.access.type") !== "bearer") fail("must equal bearer", "$.body.access.type");
  bytes(access.token, 32, "$.body.access.token");
  if (integer(access.expires_at, "$.body.access.expires_at") < availableUntil) {
    fail("must not precede available_until", "$.body.access.expires_at");
  }
  const reply = record(payload.reply, "$.reply");
  const allowed = boolean(reply.allowed, "$.reply.allowed");
  if(authorizationType==="connection"&&allowed)fail("connection messages do not issue independent reply capabilities","$.reply.allowed");
  exactKeys(reply, ["allowed", ...(allowed ? ["until"] : [])], [], "$.reply");
  if (allowed && integer(reply.until, "$.reply.until") <= createdAt) {
    fail("must be after created_at", "$.reply.until");
  }
}

function validateDeliveryStatus(payload: HailRecord): void {
  exactKeys(
    payload,
    ["type", "version", "message_id", "envelope_digest", "from", "to", "revision", "state", "occurred_at"],
    ["reason", "retry_at"],
    "$",
  );
  uuid(payload.message_id, "$.message_id");
  digest(payload.envelope_digest, "$.envelope_digest");
  did(payload.from, "$.from");
  did(payload.to, "$.to");
  const revision = integer(payload.revision, "$.revision", 1);
  const state = text(payload.state, "$.state");
  if (!DELIVERY_STATES.has(state)) fail("unknown delivery state", "$.state");
  if ((revision === 1) !== (state === "accepted")) {
    fail("accepted is required exactly for revision 1", "$.state");
  }
  const needsReason = state === "on-hold" || state === "failed" || state === "cancelled";
  if (needsReason !== (payload.reason !== undefined)) {
    fail(needsReason ? "is required for this state" : "is prohibited for this state", "$.reason");
  }
  if (payload.reason !== undefined) {
    const reason = text(payload.reason, "$.reason");
    const allowed =
      state === "on-hold"
        ? HOLD_REASONS
        : state === "failed"
          ? FAILURE_REASONS
          : CANCELLATION_REASONS;
    if (!allowed.has(reason)) fail("reason is not valid for this state", "$.reason");
  }
  const occurredAt = integer(payload.occurred_at, "$.occurred_at");
  if (state === "on-hold") {
    if (payload.retry_at === undefined) fail("is required for on-hold", "$.retry_at");
    if (integer(payload.retry_at, "$.retry_at") < occurredAt) fail("must not precede occurred_at", "$.retry_at");
  } else if (payload.retry_at !== undefined) {
    fail("is prohibited for this state", "$.retry_at");
  }
}

function validateSpt1Body(payload: HailRecord): void {
  exactKeys(payload, ["version", "profile", "blocks"], [], "$");
  if (payload.version !== 1) fail("must equal integer 1", "$.version");
  if (payload.profile !== "spt-1") fail("must equal spt-1", "$.profile");
  array(payload.blocks, "$.blocks").forEach((entry, blockIndex) => {
    const path = `$.blocks[${blockIndex}]`, block = record(entry, path);
    exactKeys(block, ["_type", "style", "children", "markDefs"], [], path);
    if (block._type !== "block" || block.style !== "normal") fail("unsupported text block", path);
    if (array(block.markDefs, `${path}.markDefs`).length !== 0) fail("must be empty in spt-1", `${path}.markDefs`);
    const children = array(block.children, `${path}.children`);
    if (children.length === 0) fail("must contain at least one span", `${path}.children`);
    children.forEach((child, childIndex) => {
      const childPath = `${path}.children[${childIndex}]`, span = record(child, childPath);
      exactKeys(span, ["_type", "text", "marks"], [], childPath);
      if (span._type !== "span") fail("must equal span", `${childPath}._type`);
      text(span.text, `${childPath}.text`);
      if (array(span.marks, `${childPath}.marks`).length !== 0) fail("must be empty in spt-1", `${childPath}.marks`);
    });
  });
}

function validateSpt2Body(payload: HailRecord): void {
  exactKeys(payload, ["version", "profile", "blocks"], [], "$");
  if (payload.version !== 1) fail("must equal integer 1", "$.version");
  if (payload.profile !== "spt-2") fail("must equal spt-2", "$.profile");
  const blocks = array(payload.blocks, "$.blocks");
  blocks.forEach((entry, blockIndex) => {
    const path = `$.blocks[${blockIndex}]`;
    const block = record(entry, path);
    exactKeys(block, ["_type", "style", "children", "markDefs"], ["listItem", "level"], path);
    if (block._type !== "block" || !["normal", "h1", "h2", "h3", "blockquote", "caption"].includes(block.style as string)) fail("unsupported text block", path);
    if (block.listItem !== undefined && !["bullet", "number"].includes(block.listItem as string)) fail("unsupported list type", `${path}.listItem`);
    if (block.level !== undefined && (block.listItem === undefined || ![1, 2, 3].includes(integer(block.level, `${path}.level`, 1)))) fail("invalid list level", `${path}.level`);
    const definitionKeys = new Set<string>();
    array(block.markDefs, `${path}.markDefs`).forEach((entry, definitionIndex) => {
      const definitionPath = `${path}.markDefs[${definitionIndex}]`;
      const definition = record(entry, definitionPath);
      exactKeys(definition, ["_key", "_type", "href"], ["title"], definitionPath);
      const key = text(definition._key, `${definitionPath}._key`);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(key) || ["strong", "em", "code"].includes(key) || definitionKeys.has(key)) fail("invalid or duplicate mark key", `${definitionPath}._key`);
      definitionKeys.add(key);
      if (definition._type !== "spt.link") fail("unsupported mark definition", `${definitionPath}._type`);
      const href = text(definition.href, `${definitionPath}.href`);
      let url: URL;
      try { url = new URL(href); } catch { fail("must be an absolute HTTPS URL", `${definitionPath}.href`); }
      if (!href.startsWith("https://")||url.protocol !== "https:" || url.username || url.password) fail("must be an HTTPS URL without credentials", `${definitionPath}.href`);
      if (definition.title !== undefined) text(definition.title, `${definitionPath}.title`);
    });
    const children = array(block.children, `${path}.children`);
    if (children.length === 0) fail("must contain at least one span", `${path}.children`);
    children.forEach((child, childIndex) => {
      const childPath = `${path}.children[${childIndex}]`;
      const span = record(child, childPath);
      exactKeys(span, ["_type", "text", "marks"], [], childPath);
      if (span._type !== "span") fail("must equal span", `${childPath}._type`);
      text(span.text, `${childPath}.text`);
      const marks = array(span.marks, `${childPath}.marks`).map((mark, markIndex) => text(mark, `${childPath}.marks[${markIndex}]`));
      if (new Set(marks).size !== marks.length || marks.some(mark => !["strong", "em", "code"].includes(mark) && !definitionKeys.has(mark)) ||
        marks.filter(mark => definitionKeys.has(mark)).length > 1) fail("invalid, duplicate, or conflicting span mark", `${childPath}.marks`);
    });
  });
}

function pngDimensions(data: Uint8Array, path: string): { width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (data.length < 45 || signature.some((byte, index) => data[index] !== byte)) fail("must be a PNG image", path);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 8, width = 0, height = 0, sawHeader = false, sawData = false, sawEnd = false,sawPalette=false,dataEnded=false;
  const crc32=(start:number,end:number)=>{let crc=0xffffffff;for(let index=start;index<end;index++){
    crc^=data[index]!;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;};
  while (offset + 12 <= data.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > data.length) fail("contains a truncated PNG chunk", path);
    const type = String.fromCharCode(data[offset + 4]!, data[offset + 5]!, data[offset + 6]!, data[offset + 7]!);
    if(view.getUint32(offset+8+length)!==crc32(offset+4,offset+8+length))fail("contains an invalid PNG chunk CRC",path);
    if (!sawHeader && type !== "IHDR") fail("must begin with a PNG IHDR chunk", path);
    if (type === "IHDR") {
      if (sawHeader || length !== 13) fail("contains an invalid PNG IHDR chunk", path);
      sawHeader = true;
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const depth=data[offset+16]!,color=data[offset+17]!,valid:Record<number,number[]>={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
      if(!valid[color]?.includes(depth)||data[offset+18]!==0||data[offset+19]!==0||![0,1].includes(data[offset+20]!))
        fail("contains an invalid PNG IHDR profile",path);
    } else if (type === "acTL") fail("animated PNG is unsupported", path);
    else if(type==="PLTE"){
      if(sawData||sawPalette||length===0||length%3!==0||length>768)fail("contains an invalid PNG palette",path);sawPalette=true;
    }
    else if (type === "IDAT") {if(dataEnded)fail("contains nonconsecutive PNG image data",path);sawData = true;}
    else if (type === "IEND") {
      if (length !== 0 || end !== data.length) fail("contains an invalid PNG IEND chunk", path);
      sawEnd = true;
      break;
    }else {if(sawData)dataEnded=true;if(type.charCodeAt(0)>=65&&type.charCodeAt(0)<=90)fail("contains an unsupported critical PNG chunk",path);}
    offset = end;
  }
  const color=data[25];
  if (!sawHeader || !sawData || !sawEnd || width === 0 || height === 0||color===3&&!sawPalette||[0,4].includes(color!)&&sawPalette)
    fail("must be a complete PNG image", path);
  return { width, height };
}

export function validateAssetManifest(value: unknown): asserts value is HailAssetManifest {
  assertHailValue(value);
  const manifest = record(value, "$");
  exactKeys(manifest, ["version", "assets"], [], "$");
  if (manifest.version !== 1) fail("must equal integer 1", "$.version");
  const assets = array(manifest.assets, "$.assets");
  if (assets.length < 1 || assets.length > 2) fail("must contain one or two assets", "$.assets");
  const ids = new Set<string>(), roles = new Set<string>();
  assets.forEach((entry, index) => {
    const path = `$.assets[${index}]`, asset = record(entry, path);
    exactKeys(asset, ["id", "role", "media_type", "loading", "size", "digest", "width", "height", "data"], [], path);
    const id = text(asset.id, `${path}.id`), role = text(asset.role, `${path}.role`);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || ids.has(id)) fail("must be a unique canonical asset ID", `${path}.id`);
    if (!["avatar", "header"].includes(role) || roles.has(role)) fail("must be a unique supported asset role", `${path}.role`);
    ids.add(id); roles.add(role);
    if (asset.media_type !== "image/png") fail("must equal image/png", `${path}.media_type`);
    if (asset.loading !== "bundled") fail("must equal bundled", `${path}.loading`);
    if (!(asset.data instanceof Uint8Array)) fail("must be a byte string", `${path}.data`);
    const maximum = role === "avatar" ? { bytes: 32_768, width: 512, height: 512, pixels: 262_144 } :
      { bytes: 196_608, width: 2_400, height: 1_200, pixels: 2_000_000 };
    const size = integer(asset.size, `${path}.size`, 1);
    if (size !== asset.data.length || size > maximum.bytes) fail("does not match the bounded asset bytes", `${path}.size`);
    digest(asset.digest, `${path}.digest`);
    const expected = bytes(record(asset.digest, `${path}.digest`).value, 32, `${path}.digest.value`);
    const actual = createHash("sha256").update(asset.data).digest();
    if (!actual.every((byte, byteIndex) => byte === expected[byteIndex])) fail("does not match the asset bytes", `${path}.digest.value`);
    const dimensions = pngDimensions(asset.data, `${path}.data`);
    const width = integer(asset.width, `${path}.width`, 1), height = integer(asset.height, `${path}.height`, 1);
    if (width !== dimensions.width || height !== dimensions.height || width > maximum.width || height > maximum.height || width * height > maximum.pixels) {
      fail("does not match bounded PNG dimensions", `${path}.width`);
    }
  });
}

function validateSpt3Body(payload: HailRecord): void {
  exactKeys(payload, ["version", "profile", "assets", "blocks"], [], "$");
  if (payload.version !== 1) fail("must equal integer 1", "$.version");
  if (payload.profile !== "spt-3") fail("must equal spt-3", "$.profile");
  validateAssetManifest(payload.assets);
  const assets = (record(payload.assets, "$.assets").assets as HailRecord[]);
  if (assets.length !== 1 || assets[0]?.role !== "header") fail("must contain exactly one header asset", "$.assets");
  const blocks = array(payload.blocks, "$.blocks");
  if (blocks.length === 0) fail("must begin with an image block", "$.blocks");
  const image = record(blocks[0], "$.blocks[0]");
  exactKeys(image, ["_type", "asset", "alt"], ["caption"], "$.blocks[0]");
  if (image._type !== "spt.image") fail("must equal spt.image", "$.blocks[0]._type");
  if (text(image.asset, "$.blocks[0].asset") !== assets[0]!.id) fail("must reference the header asset", "$.blocks[0].asset");
  profileText(image.alt, 1, 1024, "$.blocks[0].alt");
  if (image.caption !== undefined) profileText(image.caption, 1, 1024, "$.blocks[0].caption");
  validateSpt2Body({ version: 1, profile: "spt-2", blocks: blocks.slice(1) });
}

export function validatePayload<T extends HailPayloadType>(
  expectedType: T,
  value: unknown,
): asserts value is HailPayloadByType[T] {
  assertHailValue(value);
  const payload = record(value, "$");
  if (expectedType === "hail.body.spt-1") {
    validateSpt1Body(payload);
    return;
  }
  if (expectedType === "hail.body.spt-2") {
    validateSpt2Body(payload);
    return;
  }
  if (expectedType === "hail.body.spt-3") {
    validateSpt3Body(payload);
    return;
  }
  if (payload.type !== expectedType) fail(`must equal ${expectedType}`, "$.type");
  if (expectedType !== "hail.sender-profile" && !(expectedType==="hail.envelope"&&(payload.version===2||payload.version===3)) && payload.version !== 1) fail("must equal integer 1", "$.version");

  switch (expectedType) {
    case "hail.address-binding":
      validateAddressBinding(payload);
      break;
    case "hail.sender-profile":
      validateSenderProfile(payload);
      break;
    case "hail.grant":
      validateGrant(payload);
      break;
    case "hail.connection-invitation":
      validateConnectionInvitation(payload);break;
    case "hail.connection-confirmation":
      validateConnectionConfirmation(payload);break;
    case "hail.connection-grant":
      validateConnectionGrant(payload);break;
    case "hail.connection-control":
      validateConnectionControl(payload);break;
    case "hail.envelope":
      validateEnvelope(payload);
      break;
    case "hail.delivery-status":
      validateDeliveryStatus(payload);
      break;
  }
}

export function expectedKeyId(type: HailSignedPayloadType, value: unknown): string {
  const payload = record(value, "$");
  const profile = SIGNED_PROFILES[type];
  const signer = did(payload[profile.signerField], `$.${profile.signerField}`);
  return `${signer}#${profile.keyRole}`;
}
