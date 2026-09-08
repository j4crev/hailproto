import { readFileSync } from "node:fs";

import { CDDL } from "@cbortech/cbor/cddl";
import { encode, rfc8949EncodeOptions } from "cborg";
import { describe, expect, it } from "vitest";

import {
  decodePayload,
  HailCodecError,
  SIGNED_PROFILES,
  type DiagnosticJson,
  type HailAddressBinding,
  type HailBodyDescriptor,
  type HailConsentContext,
  type HailDeliveryReason,
  type HailDeliveryState,
  type HailDeliveryStatus,
  type HailDigest,
  type HailEnvelope,
  type HailEnvelopeAuthorization,
  type HailGrant,
  type HailGrantScope,
  type HailMessageType,
  type HailPayloadType,
  type HailReplyPermission,
  type HailSenderCategory,
  type HailSenderProfile,
  type HailSptBody,
  type HailSptSpan,
  type HailSptTextBlock,
  type HailValue,
} from "../src/index.js";

type Equivalent<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;

type ExpectedDigest = { algorithm: "sha-256"; value: Uint8Array };
type ExpectedAddressBinding = {
  version: 1;
  type: "hail.address-binding";
  address: string;
  did: string;
  issued_at: number;
  expires_at: number;
  key_id: string;
};
type ExpectedSenderCategory = { id: string; label: string; description?: string };
type ExpectedSenderProfile = {
  type: "hail.sender-profile";
  version: 1;
  did: string;
  revision: number;
  display_name: string;
  description?: string;
  offers_uncategorized: boolean;
  categories: ExpectedSenderCategory[];
  updated_at: number;
  key_id: string;
};
type ExpectedGrantScope =
  | { type: "categories"; values: string[] }
  | { type: "uncategorized" };
type ExpectedConsentContext = {
  grantee_address: string;
  address_binding_hash: ExpectedDigest;
  sender_profile_hash: ExpectedDigest;
};
type ExpectedGrant = {
  type: "hail.grant";
  version: 1;
  grant_id: string;
  revision: number;
  previous: null | Uint8Array;
  grantor: string;
  grantee: string;
  scope: [ExpectedGrantScope];
  status: "active" | "revoked";
  issued_at: number;
  updated_at: number;
  expires_at: null | number;
  consent_context: ExpectedConsentContext;
  key_id: string;
};
type ExpectedMessageType =
  | "personal"
  | "newsletter"
  | "promotion"
  | "receipt"
  | "invoice"
  | "ticket"
  | "boarding-pass"
  | "account-alert"
  | "security-alert"
  | "package-update"
  | "calendar-event";
type ExpectedAuthorization =
  | { type: "grant"; grant_id: string }
  | { type: "reply"; reply_to: string };
type ExpectedBodyDescriptor = {
  digest: ExpectedDigest;
  size: number;
  media_type: "application/hail-body+cbor";
  profile: "spt-1";
  available_until: number;
  access: { type: "bearer"; token: Uint8Array; expires_at: number };
};
type ExpectedReply = { allowed: false } | { allowed: true; until: number };
type ExpectedEnvelope = {
  type: "hail.envelope";
  version: 1;
  message_id: string;
  from: string;
  to: string;
  authorization: ExpectedAuthorization;
  category?: string;
  message_type?: ExpectedMessageType;
  created_at: number;
  expires_at: number;
  body: ExpectedBodyDescriptor;
  reply: ExpectedReply;
};
type ExpectedDeliveryState =
  | "accepted"
  | "on-hold"
  | "delivered"
  | "failed"
  | "cancelled";
type ExpectedDeliveryReason =
  | "sender-unreachable"
  | "body-temporarily-unavailable"
  | "body-transfer-interrupted"
  | "sender-rate-limited"
  | "receiver-resource-constrained"
  | "body-authorization-failed"
  | "body-integrity-failed"
  | "body-invalid"
  | "body-unsupported"
  | "delivery-expired"
  | "receiver-policy-rejected"
  | "recipient-cancelled"
  | "receiver-administrative-cancellation";
