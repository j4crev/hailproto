import { HailCodecError } from "./errors.js";
import { assertHailValue } from "./cbor.js";
import { SIGNED_PROFILES, type HailKeyRole } from "./profiles.js";
import type {
  HailPayloadType,
  HailSignedPayloadType,
} from "./types.js";
import type { HailPayloadByType } from "./models.js";
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
    ["description"],
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
    ["category", "message_type"],
    "$",
  );
  uuid(payload.message_id, "$.message_id");
  did(payload.from, "$.from");
  did(payload.to, "$.to");
  const authorization = record(payload.authorization, "$.authorization");
  const authorizationType = text(authorization.type, "$.authorization.type");
  if (authorizationType === "grant") {
    exactKeys(authorization, ["type", "grant_id"], [], "$.authorization");
    uuid(authorization.grant_id, "$.authorization.grant_id");
  } else if (authorizationType === "reply") {
    exactKeys(authorization, ["type", "reply_to"], [], "$.authorization");
    uuid(authorization.reply_to, "$.authorization.reply_to");
    if (payload.category !== undefined) fail("must be absent for replies", "$.category");
  } else {
    fail("unknown authorization type", "$.authorization.type");
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
  if (text(body.profile, "$.body.profile") !== "spt-1") fail("unsupported body profile", "$.body.profile");
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

function validateBody(payload: HailRecord): void {
  exactKeys(payload, ["version", "profile", "blocks"], [], "$");
  if (payload.version !== 1) fail("must equal integer 1", "$.version");
  if (payload.profile !== "spt-1") fail("must equal spt-1", "$.profile");
  const blocks = array(payload.blocks, "$.blocks");
  blocks.forEach((entry, blockIndex) => {
    const path = `$.blocks[${blockIndex}]`;
    const block = record(entry, path);
    exactKeys(block, ["_type", "style", "children", "markDefs"], [], path);
    if (block._type !== "block" || block.style !== "normal") fail("unsupported text block", path);
    if (array(block.markDefs, `${path}.markDefs`).length !== 0) fail("must be empty in spt-1 POC", `${path}.markDefs`);
    const children = array(block.children, `${path}.children`);
    if (children.length === 0) fail("must contain at least one span", `${path}.children`);
    children.forEach((child, childIndex) => {
      const childPath = `${path}.children[${childIndex}]`;
      const span = record(child, childPath);
      exactKeys(span, ["_type", "text", "marks"], [], childPath);
      if (span._type !== "span") fail("must equal span", `${childPath}._type`);
      text(span.text, `${childPath}.text`);
      if (array(span.marks, `${childPath}.marks`).length !== 0) fail("must be empty in spt-1 POC", `${childPath}.marks`);
    });
  });
}

export function validatePayload<T extends HailPayloadType>(
  expectedType: T,
  value: unknown,
): asserts value is HailPayloadByType[T] {
  assertHailValue(value);
  const payload = record(value, "$");
  if (expectedType === "hail.body.spt-1") {
    validateBody(payload);
    return;
  }
  if (payload.type !== expectedType) fail(`must equal ${expectedType}`, "$.type");
  if (payload.version !== 1) fail("must equal integer 1", "$.version");

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
