export interface HailDigest {
  algorithm: "sha-256";
  value: Uint8Array;
}

export interface HailBundledImageAsset {
  id: string;
  role: "avatar" | "header";
  media_type: "image/png";
  loading: "bundled";
  size: number;
  digest: HailDigest;
  width: number;
  height: number;
  data: Uint8Array;
}

export interface HailAssetManifest {
  version: 1;
  assets: [HailBundledImageAsset, ...HailBundledImageAsset[]];
}

export interface HailAddressBinding {
  version: 1;
  type: "hail.address-binding";
  address: string;
  did: string;
  issued_at: number;
  expires_at: number;
  key_id: string;
}

export interface HailSenderCategory {
  id: string;
  label: string;
  description?: string;
}

export interface HailSenderProfile {
  type: "hail.sender-profile";
  version: 1;
  did: string;
  revision: number;
  display_name: string;
  description?: string;
  offers_uncategorized: boolean;
  categories: HailSenderCategory[];
  updated_at: number;
  key_id: string;
}

export type HailGrantScope =
  | { type: "categories"; values: string[] }
  | { type: "uncategorized" };

export interface HailConsentContext {
  grantee_address: string;
  address_binding_hash: HailDigest;
  sender_profile_hash: HailDigest;
}

export interface HailGrant {
  type: "hail.grant";
  version: 1;
  grant_id: string;
  revision: number;
  previous: null | Uint8Array;
  grantor: string;
  grantee: string;
  scope: [HailGrantScope];
  status: "active" | "revoked";
  issued_at: number;
  updated_at: number;
  expires_at: null | number;
  consent_context: HailConsentContext;
  key_id: string;
}

export type HailMessageType =
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

export type HailEnvelopeAuthorization =
  | { type: "grant"; grant_id: string }
  | { type: "reply"; reply_to: string };

export interface HailBodyDescriptor {
  digest: HailDigest;
  size: number;
  media_type: "application/hail-body+cbor";
  profile: "spt-1" | "spt-2";
  available_until: number;
  access: {
    type: "bearer";
    token: Uint8Array;
    expires_at: number;
  };
}

export type HailReplyPermission =
  | { allowed: false }
  | { allowed: true; until: number };

export interface HailEnvelope {
  type: "hail.envelope";
  version: 1;
  message_id: string;
  from: string;
  to: string;
  authorization: HailEnvelopeAuthorization;
  category?: string;
  message_type?: HailMessageType;
  created_at: number;
  expires_at: number;
  body: HailBodyDescriptor;
  reply: HailReplyPermission;
}

export type HailDeliveryState =
  | "accepted"
  | "on-hold"
  | "delivered"
  | "failed"
  | "cancelled";

export type HailHoldReason =
  | "sender-unreachable"
  | "body-temporarily-unavailable"
  | "body-transfer-interrupted"
  | "sender-rate-limited"
  | "receiver-resource-constrained";

export type HailFailureReason =
  | "body-authorization-failed"
  | "body-integrity-failed"
  | "body-invalid"
  | "body-unsupported"
  | "delivery-expired"
  | "receiver-policy-rejected";

export type HailCancellationReason =
  | "recipient-cancelled"
  | "receiver-administrative-cancellation";

export type HailDeliveryReason =
  | HailHoldReason
  | HailFailureReason
  | HailCancellationReason;

interface HailDeliveryStatusBase {
  type: "hail.delivery-status";
  version: 1;
  message_id: string;
  envelope_digest: HailDigest;
  from: string;
  to: string;
  occurred_at: number;
}

export type HailDeliveryStatus = HailDeliveryStatusBase &
  (
    | { revision: 1; state: "accepted"; reason?: never; retry_at?: never }
    | { revision: number; state: "on-hold"; reason: HailHoldReason; retry_at: number }
    | { revision: number; state: "delivered"; reason?: never; retry_at?: never }
    | { revision: number; state: "failed"; reason: HailFailureReason; retry_at?: never }
    | { revision: number; state: "cancelled"; reason: HailCancellationReason; retry_at?: never }
  );

export interface HailSptSpan {
  _type: "span";
  text: string;
  marks: [];
}

export interface HailSptTextBlock {
  _type: "block";
  style: "normal";
  children: [HailSptSpan, ...HailSptSpan[]];
  markDefs: [];
}

export interface HailSptBody {
  version: 1;
  profile: "spt-1";
  blocks: HailSptTextBlock[];
}

export interface HailSpt2Span {
  _type: "span";
  text: string;
  marks: string[];
}

export interface HailSptLink {
  _key: string;
  _type: "spt.link";
  href: string;
  title?: string;
}

export interface HailSpt2TextBlock {
  _type: "block";
  style: "normal" | "h1" | "h2" | "h3" | "blockquote" | "caption";
  children: [HailSpt2Span, ...HailSpt2Span[]];
  markDefs: HailSptLink[];
  listItem?: "bullet" | "number";
  level?: 1 | 2 | 3;
}

export interface HailSpt2Body {
  version: 1;
  profile: "spt-2";
  blocks: HailSpt2TextBlock[];
}

export interface HailPayloadByType {
  "hail.address-binding": HailAddressBinding;
  "hail.sender-profile": HailSenderProfile;
  "hail.grant": HailGrant;
  "hail.envelope": HailEnvelope;
  "hail.delivery-status": HailDeliveryStatus;
  "hail.body.spt-1": HailSptBody;
  "hail.body.spt-2": HailSpt2Body;
}