type ExpectedDeliveryStatus = {
  type: "hail.delivery-status";
  version: 1;
  message_id: string;
  envelope_digest: ExpectedDigest;
  from: string;
  to: string;
  revision: number;
  state: ExpectedDeliveryState;
  reason?: ExpectedDeliveryReason;
  retry_at?: number;
  occurred_at: number;
};
type ExpectedSpan = { _type: "span"; text: string; marks: [] };
type ExpectedBlock = {
  _type: "block";
  style: "normal";
  children: [ExpectedSpan, ...ExpectedSpan[]];
  markDefs: [];
};
type ExpectedBody = { version: 1; profile: "spt-1"; blocks: ExpectedBlock[] };

type ModelAssertions = [
  Assert<Equivalent<HailDigest, ExpectedDigest>>,
  Assert<Equivalent<HailAddressBinding, ExpectedAddressBinding>>,
  Assert<Equivalent<HailSenderCategory, ExpectedSenderCategory>>,
  Assert<Equivalent<HailSenderProfile, ExpectedSenderProfile>>,
  Assert<Equivalent<HailGrantScope, ExpectedGrantScope>>,
  Assert<Equivalent<HailConsentContext, ExpectedConsentContext>>,
  Assert<Equivalent<HailGrant, ExpectedGrant>>,
  Assert<Equivalent<HailMessageType, ExpectedMessageType>>,
  Assert<Equivalent<HailEnvelopeAuthorization, ExpectedAuthorization>>,
  Assert<Equivalent<HailBodyDescriptor, ExpectedBodyDescriptor>>,
  Assert<Equivalent<HailReplyPermission, ExpectedReply>>,
  Assert<Equivalent<HailEnvelope, ExpectedEnvelope>>,
  Assert<Equivalent<HailDeliveryState, ExpectedDeliveryState>>,
  Assert<Equivalent<HailDeliveryReason, ExpectedDeliveryReason>>,
  Assert<Equivalent<HailDeliveryStatus, ExpectedDeliveryStatus>>,
  Assert<Equivalent<HailSptSpan, ExpectedSpan>>,
  Assert<Equivalent<HailSptTextBlock, ExpectedBlock>>,
  Assert<Equivalent<HailSptBody, ExpectedBody>>,
];

const NESTED_MAPS: ReadonlyArray<{
  readonly type: HailPayloadType;
  readonly path: readonly (string | number)[];
  readonly required: readonly string[];
}> = [
  { type: "hail.sender-profile", path: ["categories", 0], required: ["id", "label"] },
  { type: "hail.grant", path: ["scope", 0], required: ["type", "values"] },
  {
    type: "hail.grant",
    path: ["consent_context"],
    required: ["grantee_address", "address_binding_hash", "sender_profile_hash"],
  },
  {
    type: "hail.grant",
    path: ["consent_context", "address_binding_hash"],
    required: ["algorithm", "value"],
  },
  { type: "hail.envelope", path: ["authorization"], required: ["type", "grant_id"] },
  {
    type: "hail.envelope",
    path: ["body"],
    required: ["digest", "size", "media_type", "profile", "available_until", "access"],
  },
  { type: "hail.envelope", path: ["body", "digest"], required: ["algorithm", "value"] },
  {
    type: "hail.envelope",
    path: ["body", "access"],
    required: ["type", "token", "expires_at"],
  },
  { type: "hail.envelope", path: ["reply"], required: ["allowed"] },
  {
    type: "hail.delivery-status",
    path: ["envelope_digest"],
    required: ["algorithm", "value"],
  },
  {
    type: "hail.body.spt-1",
    path: ["blocks", 0],
    required: ["_type", "style", "children", "markDefs"],
  },
  {
    type: "hail.body.spt-1",
    path: ["blocks", 0, "children", 0],
    required: ["_type", "text", "marks"],
  },
];

