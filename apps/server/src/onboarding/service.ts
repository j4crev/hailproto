import { createHash } from "node:crypto";
import { cidForCbor } from "@atproto/common";
import {
  createWebCryptoSigner,
  createWebCryptoVerifier,
  signPayload,
  verifySignedPayload,
  type HailAddressBinding,
} from "@hailproto/codec";
import {
  def,
  didForCreateOp,
  validateOperationLog,
  type DocumentData,
  type Operation,
} from "@did-plc/lib";
import * as dagCbor from "@ipld/dag-cbor";
import { isDeepStrictEqual } from "node:util";
import { canonicalizeHailAddress } from "../identity/address.js";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import { KeyEncryptor } from "../identity/key-encryption.js";
import { generateAccountKeys, importEd25519PrivateKey } from "../identity/keys.js";
import { isPlcNotFound, type PlcDirectoryClient } from "../plc/client.js";
import { prepareGenesis } from "../plc/genesis.js";
import { verifyRegisteredGenesis } from "../plc/verify.js";
import {
  OnboardingRepository,
  type AccountRecord,
  type GenesisEvidence,
} from "./repository.js";

const BINDING_LIFETIME_SECONDS = 90 * 24 * 60 * 60;

export interface OnboardingResult {
  accountId: string;
  tenantId: string;
  address: string;
  did: string;
  state: AccountRecord["state"];
}

function operationFromEvidence(evidence: GenesisEvidence): Operation {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(evidence.operationBytes));
  return def.operation.parse(parsed);
}

function expectedState(did: string, operation: Operation): DocumentData {
  return {
    did,
    rotationKeys: operation.rotationKeys,
    verificationMethods: operation.verificationMethods,
    alsoKnownAs: operation.alsoKnownAs,
    services: operation.services,
  };
}

