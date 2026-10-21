import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isIP } from "node:net";
import { cidForCbor } from "@atproto/common";
import { assureValidSig, def, didForCreateOp, validateOperationLog, type DocumentData, type Operation } from "@did-plc/lib";
import { createWebCryptoSigner, createWebCryptoVerifier, signPayload, verifySignedPayload } from "@hailproto/codec";
import * as dagCbor from "@ipld/dag-cbor";
import type { SQL } from "bun";
import type { AddressVerificationService } from "./activation.js";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import { canonicalizeHailAddress } from "../identity/address.js";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import type { KeyEncryptor } from "../identity/key-encryption.js";
import { generateAccountKeys, importEd25519PrivateKey } from "../identity/keys.js";
import { MANAGED_CUSTODY_PROFILE_VERSION, PLC_READ_EVIDENCE_POLICY_VERSION } from "../identity/managed-profile.js";
import { verifyOnboardingMonitorAttestation, type SignedMonitorAttestation } from "../migration/monitor-attestation.js";
import { requireFreshPublicAuthority } from "../plc/authority.js";
import type { PlcDirectoryClient } from "../plc/client.js";
import { isPlcNotFound } from "../plc/client.js";
import { plcStateDigest } from "../plc/read-evidence.js";
import type { HailDidResolver } from "../plc/resolver.js";
import { retainPublicSigningAuthority } from "../plc/signing-authority.js";
import { verifyRegisteredGenesis } from "../plc/verify.js";
import { OnboardingRepository } from "./repository.js";

interface PreparationRow {
  account_id: string;
  owner_recovery_public_key: string;
  owner_identity_public_key: string;
  provider_rotation_public_key: string;
  provider_messaging_public_key: string;
  monitor_origin: string;
  monitor_public_key: string;
  custody_profile: "owner-controlled" | "managed";
  managed_profile_version: typeof MANAGED_CUSTODY_PROFILE_VERSION | null;
  backup_confirmed_at: Date;
  signup_token_hash: Uint8Array | null;
}

export interface PublicOnboardingPreparation {
  accountId: string;
  address: string;
  userRecoveryKey: string;
  userIdentityKey: string;
  providerRotationKey: string;
  providerMessagingKey: string;
  sourceServiceBase: string;
  custodyProfile: "owner-controlled" | "managed";
  managedProfileVersion: typeof MANAGED_CUSTODY_PROFILE_VERSION | null;
  monitorOrigin: string;
  monitorPublicKey: string;
}

export class PublicOnboarding {
  constructor(private readonly sql: SQL, private readonly plc: PlcDirectoryClient,
    private readonly resolver: HailDidResolver, private readonly encryptor: KeyEncryptor,
    registryOrigin: string, private readonly serviceBase: string, private readonly verifier: AddressVerificationService) {
    if (registryOrigin !== "https://plc.directory" || serviceBase !== `${new URL(serviceBase).origin}/hail`) {
      throw new Error("Public onboarding requires canonical public PLC and provider Hail services");
    }
  }

