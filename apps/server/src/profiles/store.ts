import type { HailSenderProfile } from "@hailproto/codec";
import type { PlcResolutionEvidence } from "../plc/resolver.js";

export interface StoredSenderProfile {
  id: string;
  accountId: string;
  did: string;
  revision: number;
  payload: HailSenderProfile;
  cose: Uint8Array;
  digest: Uint8Array;
  signingPublicKey: string;
  updatedAt: number;
  createdAt: Date;
}

export interface SenderProfileStore {
  findCurrentByDid(did: string): Promise<StoredSenderProfile | null>;
}

export interface VerifiedSenderProfile {
  did: string;
  serviceBase: string;
  messagingDidKey: string;
  profile: HailSenderProfile;
  representation: Uint8Array;
  digest: Uint8Array;
  etag: string;
  plcEvidence: PlcResolutionEvidence;
  verifiedAt: Date;
}

export interface VerifiedSenderProfileStore {
  getLatestVerifiedSenderProfile(did: string): Promise<VerifiedSenderProfile | null>;
  retainVerifiedSenderProfile(profile: VerifiedSenderProfile): Promise<void>;
}