export class OnboardingService {
  constructor(
    private readonly repository: OnboardingRepository,
    private readonly plc: PlcDirectoryClient,
    private readonly encryptor: KeyEncryptor,
    private readonly publicOrigin: string,
    private readonly hailServiceBase: string,
    private readonly plcDirectoryUrl: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async onboard(addressInput: string): Promise<OnboardingResult> {
    const address = canonicalizeHailAddress(addressInput);
    const addressDomain = address.slice(address.indexOf("@") + 1);
    if (addressDomain !== new URL(this.publicOrigin).hostname) {
      throw new Error("Hail address domain must match PUBLIC_ORIGIN");
    }

    let account = await this.repository.reserve(address);
    if (account.state === "reserved") {
      const keys = await generateAccountKeys(account.id, this.encryptor);
      const genesis = await prepareGenesis({
        rotationKey: keys.rotationKey,
        identityDidKey: keys.identityDidKey,
        messagingDidKey: keys.messagingDidKey,
        hailServiceBase: this.hailServiceBase,
      });
      await this.repository.prepare(
        account,
        keys.keys,
        {
          id: crypto.randomUUID(),
          did: genesis.did,
          operationCid: genesis.cid,
          registryOrigin: this.plcDirectoryUrl,
          operationBytes: genesis.operationBytes,
          dagCbor: genesis.dagCbor,
          operation: genesis.operation,
          submissionState: "prepared",
        },
        genesis.expectedState,
      );
      account = await this.repository.getAccount(account.id);
    }

    if (account.state === "prepared" || account.state === "submission-unknown") {
      await this.registerDid(account);
      account = await this.repository.getAccount(account.id);
    }

    if (account.state === "did-registered") {
      await this.createAddressBinding(account);
      account = await this.repository.getAccount(account.id);
    }

    if (!account.did) throw new Error("Onboarding account has no DID");
    return {
      accountId: account.id,
      tenantId: account.tenantId,
      address: account.canonicalAddress,
      did: account.did,
      state: account.state,
    };
  }

  private async registerDid(account: AccountRecord): Promise<void> {
    const evidence = await this.repository.getGenesis(account.id);
    await this.validatePersistedGenesis(account, evidence);
    if (evidence.registryOrigin !== this.plcDirectoryUrl) {
      throw new Error("Persisted PLC registry does not match PLC_DIRECTORY_URL");
    }
    if (await this.reconcileGenesis(account.id, evidence)) return;

    await this.repository.beginSubmission(account.id);
    const operation = operationFromEvidence(evidence);
    try {
      await this.plc.sendOperation(evidence.did, operation);
    } catch (error) {
      if (await this.reconcileGenesis(account.id, evidence)) return;
      throw new Error("PLC submission result remains unknown", { cause: error });
    }
    if (!(await this.reconcileGenesis(account.id, evidence))) {
      throw new Error("PLC accepted submission but genesis could not be reconciled");
    }
  }

  private async reconcileGenesis(accountId: string, evidence: GenesisEvidence): Promise<boolean> {
    let log;
    try {
      log = await this.plc.getOperationLog(evidence.did);
    } catch (error) {
      if (isPlcNotFound(error)) return false;
      throw error;
    }
    const first = log[0];
    if (!first) throw new Error("PLC returned an empty operation log for an existing DID");
    const returnedCid = (await cidForCbor(first)).toString();
    if (returnedCid !== evidence.operationCid) {
      throw new Error("PLC DID is occupied by a different genesis operation");
    }
    const operation = operationFromEvidence(evidence);
    const readback = await verifyRegisteredGenesis({
      client: this.plc,
      did: evidence.did,
      cid: evidence.operationCid,
      operation,
      dagCbor: evidence.dagCbor,
      expectedState: expectedState(evidence.did, operation),
    });
    await this.repository.markDidRegistered(accountId, readback);
    return true;
  }

  private async validatePersistedGenesis(
    account: AccountRecord,
    evidence: GenesisEvidence,
  ): Promise<void> {
    if (account.did !== evidence.did) {
      throw new Error("Account DID does not match persisted genesis evidence");
    }
    const operation = operationFromEvidence(evidence);
    const encoded = new Uint8Array(dagCbor.encode(operation));
    if (!Buffer.from(encoded).equals(Buffer.from(evidence.dagCbor))) {
      throw new Error("Persisted genesis DAG-CBOR does not match operation bytes");
    }
    if ((await cidForCbor(operation)).toString() !== evidence.operationCid) {
      throw new Error("Persisted genesis CID does not match operation bytes");
    }
    if ((await didForCreateOp(operation)) !== evidence.did) {
      throw new Error("Persisted genesis DID does not match operation bytes");
    }
    const validated = await validateOperationLog(evidence.did, [operation]);
    if (!isDeepStrictEqual(validated, expectedState(evidence.did, operation))) {
      throw new Error("Persisted genesis operation does not validate to expected state");
    }
  }

  private async createAddressBinding(account: AccountRecord): Promise<void> {
    if (!account.did) throw new Error("Cannot create an Address Binding before DID registration");
    const key = await this.repository.getKey(account.id, "hail-identity");
    if (key.algorithm !== "ed25519") throw new Error("Hail identity key must use Ed25519");
    const privateBytes = await this.encryptor.decrypt(
      account.id,
      key.role,
      key.algorithm,
      key.publicKey,
      key,
    );
    const privateKey = await importEd25519PrivateKey(privateBytes);
    const issuedAt = Math.floor(this.now().getTime() / 1_000);
    const expiresAt = issuedAt + BINDING_LIFETIME_SECONDS;
    const keyId = `${account.did}#hail-identity`;
    const payload: HailAddressBinding = {
      version: 1,
      type: "hail.address-binding",
      address: account.canonicalAddress,
      did: account.did,
      issued_at: issuedAt,
      expires_at: expiresAt,
      key_id: keyId,
    };
    const cose = await signPayload(
      "hail.address-binding",
      payload,
      createWebCryptoSigner(keyId, privateKey),
    );
    const publicKey = await ed25519PublicKeyFromDidKey(key.publicKey);
    await verifySignedPayload(
      "hail.address-binding",
      cose,
      createWebCryptoVerifier(async (requestedKeyId) => {
        if (requestedKeyId !== keyId) throw new Error("Unexpected Address Binding key ID");
        return publicKey;
      }),
    );
    const digest = new Uint8Array(createHash("sha256").update(cose).digest());

    await this.repository.stageAddressBinding({
      accountId: account.id,
      bindingId: crypto.randomUUID(),
      address: account.canonicalAddress,
      did: account.did,
      cose,
      digest,
      issuedAt: new Date(issuedAt * 1_000),
      expiresAt: new Date(expiresAt * 1_000),
    });
  }
}