interface PositiveVector {
  readonly id: string;
  readonly type: HailPayloadType;
  readonly diagnostic: DiagnosticJson;
  readonly payload_hex: string;
}

interface NegativePayloadVector {
  readonly id: string;
  readonly type: HailPayloadType;
  readonly hex: string;
}

interface VectorManifest {
  readonly positive: readonly PositiveVector[];
  readonly negative_payload: readonly NegativePayloadVector[];
}

const CDDL_RULES = {
  "hail.address-binding": "hail-address-binding",
  "hail.sender-profile": "hail-sender-profile",
  "hail.grant": "hail-grant",
  "hail.envelope": "hail-envelope",
  "hail.delivery-status": "hail-delivery-status",
  "hail.body.spt-1": "hail-body-spt-1",
} as const satisfies Readonly<Record<HailPayloadType, string>>;

const REQUIRED_KEYS = {
  "hail.address-binding": [
    "version",
    "type",
    "address",
    "did",
    "issued_at",
    "expires_at",
    "key_id",
  ],
  "hail.sender-profile": [
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
  "hail.grant": [
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
  "hail.envelope": [
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
  "hail.delivery-status": [
    "type",
    "version",
    "message_id",
    "envelope_digest",
    "from",
    "to",
    "revision",
    "state",
    "occurred_at",
  ],
  "hail.body.spt-1": ["version", "profile", "blocks"],
} as const satisfies Readonly<Record<HailPayloadType, readonly string[]>>;

const schemaText = readFileSync(
  new URL("../../../spec/hail.cddl", import.meta.url),
  "utf8",
);
const schema = CDDL.compile(schemaText);
const manifest = JSON.parse(
  readFileSync(new URL("../vectors/v1.json", import.meta.url), "utf8"),
) as VectorManifest;
const positiveByType = new Map<HailPayloadType, PositiveVector>();
for (const vector of manifest.positive) {
  if (!positiveByType.has(vector.type)) positiveByType.set(vector.type, vector);
}

function bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "hex"));
}

function encodeUnchecked(value: unknown): Uint8Array {
  return encode(value, rfc8949EncodeOptions);
}

function cddlAccepts(type: HailPayloadType, value: Uint8Array): boolean {
  return schema.validate(value, {
    rule: CDDL_RULES[type],
    maxDepth: 64,
    maxSteps: 100_000,
  }).valid;
}

function codecAccepts(type: HailPayloadType, value: Uint8Array): boolean {
  try {
    decodePayload(type, value);
    return true;
  } catch (error) {
    if (error instanceof HailCodecError) return false;
    throw error;
  }
}

function validPayload(type: HailPayloadType): HailValue {
  const vector = positiveByType.get(type);
  if (vector === undefined) throw new Error(`missing positive vector for ${type}`);
  return decodePayload(type, bytes(vector.payload_hex)) as unknown as HailValue;
}

function record(value: HailValue): Record<string, HailValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected map fixture");
  }
  return value as Record<string, HailValue>;
}

function nestedRecord(
  value: HailValue,
  path: readonly (string | number)[],
): Record<string, HailValue> {
  let current = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || current[segment] === undefined) {
        throw new Error(`missing array path ${path.join(".")}`);
      }
      current = current[segment];
    } else {
      const currentRecord = record(current);
      const next = currentRecord[segment];
      if (next === undefined) throw new Error(`missing map path ${path.join(".")}`);
      current = next;
    }
  }
  return record(current);
}

function expectStructuralRejection(type: HailPayloadType, value: unknown): void {
  const encoded = encodeUnchecked(value);
  expect(cddlAccepts(type, encoded)).toBe(false);
  expect(codecAccepts(type, encoded)).toBe(false);
}

