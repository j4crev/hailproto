import type { HailAddressBinding, HailEnvelope } from "../src/index.js";
import type {
  HailDeliveryStatus,
  HailGrant,
  HailSenderProfile,
  HailSptBody,
} from "../src/index.js";

export const identityDid = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
export const messagingDid = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";

export const addressBinding: HailAddressBinding = {
  version: 1,
  type: "hail.address-binding",
  address: "alice@example.com",
  did: identityDid,
  issued_at: 1_787_851_200,
  expires_at: 1_795_627_200,
  key_id: `${identityDid}#hail-identity`,
};

export const envelope: HailEnvelope = {
  type: "hail.envelope",
  version: 1,
  message_id: "01a0443c-5600-7c43-969f-9fca31321a64",
  from: messagingDid,
  to: identityDid,
  authorization: {
    type: "grant",
    grant_id: "01954144-8097-7a9d-a7a8-ef29a823eaf1",
  },
  category: "receipts",
  message_type: "receipt",
  created_at: 1_787_851_200,
  expires_at: 1_787_937_600,
  body: {
    digest: {
      algorithm: "sha-256",
      value: new Uint8Array(32).fill(1),
    },
    size: 128,
    media_type: "application/hail-body+cbor",
    profile: "spt-1",
    available_until: 1_790_443_200,
    access: {
      type: "bearer",
      token: new Uint8Array(32).fill(2),
      expires_at: 1_790_443_200,
    },
  },
  reply: {
    allowed: false,
  },
};

export const senderProfile: HailSenderProfile = {
  type: "hail.sender-profile",
  version: 1,
  did: messagingDid,
  revision: 1,
  display_name: "Example Store",
  description: "Receipts and account notifications",
  offers_uncategorized: false,
  categories: [
    { id: "receipts", label: "Receipts" },
    { id: "security-alerts", label: "Security alerts" },
  ],
  updated_at: 1_787_851_200,
  key_id: `${messagingDid}#hail-messaging`,
};

export const grant: HailGrant = {
  type: "hail.grant",
  version: 1,
  grant_id: "01954144-8097-7a9d-a7a8-ef29a823eaf1",
  revision: 1,
  previous: null,
  grantor: identityDid,
  grantee: messagingDid,
  scope: [{ type: "categories", values: ["receipts", "security-alerts"] }],
  status: "active",
  issued_at: 1_787_851_200,
  updated_at: 1_787_851_200,
  expires_at: null,
  consent_context: {
    grantee_address: "updates@store.example.com",
    address_binding_hash: {
      algorithm: "sha-256",
      value: new Uint8Array(32).fill(3),
    },
    sender_profile_hash: {
      algorithm: "sha-256",
      value: new Uint8Array(32).fill(4),
    },
  },
  key_id: `${identityDid}#hail-identity`,
};

export const deliveryStatus: HailDeliveryStatus = {
  type: "hail.delivery-status",
  version: 1,
  message_id: "01a0443c-5600-7c43-969f-9fca31321a64",
  envelope_digest: {
    algorithm: "sha-256",
    value: new Uint8Array(32).fill(5),
  },
  from: identityDid,
  to: messagingDid,
  revision: 2,
  state: "delivered",
  occurred_at: 1_787_851_260,
};

export const body: HailSptBody = {
  version: 1,
  profile: "spt-1",
  blocks: [
    {
      _type: "block",
      style: "normal",
      children: [{ _type: "span", text: "Hello from Hail.", marks: [] }],
      markDefs: [],
    },
  ],
};