  async prepare(addressInput: string, recovery: string, identity: string, backupChecked: boolean,
    profile: "owner-controlled" | "managed", monitorOrigin: string, monitorPublicKey: string,
    signupHash?: Uint8Array): Promise<PublicOnboardingPreparation> {
    if (!backupChecked || !recovery.startsWith("did:key:z") || !identity.startsWith("did:key:z") || recovery === identity) {
      throw new Error("Public onboarding needs a verified backup and distinct recovery/identity public keys");
    }
    await Promise.all([ed25519PublicKeyFromDidKey(identity), ed25519PublicKeyFromDidKey(monitorPublicKey)]);
    const monitor = new URL(monitorOrigin);
    if (monitor.protocol !== "https:" || monitor.origin !== monitorOrigin || isIP(monitor.hostname) !== 0 ||
      monitor.hostname === new URL(this.serviceBase).hostname) {
      throw new Error("Public onboarding requires an external canonical HTTPS monitor origin");
    }
    const address = canonicalizeHailAddress(addressInput);
    if (address.slice(address.indexOf("@") + 1) !== new URL(this.serviceBase).hostname) {
      throw new Error("Public onboarding address must belong to the provider domain");
    }
    const prior = await this.sql<(PreparationRow & { canonical_address: string; onboarding_state: string })[]>`
      SELECT preparation.*, account.canonical_address, account.onboarding_state
      FROM provider_accounts account JOIN public_onboarding_preparations preparation ON preparation.account_id = account.id
      WHERE account.canonical_address = ${address}`;
    if (prior[0]) {
      const row = prior[0];
      if (row.owner_recovery_public_key !== recovery || row.custody_profile !== profile ||
        row.monitor_origin !== monitorOrigin || row.monitor_public_key !== monitorPublicKey ||
        (profile === "owner-controlled" && row.owner_identity_public_key !== identity) ||
        (signupHash && (!row.signup_token_hash || !Buffer.from(row.signup_token_hash).equals(Buffer.from(signupHash)))) ||
        !["reserved", "prepared", "submission-unknown", "did-registered", "address-staged", "active"].includes(row.onboarding_state)) {
        throw new Error("Public address is prepared for different owner or monitor evidence");
      }
      return this.result(row, address);
    }
    const accountId = randomUUID(), generated = await generateAccountKeys(accountId, this.encryptor);
    if (profile === "managed") identity = generated.identityDidKey;
    await this.sql.begin(async tx => {
      const created = await tx`INSERT INTO provider_accounts (id, tenant_id, canonical_address, onboarding_state)
        VALUES (${accountId}, ${randomUUID()}, ${address}, 'reserved') ON CONFLICT (canonical_address) DO NOTHING RETURNING id`;
      if (created.length !== 1) throw new Error("Public address is already reserved");
      for (const key of generated.keys.filter(entry => profile === "managed" || entry.role !== "hail-identity")) {
        await tx`INSERT INTO account_keys (account_id, role, algorithm, public_key, encrypted_private_key,
          encryption_nonce, encryption_version, kek_id) VALUES (${accountId}, ${key.role}, ${key.algorithm}, ${key.publicKey},
          ${key.ciphertext}, ${key.nonce}, ${key.encryptionVersion}, ${key.kekId})`;
      }
      await tx`INSERT INTO public_onboarding_preparations (account_id, owner_recovery_public_key,
        owner_identity_public_key, provider_rotation_public_key, provider_messaging_public_key,
        monitor_origin, monitor_public_key, custody_profile, managed_profile_version, backup_confirmed_at, signup_token_hash)
        VALUES (${accountId}, ${recovery}, ${identity}, ${generated.rotationDidKey}, ${generated.messagingDidKey},
          ${monitorOrigin}, ${monitorPublicKey}, ${profile}, ${profile === "managed" ? MANAGED_CUSTODY_PROFILE_VERSION : null},
          clock_timestamp(), ${signupHash ?? null})`;
    });
    return { accountId, address, userRecoveryKey: recovery, userIdentityKey: identity,
      providerRotationKey: generated.rotationDidKey, providerMessagingKey: generated.messagingDidKey,
      sourceServiceBase: this.serviceBase, custodyProfile: profile,
      managedProfileVersion: profile === "managed" ? MANAGED_CUSTODY_PROFILE_VERSION : null, monitorOrigin, monitorPublicKey };
  }

