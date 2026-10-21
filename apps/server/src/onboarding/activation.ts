import { isDeepStrictEqual } from "node:util";
import type { VerifiedAddress } from "../discovery/verifier.js";
import type { AccountKeyRecord, AccountRecord } from "./repository.js";
import type { PublishedAddressBinding } from "../discovery/store.js";

export interface ActivationRepository {
  getAccount(accountId: string): Promise<AccountRecord>;
  getBindingForAccount(accountId: string): Promise<PublishedAddressBinding>;
  getKey(accountId: string, role: AccountKeyRecord["role"]): Promise<AccountKeyRecord>;
  beginActivation(accountId: string, bindingId: string): Promise<string>;
  cancelActivation(accountId: string, bindingId: string, attemptId: string): Promise<void>;
  activateAccount(
    accountId: string,
    bindingId: string,
    bindingDigest: Uint8Array,
    attemptId: string,
    verificationMode: "local" | "public",
  ): Promise<void>;
  promoteActivation(accountId: string, bindingId: string, bindingDigest: Uint8Array): Promise<void>;
}

export interface AddressVerificationService {
  verify(address: string): Promise<VerifiedAddress>;
}

export class ActivationService {
  constructor(
    private readonly repository: ActivationRepository,
    private readonly verifier: AddressVerificationService,
    private readonly expectedServiceBase: string,
    private readonly verificationMode: "local" | "public",
  ) {}

  async activate(accountId: string): Promise<void> {
    const account = await this.repository.getAccount(accountId);
    if (
      account.state === "active" &&
      (account.activationVerificationMode === this.verificationMode ||
        account.activationVerificationMode === "public")
    ) {
      return;
    }
    const promoting =
      account.state === "active" &&
      account.activationVerificationMode === "local" &&
      this.verificationMode === "public";
    if (account.state === "active" && !promoting) {
      throw new Error("Account activation cannot be downgraded");
    }
    if ((account.state !== "address-staged" && account.state !== "activating") || !account.did) {
      if (!promoting) throw new Error("Account is not ready for activation");
    }
    const binding = await this.repository.getBindingForAccount(accountId);
    const messagingKey = await this.repository.getKey(accountId, "hail-messaging");
    const attemptId = promoting
      ? null
      : await this.repository.beginActivation(accountId, binding.id);
    try {
      const verified = await this.verifier.verify(account.canonicalAddress);
      if (
        verified.did !== account.did ||
        verified.serviceBase !== this.expectedServiceBase ||
        verified.messagingDidKey !== messagingKey.publicKey ||
        !isDeepStrictEqual(verified.representation, binding.cose) ||
        !isDeepStrictEqual(verified.digest, binding.digest)
      ) {
        throw new Error("Published identity does not match staged account state");
      }
      if (promoting) {
        await this.repository.promoteActivation(accountId, binding.id, binding.digest);
      } else {
        await this.repository.activateAccount(
          accountId,
          binding.id,
          binding.digest,
          attemptId!,
          this.verificationMode,
        );
      }
    } catch (error) {
      if (attemptId) await this.repository.cancelActivation(accountId, binding.id, attemptId);
      throw error;
    }
  }
}
