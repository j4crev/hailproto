import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  createWebCryptoSigner,
  createWebCryptoVerifier,
  decodeBase64Url,
  signPayload,
  validateAssetManifest,
  verifySignedPayload,
  type HailBundledImageAsset,
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
  version?: 1 | 2;
  display_name: string;
  description?: string;
  offers_uncategorized: boolean;
  categories: HailSenderCategory[];
  avatar?: HailBundledImageAsset | null;
}

export interface SenderProfileRepository {
  getAccountByDid?(did: string): Promise<AccountRecord | null>;
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

function avatarAsset(data: Uint8Array): HailBundledImageAsset {
  if (data.length < 24) throw new Error("Sender Profile avatar must be a PNG image");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const asset: HailBundledImageAsset = { id:"avatar",role:"avatar",media_type:"image/png",loading:"bundled",
    size:data.length,digest:{algorithm:"sha-256",value:new Uint8Array(createHash("sha256").update(data).digest())},
    width:view.getUint32(16),height:view.getUint32(20),data };
  validateAssetManifest({version:1,assets:[asset]});
  return asset;
}

export function parseSenderProfileDefinition(value: unknown): SenderProfileDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Sender Profile definition must be an object");
  const record = value as Record<string, unknown>,allowed=["version","display_name","description","offers_uncategorized","categories","avatar"];
  if(Object.keys(record).some(key=>!allowed.includes(key))||typeof record.display_name!=="string"||
    record.description!==undefined&&typeof record.description!=="string"||typeof record.offers_uncategorized!=="boolean"||
    !Array.isArray(record.categories)||record.version!==undefined&&record.version!==1&&record.version!==2||
    record.avatar!==undefined&&record.avatar!==null&&typeof record.avatar!=="string")throw new Error("Sender Profile definition has an invalid shape");
  const version:1|2=record.version===2?2:1;
  if(version===1&&record.avatar!==undefined)throw new Error("Sender Profile v1 cannot contain an avatar");
  const categories=record.categories.map(value=>{
    if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Sender Profile category must be an object");
    const category=value as Record<string,unknown>;
    if(Object.keys(category).some(key=>!["id","label","description"].includes(key))||typeof category.id!=="string"||
      typeof category.label!=="string"||category.description!==undefined&&typeof category.description!=="string")
      throw new Error("Sender Profile category has an invalid shape");
    return category.description===undefined?{id:category.id,label:category.label}:
      {id:category.id,label:category.label,description:category.description};
  });
  const base={version,display_name:record.display_name,offers_uncategorized:record.offers_uncategorized,categories,
    ...(record.avatar===undefined?{}:{avatar:record.avatar===null?null:avatarAsset(decodeBase64Url(record.avatar))})};
  return record.description===undefined?base:{...base,description:record.description};
}

function normalizedDefinition(definition: SenderProfileDefinition): SenderProfileDefinition {
  const categories = definition.categories
    .map((category) =>
      category.description === undefined
        ? { id: category.id, label: category.label }
        : { id: category.id, label: category.label, description: category.description },
    )
    .sort((left, right) => Buffer.from(left.id).compare(Buffer.from(right.id)));
  const version=definition.version??1;
  if(version===1&&definition.avatar)throw new Error("Sender Profile v1 cannot contain an avatar");
  const base={version,offers_uncategorized:definition.offers_uncategorized,categories,
    ...(definition.avatar?{avatar:definition.avatar}:{})};
  return definition.description === undefined
    ? {
        ...base,
        display_name: definition.display_name,
      }
    : {
        ...base,
        display_name: definition.display_name,
        description: definition.description,
      };
}

function matchesDefinition(
  profile: StoredSenderProfile,
  definition: SenderProfileDefinition,
  signingPublicKey: string,
): boolean {
  const payloadDefinition: SenderProfileDefinition = {
    version: profile.payload.version,
    display_name: profile.payload.display_name,
    ...(profile.payload.description === undefined
      ? {}
      : { description: profile.payload.description }),
    offers_uncategorized: profile.payload.offers_uncategorized,
    categories: profile.payload.categories,
    ...(profile.payload.version===2&&profile.payload.assets?{avatar:profile.payload.assets.assets[0]}:{}),
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

  private async localAccount(input:string):Promise<AccountRecord> {
    if(input.startsWith("did:plc:")){
      const account=await this.repository.getAccountByDid?.(input);
      if(!account)throw new Error("Account does not exist");return account;
    }
    return this.repository.getAccountByAddress(canonicalizeHailAddress(input));
  }

  async createOrReuse(
    addressInput: string,
    inputDefinition: SenderProfileDefinition,
    expectedPreviousRevision?: number,
  ): Promise<StoredSenderProfile> {
    const account = await this.localAccount(addressInput);
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
    const common = {
      type: "hail.sender-profile" as const,
      did: account.did,
      revision,
      display_name: definition.display_name,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      offers_uncategorized: definition.offers_uncategorized,
      categories: definition.categories,
      updated_at: updatedAt,
      key_id: keyId,
    };
    const payload: HailSenderProfile = definition.version===2?{...common,version:2,
      ...(definition.avatar?{assets:{version:1,assets:[definition.avatar]}}:{})}:{...common,version:1};

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
    const account=await this.localAccount(addressInput);
    if(account.state!=="active")throw new Error("Account must be active before reading a Sender Profile");
    return this.repository.getLatestSenderProfile(account.id);
  }
}
