export const HAIL_MAX_INTEGER = 9_007_199_254_740_991;
export const HAIL_MIN_INTEGER = -HAIL_MAX_INTEGER;

export type HailValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | readonly HailValue[]
  | { readonly [key: string]: HailValue };

export type HailPayloadType =
  | "hail.address-binding"
  | "hail.sender-profile"
  | "hail.grant"
  | "hail.envelope"
  | "hail.delivery-status"
  | "hail.body.spt-1";

export type HailSignedPayloadType = Exclude<HailPayloadType, "hail.body.spt-1">;

export interface HailSigner {
  readonly keyId: string;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

export interface HailVerifier {
  verify(
    data: Uint8Array,
    signature: Uint8Array,
    keyId: string,
  ): Promise<boolean>;
}

export interface InspectedHailObject<T = HailValue> {
  readonly type: HailSignedPayloadType;
  readonly keyId: string;
  readonly payload: T;
  readonly payloadBytes: Uint8Array;
  readonly representationBytes: Uint8Array;
}

declare const verifiedHailObject: unique symbol;

export interface VerifiedHailObject<T = HailValue>
  extends InspectedHailObject<T> {
  readonly [verifiedHailObject]: true;
}
