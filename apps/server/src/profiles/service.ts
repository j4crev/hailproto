import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  createWebCryptoSigner,
  createWebCryptoVerifier,
  signPayload,
  verifySignedPayload,
  type HailSenderCategory,
  type HailSenderProfile,
} from "@hailproto/codec";
import { canonicalizeHailAddress } from "../identity/address.js";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import { importEd25519PrivateKey } from "../identity/keys.js";
import type { KeyEncryptor } from "../identity/key-encryption.js";
import type { AccountKeyRecord, AccountRecord } from "../onboarding/repository.js";
import type { HailDidResolver, PlcResolutionEvidence } from "../plc/resolver.js";
import type { StoredSenderProfile } from "./store.js";

export interface SenderProfileDefinition {
  display_name: string;
  description?: string;
  offers_uncategorized: boolean;
  categories: HailSenderCategory[];
}

export interface SenderProfileRepository {
  getAccountByAddress(canonicalAddress: string): Promise<AccountRecord>;
  getKey(accountId: string, role: AccountKeyRecord["role"]): Promise<AccountKeyRecord>;
  getLatestSenderProfile(accountId: string): Promise<StoredSenderProfile | null>;
  insertSenderProfile(
    profile: StoredSenderProfile,
    expectedPreviousRevision: number,
    authority: { evidence: PlcResolutionEvidence; serviceBase: string },
  ): Promise<void>;
}

export class SenderProfileConflictError extends Error {}

export function parseSenderProfileDefinition(value: unknown): SenderProfileDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Sender Profile definition must be an object");
  const record = value as Record<string, unknown>,allowed=["display_name","description","offers_uncategorized","categories"];
  if(Object.keys(record).some(key=>!allowed.includes(key))||typeof record.display_name!=="string"||
    record.description!==undefined&&typeof record.description!=="string"||typeof record.offers_uncategorized!=="boolean"||
    !Array.isArray(record.categories))throw new Error("Sender Profile definition has an invalid shape");
  const categories=record.categories.map(value=>{
    if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Sender Profile category must be an object");
    const category=value as Record<string,unknown>;
    if(Object.keys(category).some(key=>!["id","label","description"].includes(key))||typeof category.id!=="string"||
      typeof category.label!=="string"||category.description!==undefined&&typeof category.description!=="string")
      throw new Error("Sender Profile category has an invalid shape");
    return category.description===undefined?{id:category.id,label:category.label}:
      {id:category.id,label:category.label,description:category.description};
  });
  return record.description===undefined?{display_name:record.display_name,offers_uncategorized:record.offers_uncategorized,categories}:
    {display_name:record.display_name,description:record.description,offers_uncategorized:record.offers_uncategorized,categories};
}

function normalizedDefinition(definition: SenderProfileDefinition): SenderProfileDefinition {
  const categories = definition.categories
    .map((category) =>
      category.description === undefined
        ? { id: category.id, label: category.label }
        : { id: category.id, label: category.label, description: category.description },
    )
    .sort((left, right) => Buffer.from(left.id).compare(Buffer.from(right.id)));
  return definition.description === undefined
    ? {
        display_name: definition.display_name,
        offers_uncategorized: definition.offers_uncategorized,
        categories,
      }
    : {
        display_name: definition.display_name,
        description: definition.description,
        offers_uncategorized: definition.offers_uncategorized,
        categories,
      };
}

function matchesDefinition(
  profile: StoredSenderProfile,
  definition: SenderProfileDefinition,
  signingPublicKey: string,
): boolean {
  const payloadDefinition: SenderProfileDefinition = {
    display_name: profile.payload.display_name,
    ...(profile.payload.description === undefined
      ? {}
      : { description: profile.payload.description }),
    offers_uncategorized: profile.payload.offers_uncategorized,
    categories: profile.payload.categories,
  };
  return (
    profile.signingPublicKey === signingPublicKey &&
    isDeepStrictEqual(payloadDefinition, definition)
  );
}