function expectStructuralAcceptance(type: HailPayloadType, value: unknown): void {
  const encoded = encodeUnchecked(value);
  expect(cddlAccepts(type, encoded)).toBe(true);
  expect(codecAccepts(type, encoded)).toBe(true);
}

describe("CDDL and TypeScript structural consistency", () => {
  it("compiles every codec payload rule and keeps signed selectors aligned", () => {
    for (const rule of Object.values(CDDL_RULES)) {
      expect(schema.rules.has(rule)).toBe(true);
    }
    expect([...positiveByType.keys()].sort()).toEqual(
      Object.keys(CDDL_RULES).sort(),
    );
    expect(Object.keys(SIGNED_PROFILES).sort()).toEqual(
      Object.keys(CDDL_RULES)
        .filter((type) => type !== "hail.body.spt-1")
        .sort(),
    );
  });

  for (const vector of manifest.positive) {
    it(`accepts positive CDDL vector: ${vector.id}`, () => {
      expect(cddlAccepts(vector.type, bytes(vector.payload_hex))).toBe(true);
      expect(codecAccepts(vector.type, bytes(vector.payload_hex))).toBe(true);
    });
  }

  for (const vector of manifest.negative_payload) {
    it(`rejects structural payload vector: ${vector.id}`, () => {
      expect(cddlAccepts(vector.type, bytes(vector.hex))).toBe(false);
      expect(codecAccepts(vector.type, bytes(vector.hex))).toBe(false);
    });
  }

  for (const type of Object.keys(CDDL_RULES) as HailPayloadType[]) {
    for (const key of REQUIRED_KEYS[type]) {
      it(`rejects missing ${type}.${key}`, () => {
        const value = record(structuredClone(validPayload(type)));
        delete value[key];
        expectStructuralRejection(type, value);
      });
    }

    it(`rejects unknown members in ${type}`, () => {
      const value = record(structuredClone(validPayload(type)));
      value.unknown = true;
      expectStructuralRejection(type, value);
    });
  }

  for (const nested of NESTED_MAPS) {
    for (const key of nested.required) {
      it(`rejects missing ${nested.type}.${nested.path.join(".")}.${key}`, () => {
        const value = structuredClone(validPayload(nested.type));
        delete nestedRecord(value, nested.path)[key];
        expectStructuralRejection(nested.type, value);
      });
    }

    it(`rejects unknown members in ${nested.type}.${nested.path.join(".")}`, () => {
      const value = structuredClone(validPayload(nested.type));
      nestedRecord(value, nested.path).unknown = true;
      expectStructuralRejection(nested.type, value);
    });
  }

  it("accepts every structural union branch", () => {
    const uncategorizedGrant = record(
      structuredClone(validPayload("hail.grant")),
    );
    uncategorizedGrant.scope = [{ type: "uncategorized" }];
    expectStructuralAcceptance("hail.grant", uncategorizedGrant);

    const replyEnvelope = record(
      structuredClone(validPayload("hail.envelope")),
    );
    replyEnvelope.authorization = {
      type: "reply",
      reply_to: "01a0443c-5600-7c43-969f-9fca31321a64",
    };
    delete replyEnvelope.category;
    replyEnvelope.reply = {
      allowed: true,
      until: (replyEnvelope.created_at as number) + 60,
    };
    expectStructuralAcceptance("hail.envelope", replyEnvelope);

    const statusCases: Array<Record<string, HailValue>> = [];
    const accepted = record(
      structuredClone(validPayload("hail.delivery-status")),
    );
    accepted.revision = 1;
    accepted.state = "accepted";
    statusCases.push(accepted);
    for (const [state, reason] of [
      ["on-hold", "sender-unreachable"],
      ["failed", "body-invalid"],
      ["cancelled", "recipient-cancelled"],
    ] as const) {
      const status = record(
        structuredClone(validPayload("hail.delivery-status")),
      );
      status.state = state;
      status.reason = reason;
      if (state === "on-hold") status.retry_at = status.occurred_at as number;
      statusCases.push(status);
    }
    for (const status of statusCases) {
      expectStructuralAcceptance("hail.delivery-status", status);
    }
  });

  it("accepts exact collection and integer boundaries", () => {
    const emptyProfile = record(
      structuredClone(validPayload("hail.sender-profile")),
    );
    emptyProfile.categories = [];
    expectStructuralAcceptance("hail.sender-profile", emptyProfile);
    emptyProfile.categories = Array.from({ length: 100 }, (_, index) => ({
      id: `category-${index.toString().padStart(3, "0")}`,
      label: "Category",
    })) as unknown as HailValue;
    expectStructuralAcceptance("hail.sender-profile", emptyProfile);

    const minimumEnvelope = record(
      structuredClone(validPayload("hail.envelope")),
    );
    record(minimumEnvelope.body as HailValue).size = 1;
    expectStructuralAcceptance("hail.envelope", minimumEnvelope);
    record(minimumEnvelope.body as HailValue).size = 262_144;
    expectStructuralAcceptance("hail.envelope", minimumEnvelope);

    const emptyBody = record(
      structuredClone(validPayload("hail.body.spt-1")),
    );
    emptyBody.blocks = [];
    expectStructuralAcceptance("hail.body.spt-1", emptyBody);
  });

  it("enforces structural collection and byte-string boundaries", () => {
    const profile = record(structuredClone(validPayload("hail.sender-profile")));
    const category = { id: "category", label: "Category" };
    profile.categories = Array.from({ length: 101 }, (_, index) => ({
      ...category,
      id: `category-${index.toString().padStart(3, "0")}`,
    })) as unknown as HailValue;
    expectStructuralRejection("hail.sender-profile", profile);

    const grant = record(structuredClone(validPayload("hail.grant")));
    grant.scope = [{ type: "categories", values: [] }];
    expectStructuralRejection("hail.grant", grant);

    const envelope = record(structuredClone(validPayload("hail.envelope")));
    const body = record(envelope.body as HailValue);
    body.size = 0;
    expectStructuralRejection("hail.envelope", envelope);
    body.size = 262_145;
    expectStructuralRejection("hail.envelope", envelope);

    for (const length of [31, 33]) {
      const mutated = record(structuredClone(validPayload("hail.envelope")));
      const descriptor = record(mutated.body as HailValue);
      const digest = record(descriptor.digest as HailValue);
      digest.value = new Uint8Array(length);
      expectStructuralRejection("hail.envelope", mutated);
    }

    const hailBody = record(structuredClone(validPayload("hail.body.spt-1")));
    const block = record((hailBody.blocks as HailValue[])[0] as HailValue);
    block.children = [];
    expectStructuralRejection("hail.body.spt-1", hailBody);
    block.children = [{ _type: "span", text: "text", marks: ["strong"] }];
    expectStructuralRejection("hail.body.spt-1", hailBody);
    block.children = [{ _type: "span", text: "text", marks: [] }];
    block.markDefs = [{ _key: "mark" }];
    expectStructuralRejection("hail.body.spt-1", hailBody);
  });

  it("documents semantic checks that intentionally exceed CDDL", () => {
    const binding = record(
      structuredClone(validPayload("hail.address-binding")),
    );
    binding.expires_at = binding.issued_at as number;
    const encodedBinding = encodeUnchecked(binding);
    expect(cddlAccepts("hail.address-binding", encodedBinding)).toBe(true);
    expect(codecAccepts("hail.address-binding", encodedBinding)).toBe(false);

    const malformedDid = record(
      structuredClone(validPayload("hail.delivery-status")),
    );
    malformedDid.from = "not-a-did";
    const encodedStatus = encodeUnchecked(malformedDid);
    expect(cddlAccepts("hail.delivery-status", encodedStatus)).toBe(true);
    expect(codecAccepts("hail.delivery-status", encodedStatus)).toBe(false);
  });
});
