import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { cidForCbor } from "@atproto/common";
import { assureValidSig, def, didForCreateOp, validateOperationLog, type Operation } from "@did-plc/lib";
import { createWebCryptoVerifier, createWebCryptoSigner, signPayload, verifySignedPayload } from "@hailproto/codec";
import * as dagCbor from "@ipld/dag-cbor";
import { base58btc } from "multiformats/bases/base58";
import type { SQL } from "bun";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import { canonicalizeHailAddress } from "../identity/address.js";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import type { KeyEncryptor } from "../identity/key-encryption.js";
import { generateAccountKeys, importEd25519PrivateKey } from "../identity/keys.js";
import { MANAGED_CUSTODY_PROFILE_VERSION } from "../identity/managed-profile.js";
import type { PlcDirectoryClient } from "../plc/client.js";
import { isPlcNotFound } from "../plc/client.js";
import { verifyRegisteredGenesis } from "../plc/verify.js";
import { assertPrivatePocRegistry } from "../migration/poc-profile.js";
import { OnboardingRepository } from "./repository.js";

export interface PrivatePocPreparation {
  accountId: string; address: string;
  userRecoveryKey: string; userIdentityKey: string;
  providerRotationKey: string; providerMessagingKey: string;
  sourceServiceBase: string;
  custodyProfile: "owner-controlled" | "managed";
  managedProfileVersion: typeof MANAGED_CUSTODY_PROFILE_VERSION | null;
}

interface PreparationRow {
  account_id: string; user_recovery_public_key: string; user_identity_public_key: string;
  provider_rotation_public_key: string; provider_messaging_public_key: string;
  monitor_public_key: string;
  custody_profile: "owner-controlled" | "managed";
  managed_profile_version: typeof MANAGED_CUSTODY_PROFILE_VERSION | null;
  signup_token_hash: Uint8Array | null;
}

export class PrivatePocOnboarding {
  constructor(private readonly sql: SQL, private readonly plc: PlcDirectoryClient,
    private readonly encryptor: KeyEncryptor, private readonly registryOrigin: string,
    private readonly serviceBase: string) {
    assertPrivatePocRegistry(registryOrigin, serviceBase);
  }