export class SenderProfileService {
  constructor(
    private readonly repository: SenderProfileRepository,
    private readonly encryptor: KeyEncryptor,
    private readonly resolver: HailDidResolver,
    private readonly expectedServiceBase: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createOrReuse(
    addressInput: string,
    inputDefinition: SenderProfileDefinition,
    expectedPreviousRevision?: number,
  ): Promise<StoredSenderProfile> {
    const address = canonicalizeHailAddress(addressInput);
    const account = await this.repository.getAccountByAddress(address);
    if (account.state !== "active" || !account.did) {
      throw new Error("Account must be active before publishing a Sender Profile");
    }
    const key = await this.repository.getKey(account.id, "hail-messaging");
    if (key.algorithm !== "ed25519") throw new Error("Hail messaging key must use Ed25519");
    const resolved = await this.resolver.resolve(account.did);
    if (
      resolved.messagingDidKey !== key.publicKey ||
      resolved.serviceBase !== this.expectedServiceBase
    ) {
      throw new Error("Current PLC state does not authorize this provider messaging key");
    }

    const definition = normalizedDefinition(inputDefinition);
    const latest = await this.repository.getLatestSenderProfile(account.id);
    if (latest && matchesDefinition(latest, definition, key.publicKey)) return latest;
    if(expectedPreviousRevision!==undefined&&expectedPreviousRevision!==(latest?.revision??0))
      throw new SenderProfileConflictError("Sender Profile revision changed");

    const instant = this.now();
    const current = Math.floor(instant.getTime() / 1_000);
    const updatedAt = Math.max(current, (latest?.updatedAt ?? -1) + 1);
    if (updatedAt > current + 300) throw new Error("Sender Profile timestamp is too far ahead");
    const revision = (latest?.revision ?? 0) + 1;
    const keyId = `${account.did}#hail-messaging`;
    const payload: HailSenderProfile = {
      type: "hail.sender-profile",
      version: 1,
      did: account.did,
      revision,
      display_name: definition.display_name,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      offers_uncategorized: definition.offers_uncategorized,
      categories: definition.categories,
      updated_at: updatedAt,
      key_id: keyId,
    };

    const privateBytes = await this.encryptor.decrypt(
      account.id,
      key.role,
      key.algorithm,
      key.publicKey,
      key,
    );
    let cose: Uint8Array;
    try {
      const privateKey = await importEd25519PrivateKey(privateBytes);
      cose = await signPayload(
        "hail.sender-profile",
        payload,
        createWebCryptoSigner(keyId, privateKey),
      );
    } finally {
      privateBytes.fill(0);
    }
    const publicKey = await ed25519PublicKeyFromDidKey(key.publicKey);
    await verifySignedPayload(
      "hail.sender-profile",
      cose,
      createWebCryptoVerifier(async (requestedKeyId) => {
        if (requestedKeyId !== keyId) throw new Error("Unexpected Sender Profile key ID");
        return publicKey;
      }),
    );
    const profile: StoredSenderProfile = {
      id: crypto.randomUUID(),
      accountId: account.id,
      did: account.did,
      revision,
      payload,
      cose,
      digest: new Uint8Array(createHash("sha256").update(cose).digest()),
      signingPublicKey: key.publicKey,
      updatedAt,
      createdAt: instant,
    };
    try {
      await this.repository.insertSenderProfile(profile, revision - 1, {
        evidence: resolved.evidence,
        serviceBase: this.expectedServiceBase,
      });
      return profile;
    } catch (error) {
      const winner = await this.repository.getLatestSenderProfile(account.id);
      if (winner && matchesDefinition(winner, definition, key.publicKey)) return winner;
      throw error;
    }
  }

  async getLatest(addressInput:string):Promise<StoredSenderProfile|null>{
    const account=await this.repository.getAccountByAddress(canonicalizeHailAddress(addressInput));
    if(account.state!=="active")throw new Error("Account must be active before reading a Sender Profile");
    return this.repository.getLatestSenderProfile(account.id);
  }
}