  async register(accountId: string, operationBytes: Uint8Array, bindingCose: Uint8Array): Promise<{ did: string; state: string; operationCid: string }> {
    if (operationBytes.length < 1 || operationBytes.length > 16_000 || bindingCose.length > 16_384) {
      throw new Error("Signed public onboarding evidence exceeds its limit");
    }
    const prepared = (await this.sql<PreparationRow[]>`SELECT * FROM public_onboarding_preparations WHERE account_id=${accountId}`)[0];
    if (!prepared) throw new Error("Public provider key preparation does not exist");
    const repository = new OnboardingRepository(this.sql);
    let account = await repository.getAccount(accountId);
    const operation = def.operation.parse(parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(operationBytes)));
    const expected = { type: "plc_operation", prev: null,
      rotationKeys: [prepared.owner_recovery_public_key, prepared.provider_rotation_public_key],
      verificationMethods: { "hail-identity": prepared.owner_identity_public_key,
        "hail-messaging": prepared.provider_messaging_public_key }, alsoKnownAs: [],
      services: { hail: { type: "HailMessaging", endpoint: this.serviceBase } } };
    if (!isDeepStrictEqual({ type: operation.type, prev: operation.prev, rotationKeys: operation.rotationKeys,
      verificationMethods: operation.verificationMethods, alsoKnownAs: operation.alsoKnownAs,
      services: operation.services }, expected)) throw new Error("Signed public genesis differs from prepared owner/provider keys");
    await assureValidSig([prepared.owner_recovery_public_key], operation);
    const did = await didForCreateOp(operation), dagCborBytes = new Uint8Array(dagCbor.encode(operation));
    const operationCid = (await cidForCbor(operation)).toString();
    const state = { did, rotationKeys: operation.rotationKeys, verificationMethods: operation.verificationMethods,
      alsoKnownAs: operation.alsoKnownAs, services: operation.services };
    if (!isDeepStrictEqual(await validateOperationLog(did, [operation]), state)) throw new Error("Public genesis has invalid PLC state");
    const keyId = `${did}#hail-identity`;
    if (prepared.custody_profile === "managed") {
      let cached = (await this.sql<{ initial_binding_cose: Uint8Array | null }[]>`
        SELECT initial_binding_cose FROM public_onboarding_preparations WHERE account_id=${accountId}`)[0]?.initial_binding_cose;
      if (!cached) {
        const key = await repository.getKey(accountId, "hail-identity");
        const secret = await this.encryptor.decrypt(accountId, key.role, key.algorithm, key.publicKey, key);
        try { const now = Math.floor(Date.now() / 1000); cached = await signPayload("hail.address-binding",
          { type: "hail.address-binding", version: 1, address: account.canonicalAddress, did, issued_at: now,
            expires_at: now + 90 * 86400, key_id: keyId }, createWebCryptoSigner(keyId, await importEd25519PrivateKey(secret))); }
        finally { secret.fill(0); }
        await this.sql`UPDATE public_onboarding_preparations SET initial_binding_cose=${cached}
          WHERE account_id=${accountId} AND initial_binding_cose IS NULL`;
        cached = (await this.sql<{ initial_binding_cose: Uint8Array }[]>`
          SELECT initial_binding_cose FROM public_onboarding_preparations WHERE account_id=${accountId}`)[0]!.initial_binding_cose;
      }
      if (bindingCose.length && !Buffer.from(bindingCose).equals(Buffer.from(cached))) throw new Error("Managed binding retry changed bytes");
      bindingCose = new Uint8Array(cached);
    }
    const binding = await verifySignedPayload("hail.address-binding", bindingCose, createWebCryptoVerifier(async kid => {
      if (kid !== keyId) throw new Error("Address Binding has another identity signer");
      return ed25519PublicKeyFromDidKey(prepared.owner_identity_public_key);
    }));
    if (binding.payload.did !== did || binding.payload.address !== account.canonicalAddress ||
      binding.payload.key_id !== keyId || binding.payload.expires_at <= Math.floor(Date.now() / 1000)) {
      throw new Error("Address Binding does not select the prepared public identity");
    }
    const bindingDigest = new Uint8Array(createHash("sha256").update(bindingCose).digest());
    if (account.state === "reserved") {
      await this.sql.begin(async tx => {
        const changed = await tx`UPDATE provider_accounts SET did=${did}, onboarding_state='prepared',
          state_version=state_version+1, updated_at=clock_timestamp() WHERE id=${accountId} AND did IS NULL
          AND onboarding_state='reserved' RETURNING id`;
        if (changed.length !== 1) throw new Error("Public account preparation changed");
        await tx`INSERT INTO plc_operation_evidence (id, account_id, did, operation_cid, registry_origin,
          signed_operation, signed_operation_bytes, dag_cbor, expected_state, submission_state)
          VALUES (${randomUUID()}, ${accountId}, ${did}, ${operationCid}, 'https://plc.directory',
            ${JSON.stringify(operation)}::jsonb, ${operationBytes}, ${dagCborBytes}, ${JSON.stringify(state)}::jsonb, 'prepared')`;
      });
      account = await repository.getAccount(accountId);
    }
    if (account.did !== did) throw new Error("Public account is bound to another DID");
    const genesis = await repository.getGenesis(accountId);
    if (genesis.operationCid !== operationCid || !Buffer.from(genesis.operationBytes).equals(Buffer.from(operationBytes))) {
      throw new Error("Public genesis retry changed immutable signed bytes");
    }
    if (account.state === "prepared" || account.state === "submission-unknown") {
      const current = await this.plc.getOperationLog(did).catch(error => isPlcNotFound(error) ? null : Promise.reject(error));
      if (current?.[0] && (await cidForCbor(current[0])).toString() !== operationCid) throw new Error("Public DID has another genesis");
      if (!current?.[0]) {
        if (account.state === "prepared") await repository.beginSubmission(accountId);
        try { await this.plc.sendOperation(did, operation as Operation); }
        catch (error) {
          const retry = await this.plc.getOperationLog(did).catch(readError => isPlcNotFound(readError) ? null : Promise.reject(readError));
          if (!retry?.[0] || (await cidForCbor(retry[0])).toString() !== operationCid) {
            throw new Error("Public PLC registration is ambiguous; retry exact signed bytes", { cause: error });
          }
        }
      }
      const readback = await verifyRegisteredGenesis({ client: this.plc, did, cid: operationCid,
        operation: operation as Operation, dagCbor: dagCborBytes, expectedState: state as DocumentData });
      const strict = await this.resolver.resolve(did);
      if (strict.evidence.verification?.operationCid !== operationCid || strict.identityDidKey !== prepared.owner_identity_public_key ||
        strict.messagingDidKey !== prepared.provider_messaging_public_key || strict.serviceBase !== this.serviceBase) {
        throw new Error("Validated public reader does not confirm exact genesis authority");
      }
      await repository.markDidRegistered(accountId, readback);
      account = await repository.getAccount(accountId);
    }
    if (account.state === "did-registered") {
      await repository.stageAddressBinding({ accountId, bindingId: randomUUID(), address: account.canonicalAddress,
        did, cose: bindingCose, digest: bindingDigest, issuedAt: new Date(binding.payload.issued_at * 1000),
        expiresAt: new Date(binding.payload.expires_at * 1000) });
      account = await repository.getAccount(accountId);
    }
    if (account.state !== "address-staged" && account.state !== "active") throw new Error("Public identity is not ready for monitor activation");
    const stored = await repository.getBindingForAccount(accountId, bindingDigest);
    if (!Buffer.from(stored.cose).equals(Buffer.from(bindingCose))) throw new Error("Public binding retry changed signed bytes");
    return { did, state: account.state, operationCid };
  }

  async activate(accountId: string, signed: SignedMonitorAttestation): Promise<void> {
    const prepared = (await this.sql<PreparationRow[]>`SELECT * FROM public_onboarding_preparations WHERE account_id=${accountId}`)[0];
    if (!prepared) throw new Error("Public onboarding preparation does not exist");
    const repository = new OnboardingRepository(this.sql), account = await repository.getAccount(accountId);
    if (!account.did) throw new Error("Public DID is not registered");
    const existing = (await this.sql<{ monitor_payload: Uint8Array; monitor_signature: Uint8Array }[]>`
      SELECT monitor_payload, monitor_signature FROM public_onboarding_evidence WHERE account_id=${accountId}`)[0];
    if (existing) {
      if (!Buffer.from(existing.monitor_payload).equals(Buffer.from(signed.payloadBytes)) ||
        !Buffer.from(existing.monitor_signature).equals(Buffer.from(signed.signature))) throw new Error("Public activation retry changed monitor evidence");
      return;
    }
    const genesis = await repository.getGenesis(accountId), binding = await repository.getBindingForAccount(accountId);
    const monitor = await verifyOnboardingMonitorAttestation(signed, prepared.monitor_public_key, Math.floor(Date.now() / 1000));
    const expectedState = { did: account.did, rotationKeys: genesis.operation.rotationKeys,
      verificationMethods: genesis.operation.verificationMethods, alsoKnownAs: genesis.operation.alsoKnownAs,
      services: genesis.operation.services } as DocumentData;
    if (monitor.did !== account.did || monitor.operation_cid !== genesis.operationCid ||
      monitor.monitor_origin !== prepared.monitor_origin || monitor.bootstrap_state_digest !== plcStateDigest(expectedState)) {
      throw new Error("Monitor attestation does not match reviewed public genesis");
    }
    const attemptId = await repository.beginActivation(accountId, binding.id);
    try {
      const verified = await this.verifier.verify(account.canonicalAddress);
      if (verified.did !== account.did || verified.serviceBase !== this.serviceBase ||
        verified.messagingDidKey !== prepared.provider_messaging_public_key ||
        verified.plcEvidence.verification?.operationCid !== genesis.operationCid ||
        !isDeepStrictEqual(verified.plcEvidence.data, expectedState) ||
        !Buffer.from(verified.representation).equals(Buffer.from(binding.cose)) ||
        !Buffer.from(verified.digest).equals(Buffer.from(binding.digest))) throw new Error("Published identity differs from staged public account");
      await this.sql.begin(async tx => {
        const now = (await tx<{ instant: Date }[]>`SELECT clock_timestamp() AS instant`)[0]!.instant;
        const plcDigest = await requireFreshPublicAuthority(tx, verified.plcEvidence, {
          did: account.did!, role: "hail-messaging", key: prepared.provider_messaging_public_key, serviceBase: this.serviceBase }, now);
        if (!plcDigest) throw new Error("Public activation requires strict PLC authority evidence");
        await retainPublicSigningAuthority(tx, { actionType: "address-binding", localAccountId: accountId,
          did: account.did!, role: "hail-identity", key: prepared.owner_identity_public_key,
          serviceBase: this.serviceBase, representation: binding.cose, evidence: verified.plcEvidence });
        if (prepared.custody_profile === "managed") await tx`INSERT INTO managed_custody_evidence
          (account_id, owner_recovery_public_key, provider_identity_public_key, verification_mode, managed_profile_version)
          VALUES (${accountId}, ${prepared.owner_recovery_public_key}, ${prepared.owner_identity_public_key}, 'strict-public-v1',
            ${MANAGED_CUSTODY_PROFILE_VERSION})`;
        else await tx`INSERT INTO portable_custody_evidence (account_id, user_recovery_public_key,
          user_identity_public_key, monitor_origin, monitor_public_key, monitor_confirmed_at,
          backup_confirmed_at, monitor_verification_mode) VALUES (${accountId}, ${prepared.owner_recovery_public_key},
          ${prepared.owner_identity_public_key}, ${prepared.monitor_origin}, ${prepared.monitor_public_key},
          ${now}, ${prepared.backup_confirmed_at}, 'independent')`;
        await tx`INSERT INTO public_onboarding_evidence (account_id, did, operation_cid, genesis_digest,
          binding_digest, plc_evidence_digest, monitor_origin, monitor_public_key, monitor_payload,
          monitor_signature, monitor_state_digest, monitor_export_sequence, activated_at, record_version, read_evidence_policy_version)
          VALUES (${accountId}, ${account.did}, ${genesis.operationCid},
            ${new Uint8Array(createHash("sha256").update(genesis.operationBytes).digest())}, ${binding.digest}, ${plcDigest},
            ${prepared.monitor_origin}, ${prepared.monitor_public_key}, ${signed.payloadBytes}, ${signed.signature},
            ${monitor.bootstrap_state_digest}, ${monitor.export_sequence??null}, ${now}, 1, ${PLC_READ_EVIDENCE_POLICY_VERSION})`;
        const activated = await tx`UPDATE provider_accounts AS account SET onboarding_state='active', activated_at=${now},
          activation_binding_digest=${binding.digest}, activation_verification_mode='public', activation_attempt_id=NULL,
          state_version=state_version+1, updated_at=${now} FROM address_bindings AS selected
          WHERE account.id=${accountId} AND account.onboarding_state='activating' AND account.activation_attempt_id=${attemptId}
            AND selected.id=${binding.id} AND selected.account_id=account.id AND selected.selected_at IS NOT NULL
            AND selected.expires_at>${now} AND selected.representation_digest=${binding.digest} RETURNING account.id`;
        if (activated.length !== 1) throw new Error("Public account cannot be activated");
      });
    } catch (error) {
      await repository.cancelActivation(accountId, binding.id, attemptId);
      throw error;
    }
  }

  private result(row: PreparationRow, address: string): PublicOnboardingPreparation {
    return { accountId: row.account_id, address, userRecoveryKey: row.owner_recovery_public_key,
      userIdentityKey: row.owner_identity_public_key, providerRotationKey: row.provider_rotation_public_key,
      providerMessagingKey: row.provider_messaging_public_key, sourceServiceBase: this.serviceBase,
      custodyProfile: row.custody_profile, managedProfileVersion: row.managed_profile_version,
      monitorOrigin: row.monitor_origin, monitorPublicKey: row.monitor_public_key };
  }
}
