import type { HailSignedPayloadType } from "./types.js";

export type HailKeyRole = "hail-identity" | "hail-messaging";

export interface HailSignedProfile {
  readonly type: HailSignedPayloadType;
  readonly contentType: string;
  readonly signerField: "did" | "grantor" | "from";
  readonly keyRole: HailKeyRole;
  readonly maximumRepresentationBytes: number | undefined;
}

export const COSE_SIGN1_TAG = 18;
export const COSE_ALGORITHM_HEADER = 1;
export const COSE_CONTENT_TYPE_HEADER = 3;
export const COSE_KEY_ID_HEADER = 4;
export const COSE_ED25519_ALGORITHM = -19;

export const SIGNED_PROFILES: Readonly<
  Record<HailSignedPayloadType, HailSignedProfile>
> = {
  "hail.address-binding": {
    type: "hail.address-binding",
    contentType: "application/hail-address-binding+cbor",
    signerField: "did",
    keyRole: "hail-identity",
    maximumRepresentationBytes: 16_384,
  },
  "hail.sender-profile": {
    type: "hail.sender-profile",
    contentType: "application/hail-sender-profile+cbor",
    signerField: "did",
    keyRole: "hail-messaging",
    maximumRepresentationBytes: 65_536,
  },
  "hail.grant": {
    type: "hail.grant",
    contentType: "application/hail-grant+cbor",
    signerField: "grantor",
    keyRole: "hail-identity",
    maximumRepresentationBytes: 262_144,
  },
  "hail.envelope": {
    type: "hail.envelope",
    contentType: "application/hail-envelope+cbor",
    signerField: "from",
    keyRole: "hail-messaging",
    maximumRepresentationBytes: 16_384,
  },
  "hail.delivery-status": {
    type: "hail.delivery-status",
    contentType: "application/hail-delivery-status+cbor",
    signerField: "from",
    keyRole: "hail-messaging",
    maximumRepresentationBytes: 16_384,
  },
};

export function isSignedPayloadType(value: unknown): value is HailSignedPayloadType {
  return typeof value === "string" && value in SIGNED_PROFILES;
}