  async prepare(addressInput: string, recovery: string, identity: string,
    backupChecked: boolean, profile: "owner-controlled" | "managed" = "owner-controlled",
    signupHash?: Uint8Array): Promise<PrivatePocPreparation> {
    if (!backupChecked || !recovery.startsWith("did:key:z") || !identity.startsWith("did:key:z") ||
      recovery === identity) {
      throw new Error("POC onboarding needs a verified user backup and distinct recovery/identity public keys");
    }
    await ed25519PublicKeyFromDidKey(identity);
    const address = canonicalizeHailAddress(addressInput);
    if (address.slice(address.indexOf("@") + 1) !== new URL(this.serviceBase).hostname) {
      throw new Error("POC onboarding address must belong to the provider's own domain");
    }
    const prior = await this.sql<(PreparationRow & { canonical_address: string;
      onboarding_state: string })[]>`
      SELECT p.account_id, p.user_recovery_public_key, p.user_identity_public_key,p.custody_profile,p.managed_profile_version,p.signup_token_hash,
        p.provider_rotation_public_key, p.provider_messaging_public_key, p.monitor_public_key,
        account.canonical_address, account.onboarding_state
      FROM provider_accounts account JOIN private_poc_onboarding_preparations p
        ON p.account_id = account.id WHERE account.canonical_address = ${address}`;
    if (prior[0]) {
      if (prior[0].user_recovery_public_key !== recovery || prior[0].custody_profile !== profile ||
        (profile === "owner-controlled" && prior[0].user_identity_public_key !== identity) ||
        (signupHash && (!prior[0].signup_token_hash || !Buffer.from(signupHash).equals(Buffer.from(prior[0].signup_token_hash)))) ||
        !["reserved", "prepared", "submission-unknown", "did-registered", "address-staged"].includes(
          prior[0].onboarding_state) && !(signupHash && prior[0].onboarding_state === "active")) {
        throw new Error("This POC address is prepared for a different user or no longer pending");
      }
      return { accountId: prior[0].account_id, address,
        userRecoveryKey: recovery, userIdentityKey: prior[0].user_identity_public_key, custodyProfile: profile,
        managedProfileVersion: prior[0].managed_profile_version,
        providerRotationKey: prior[0].provider_rotation_public_key,
        providerMessagingKey: prior[0].provider_messaging_public_key, sourceServiceBase: this.serviceBase };
    }
    const accountId = randomUUID();
    const generated = await generateAccountKeys(accountId, this.encryptor);
    if (profile === "managed") identity = generated.identityDidKey;
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const monitorBytes = new Uint8Array(34);
    monitorBytes.set([0xed, 0x01]);
    monitorBytes.set(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)), 2);
    // This key is deliberately not a live independent monitor. The POC gate
    // records 'poc-local' instead of claiming an external coverage signature.
    const monitorPublicKey = `did:key:${base58btc.encode(monitorBytes)}`;
    await this.sql.begin(async (tx) => {
      const created = await tx`INSERT INTO provider_accounts
        (id, tenant_id, canonical_address, onboarding_state)
        VALUES (${accountId}, ${randomUUID()}, ${address}, 'reserved')
        ON CONFLICT (canonical_address) DO NOTHING RETURNING id`;
      if (created.length !== 1) throw new Error("POC address is already reserved");
      for (const key of generated.keys.filter((entry) => profile === "managed" || entry.role !== "hail-identity")) {
        await tx`INSERT INTO account_keys
          (account_id, role, algorithm, public_key, encrypted_private_key,
           encryption_nonce, encryption_version, kek_id)
          VALUES (${accountId}, ${key.role}, ${key.algorithm}, ${key.publicKey},
            ${key.ciphertext}, ${key.nonce}, ${key.encryptionVersion}, ${key.kekId})`;
      }
      await tx`INSERT INTO private_poc_onboarding_preparations
        (account_id, user_recovery_public_key, user_identity_public_key,
         provider_rotation_public_key, provider_messaging_public_key,
           monitor_public_key, backup_checked_at,custody_profile,managed_profile_version,signup_token_hash)
        VALUES (${accountId}, ${recovery}, ${identity}, ${generated.rotationDidKey},
          ${generated.messagingDidKey}, ${monitorPublicKey}, clock_timestamp(),${profile},
          ${profile === "managed" ? MANAGED_CUSTODY_PROFILE_VERSION : null},${signupHash ?? null})`;
    });
    return { accountId, address, userRecoveryKey: recovery, userIdentityKey: identity, custodyProfile: profile,
      managedProfileVersion: profile === "managed" ? MANAGED_CUSTODY_PROFILE_VERSION : null,
      providerRotationKey: generated.rotationDidKey,
      providerMessagingKey: generated.messagingDidKey, sourceServiceBase: this.serviceBase };
  }

  async register(accountId: string, operationBytes: Uint8Array,
     bindingCose: Uint8Array): Promise<{ did: string; state: string }> {
    if (operationBytes.length < 1 || operationBytes.length > 16_000 ||
      bindingCose.length > 16_384) {
      throw new Error("Signed POC onboarding evidence exceeds its limit");
    }
    const rows = await this.sql<PreparationRow[]>`
      SELECT account_id, user_recovery_public_key, user_identity_public_key,custody_profile,signup_token_hash,
        provider_rotation_public_key, provider_messaging_public_key, monitor_public_key
      FROM private_poc_onboarding_preparations WHERE account_id = ${accountId}`;
    const prepared = rows[0];
    if (!prepared) throw new Error("POC provider key preparation does not exist");
    const repository = new OnboardingRepository(this.sql);
    let account = await repository.getAccount(accountId);
    const operation = def.operation.parse(parseJsonWithoutDuplicateKeys(
      new TextDecoder("utf-8", { fatal: true }).decode(operationBytes)));
    const expected = {
      type: "plc_operation", prev: null,
      rotationKeys: [prepared.user_recovery_public_key, prepared.provider_rotation_public_key],
      verificationMethods: { "hail-identity": prepared.user_identity_public_key,
        "hail-messaging": prepared.provider_messaging_public_key },
      alsoKnownAs: [], services: { hail: { type: "HailMessaging", endpoint: this.serviceBase } },
    };
    if (operation.prev !== null || !isDeepStrictEqual({
      type: operation.type, prev: operation.prev, rotationKeys: operation.rotationKeys,
      verificationMethods: operation.verificationMethods, alsoKnownAs: operation.alsoKnownAs,
      services: operation.services,
    }, expected)) throw new Error("Signed POC genesis does not match the prepared user/provider keys");
    await assureValidSig([prepared.user_recovery_public_key], operation);
    const did = await didForCreateOp(operation);
    const dagCborBytes = new Uint8Array(dagCbor.encode(operation));
    const operationCid = (await cidForCbor(operation)).toString();
    const state = { did, rotationKeys: operation.rotationKeys,
      verificationMethods: operation.verificationMethods,
      alsoKnownAs: operation.alsoKnownAs, services: operation.services };
    if (!isDeepStrictEqual(await validateOperationLog(did, [operation]), state)) {
      throw new Error("User-signed POC genesis has invalid PLC state");
    }
    const keyId = `${did}#hail-identity`;
    if (prepared.custody_profile === "managed") {
      const cached = await this.sql<{ initial_binding_cose: Uint8Array | null }[]>`
        SELECT initial_binding_cose FROM private_poc_onboarding_preparations WHERE account_id=${accountId}`;
      if (!cached[0]?.initial_binding_cose) {
        const key = await repository.getKey(accountId,"hail-identity");
        const secret = await this.encryptor.decrypt(accountId,key.role,key.algorithm,key.publicKey,key);
        let signed: Uint8Array;
        try { const now = Math.floor(Date.now()/1000); signed = await signPayload("hail.address-binding",
          { type: "hail.address-binding",version:1,address:account.canonicalAddress,did,issued_at:now,
            expires_at:now+90*86400,key_id:keyId },createWebCryptoSigner(keyId,await importEd25519PrivateKey(secret))); }
        finally { secret.fill(0); }
        await this.sql`UPDATE private_poc_onboarding_preparations SET initial_binding_cose=${signed}
          WHERE account_id=${accountId} AND initial_binding_cose IS NULL`;
      }
      const stored = await this.sql<{ initial_binding_cose: Uint8Array }[]>`
        SELECT initial_binding_cose FROM private_poc_onboarding_preparations WHERE account_id=${accountId}`;
      if (bindingCose.length && !Buffer.from(bindingCose).equals(Buffer.from(stored[0]!.initial_binding_cose))) throw new Error("Managed binding retry changed bytes");
      bindingCose = new Uint8Array(stored[0]!.initial_binding_cose);
    }
    const binding = await verifySignedPayload("hail.address-binding", bindingCose,
      createWebCryptoVerifier(async (kid) => {
        if (kid !== keyId) throw new Error("Address Binding has another identity signer");
        return ed25519PublicKeyFromDidKey(prepared.user_identity_public_key);
      }));
    if (binding.payload.did !== did || binding.payload.key_id !== keyId ||
      binding.payload.address !== account.canonicalAddress ||
      binding.payload.expires_at <= Math.floor(Date.now() / 1000)) {
      throw new Error("User-signed binding does not select the prepared DID and address");
    }
    const digest = new Uint8Array(createHash("sha256").update(bindingCose).digest());
    if (account.state === "reserved") {
      await this.sql.begin(async (tx) => {
        const changed = await tx`UPDATE provider_accounts
          SET did = ${did}, onboarding_state = 'prepared', state_version = state_version + 1,
            updated_at = clock_timestamp()
          WHERE id = ${accountId} AND did IS NULL AND onboarding_state = 'reserved' RETURNING id`;
        if (changed.length !== 1) throw new Error("POC account preparation changed");
        await tx`INSERT INTO plc_operation_evidence
          (id, account_id, did, operation_cid, registry_origin, signed_operation,
           signed_operation_bytes, dag_cbor, expected_state, submission_state)
          VALUES (${randomUUID()}, ${accountId}, ${did}, ${operationCid}, ${this.registryOrigin},
            ${JSON.stringify(operation)}::jsonb, ${operationBytes}, ${dagCborBytes},
            ${JSON.stringify(state)}::jsonb, 'prepared')`;
        if (prepared.custody_profile === "managed") {
          await tx`INSERT INTO managed_custody_evidence
            (account_id,owner_recovery_public_key,provider_identity_public_key,verification_mode,managed_profile_version)
            VALUES (${accountId},${prepared.user_recovery_public_key},${prepared.user_identity_public_key},'poc-local',
              ${MANAGED_CUSTODY_PROFILE_VERSION})`;
        } else await tx`INSERT INTO portable_custody_evidence
          (account_id, user_recovery_public_key, user_identity_public_key,
           monitor_origin, monitor_public_key, monitor_confirmed_at,
           backup_confirmed_at, monitor_verification_mode)
          VALUES (${accountId}, ${prepared.user_recovery_public_key},
            ${prepared.user_identity_public_key}, ${new URL(this.serviceBase).origin},
            ${prepared.monitor_public_key}, clock_timestamp(), clock_timestamp(), 'poc-local')`;
      });
      account = await repository.getAccount(accountId);
    }
    if (account.did !== did) throw new Error("POC account is already bound to another DID");
    const genesis = await repository.getGenesis(accountId);
    if (genesis.operationCid !== operationCid ||
      !Buffer.from(genesis.operationBytes).equals(Buffer.from(operationBytes))) {
      throw new Error("POC genesis retry does not match the immutable signed operation");
    }
    if (account.state === "prepared" || account.state === "submission-unknown") {
      const current = await this.plc.getOperationLog(did).catch((error) => {
        if (isPlcNotFound(error)) return null;
        throw error;
      });
      if (current?.[0] && (await cidForCbor(current[0])).toString() !== operationCid) {
        throw new Error("Private PLC DID was occupied by another genesis");
      }
      if (!current?.[0]) {
        if (account.state === "prepared") await repository.beginSubmission(accountId);
        try { await this.plc.sendOperation(did, operation as Operation); }
        catch (error) {
          const retry = await this.plc.getOperationLog(did).catch((readError) => {
            if (isPlcNotFound(readError)) return null;
            throw readError;
          });
          if (!retry?.[0] || (await cidForCbor(retry[0])).toString() !== operationCid) {
            throw new Error("Private PLC registration is ambiguous; retry the exact signed operation", { cause: error });
          }
        }
      }
      const readback = await verifyRegisteredGenesis({ client: this.plc, did, cid: operationCid,
        operation: operation as Operation, dagCbor: dagCborBytes, expectedState: state });
      await repository.markDidRegistered(accountId, readback);
      account = await repository.getAccount(accountId);
    }
    if (account.state === "did-registered") {
      await repository.stageAddressBinding({ accountId, bindingId: randomUUID(),
        address: account.canonicalAddress, did, cose: bindingCose, digest,
        issuedAt: new Date(binding.payload.issued_at * 1000),
        expiresAt: new Date(binding.payload.expires_at * 1000) });
      account = await repository.getAccount(accountId);
    }
    if (account.state !== "address-staged" && account.state !== "active") {
      throw new Error("POC identity did not reach a stageable address state");
    }
    const storedBinding = await repository.getBindingForAccount(accountId, digest);
    if (!Buffer.from(storedBinding.cose).equals(Buffer.from(bindingCose)) ||
      !Buffer.from(storedBinding.digest).equals(Buffer.from(digest))) {
      throw new Error("POC onboarding retry changed the user's signed Address Binding");
    }
    return { did, state: account.state };
  }
}
