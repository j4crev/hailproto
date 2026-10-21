import type { HailGrant } from "@hailproto/codec";
import type { VerifiedAddress } from "../discovery/verifier.js";
import type { VerifiedSenderProfile } from "../profiles/store.js";
import type { PlcResolutionEvidence } from "../plc/resolver.js";

export type GrantLocalRole = "grantor" | "grantee";

export interface SignedGrantRevision {
  readonly localAccountId: string;
  readonly localRole: GrantLocalRole;
  readonly payload: HailGrant;
  readonly representation: Uint8Array;
  readonly digest: Uint8Array;
  readonly signingPublicKey: string;
  readonly signingPlcEvidence: PlcResolutionEvidence;
  readonly expectedServiceBase?: string;
  readonly recipientEvidence?: PlcResolutionEvidence;
  readonly recipientServiceBase?: string;
  readonly receivedAt: Date;
}

export type SignedGrantRevisionInput = Omit<SignedGrantRevision, "receivedAt">;

export interface GrantConsentEvidence {
  readonly address: VerifiedAddress;
  readonly senderProfile: VerifiedSenderProfile;
}

export interface AuthoritativeGrantRevision1 {
  readonly revision: SignedGrantRevisionInput;
  readonly consent: GrantConsentEvidence;
  readonly destinationServiceBase: string;
}

export interface AuthoritativeGrantRevocation {
  readonly revision: SignedGrantRevisionInput;
  readonly expectedCurrentRevision: number;
  readonly expectedCurrentDigest: Uint8Array;
}

export interface AuthoritativeGrantUpdate extends AuthoritativeGrantRevocation {
  readonly consent?: GrantConsentEvidence;
  readonly destinationServiceBase?: string;
}

export interface ReceivedGrantRevision {
  readonly localAccountId: string;
  readonly payload: HailGrant;
  readonly representation: Uint8Array;
  readonly digest: Uint8Array;
  readonly signingPublicKey: string;
  readonly signingPlcEvidence: PlcResolutionEvidence;
  readonly recipientEvidence?: PlcResolutionEvidence;
  readonly recipientServiceBase?: string;
}

export interface GrantPublicationClaim {
  readonly grant: SignedGrantRevision;
  readonly destinationServiceBase: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
  readonly attemptCount: number;
}

export interface ClaimedPublicationResult {
  readonly grantId: string;
  readonly revision: number;
  readonly leaseToken: string;
  readonly httpStatus?: number;
  readonly error?: string;
}

export interface GrantStore {
  findCurrentByGrantId(grantId: string): Promise<SignedGrantRevision | null>;
  findRevisionByGrantId?(grantId:string,revision:number):Promise<SignedGrantRevision|null>;
  findReceivedForSender?(grantId: string, senderDid: string): Promise<SignedGrantRevision | null>;
  findActiveAuthoritativeByDidPair(
    grantorDid: string,
    granteeDid: string,
  ): Promise<SignedGrantRevision | null>;
  insertAuthoritativeRevision1(input: AuthoritativeGrantRevision1): Promise<void>;
  appendAuthoritativeRevocation(input: AuthoritativeGrantRevocation): Promise<void>;
  appendAuthoritativeUpdate(input: AuthoritativeGrantUpdate): Promise<void>;
  acceptReceivedRevision(input: ReceivedGrantRevision): Promise<SignedGrantRevision>;
  claimDuePublication(leaseDurationMs: number, now?: Date): Promise<GrantPublicationClaim | null>;
  acknowledgePublication(input: ClaimedPublicationResult & { etag: string }): Promise<void>;
  retryPublication(input: ClaimedPublicationResult & { nextAttemptAt: Date }): Promise<void>;
  blockPublication(input: ClaimedPublicationResult): Promise<void>;
}
