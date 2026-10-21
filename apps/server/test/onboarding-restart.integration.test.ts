import { randomUUID } from "node:crypto";
import { formatDidDoc, PlcClientError, type DocumentData, type Operation } from "@did-plc/lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProviderDatabase } from "../src/db/database.js";
import { KeyEncryptor } from "../src/identity/key-encryption.js";
import { OnboardingRepository } from "../src/onboarding/repository.js";
import { OnboardingService } from "../src/onboarding/service.js";
import type { PlcDirectoryClient } from "../src/plc/client.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
const origin = "https://restart.example.com";
const plcOrigin = "http://plc.restart.test:2582";

function directory(mode: "persist-then-lose" | "retry-after-loss" | "collision") {
  let published: { did: string; operation: Operation } | null = null;
  let suppressRead = false;
  let sends = 0;
  const submitted: Operation[] = [];
  const client: PlcDirectoryClient = {
    health: async () => ({ version: "fixture" }),
    getOperationLog: async (did) => {
      if (mode === "collision" && published) {
        return [{ ...published.operation, alsoKnownAs: ["https://other.example"] }];
      }
      if (suppressRead) { suppressRead = false; throw new Error("Temporary PLC read failure"); }
      if (!published || published.did !== did) throw new PlcClientError(404, null, "DID not found");
      return [published.operation];
    },
    getDocumentData: async () => {
      if (!published) throw new Error("DID not registered");
      return state(published.did, published.operation);
    },
    getDocument: async () => {
      if (!published) throw new Error("DID not registered");
      return formatDidDoc(state(published.did, published.operation));
    },
    getAuditableLog: async (did) => {
      if (!published || published.did !== did) throw new Error("DID not registered");
      const { cidForCbor } = await import("@atproto/common");
      return [{ did, operation: published.operation, cid: (await cidForCbor(published.operation)).toString(),
        nullified: false, createdAt: new Date().toISOString() }];
    },
    sendOperation: async (did, operation) => {
      sends += 1;
      submitted.push(operation);
      if (mode === "retry-after-loss" && sends === 1) throw new Error("PLC request timed out before submission");
      published = { did, operation };
      if (mode === "persist-then-lose" && sends === 1) {
        suppressRead = true;
        throw new Error("PLC stored genesis, but response was lost");
      }
    },
  };
  return {
    client, submitted,
    get sends() { return sends; },
    occupy(did: string, operation: Operation) { published = { did, operation }; },
  };
}

function state(did: string, operation: Operation): DocumentData {
  return { did, rotationKeys: operation.rotationKeys, verificationMethods: operation.verificationMethods,
    alsoKnownAs: operation.alsoKnownAs, services: operation.services };
}

integration("durable PLC onboarding after ambiguous submission", () => {
  let database: ProviderDatabase;
  const addresses: string[] = [];
  const encryptor = new KeyEncryptor("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

  const address = () => {
    const value = `restart-${randomUUID()}@restart.example.com`;
    addresses.push(value);
    return value;
  };
  const service = (client: PlcDirectoryClient) => new OnboardingService(
    new OnboardingRepository(database.sql), client, encryptor,
    origin, `${origin}/hail`, plcOrigin,
  );

  beforeAll(async () => {
    const { ProviderDatabase } = await import("../src/db/database.js");
    database = new ProviderDatabase(process.env.DATABASE_URL!);
    await database.migrate();
  });

  afterAll(async () => {
    if (!database) return;
    for (const canonicalAddress of addresses) {
      const rows = await database.sql<{ id: string }[]>`
        SELECT id FROM provider_accounts WHERE canonical_address = ${canonicalAddress}
      `;
      if (!rows[0]) continue;
      const id = rows[0].id;
      await database.sql`DELETE FROM address_bindings WHERE account_id = ${id}`;
      await database.sql`DELETE FROM plc_operation_evidence WHERE account_id = ${id}`;
      await database.sql`DELETE FROM account_keys WHERE account_id = ${id}`;
      await database.sql`DELETE FROM provider_accounts WHERE id = ${id}`;
    }
    await database.close();
  });

  it("reconciles persisted genesis after a lost response without another PLC submission", async () => {
    const canonicalAddress = address();
    const plc = directory("persist-then-lose");
    await expect(service(plc.client).onboard(canonicalAddress)).rejects.toThrow("Temporary PLC read failure");
    const repository = new OnboardingRepository(database.sql);
    const account = await repository.getAccountByAddress(canonicalAddress);
    expect(account.state).toBe("submission-unknown");
    const before = await repository.getGenesis(account.id);
    const key = await repository.getKey(account.id, "hail-identity");
    expect(plc.sends).toBe(1);

    // A new repository and service instance simulate process restart over the same DB.
    const resumed = await service(plc.client).onboard(canonicalAddress);
    expect(resumed.state).toBe("address-staged");
    expect(resumed.did).toBe(before.did);
    expect(plc.sends).toBe(1);
    const after = await repository.getGenesis(account.id);
    expect(after.operationCid).toBe(before.operationCid);
    expect(after.operationBytes).toEqual(before.operationBytes);
    expect(after.dagCbor).toEqual(before.dagCbor);
    expect((await repository.getKey(account.id, "hail-identity")).ciphertext).toEqual(key.ciphertext);
    expect((await service(plc.client).onboard(canonicalAddress)).did).toBe(before.did);
    expect(plc.sends).toBe(1);
  });

  it("retries the exact persisted signed operation when the first PLC write never committed", async () => {
    const canonicalAddress = address();
    const plc = directory("retry-after-loss");
    await expect(service(plc.client).onboard(canonicalAddress)).rejects.toThrow("result remains unknown");
    const repository = new OnboardingRepository(database.sql);
    const account = await repository.getAccountByAddress(canonicalAddress);
    expect(account.state).toBe("submission-unknown");
    const before = await repository.getGenesis(account.id);
    const resumed = await service(plc.client).onboard(canonicalAddress);
    expect(resumed.state).toBe("address-staged");
    expect(plc.sends).toBe(2);
    expect(plc.submitted[1]).toEqual(plc.submitted[0]);
    const after = await repository.getGenesis(account.id);
    expect(after.operationCid).toBe(before.operationCid);
    expect(after.operationBytes).toEqual(before.operationBytes);
    expect(after.dagCbor).toEqual(before.dagCbor);
  });

  it("refuses a different genesis at the persisted DID before attempting any write", async () => {
    const canonicalAddress = address();
    const plc = directory("collision");
    const repository = new OnboardingRepository(database.sql);
    const account = await repository.reserve(canonicalAddress);
    const { generateAccountKeys } = await import("../src/identity/keys.js");
    const { prepareGenesis } = await import("../src/plc/genesis.js");
    const keys = await generateAccountKeys(account.id, encryptor);
    const genesis = await prepareGenesis({ rotationKey: keys.rotationKey,
      identityDidKey: keys.identityDidKey, messagingDidKey: keys.messagingDidKey,
      hailServiceBase: `${origin}/hail` });
    await repository.prepare(account, keys.keys, {
      id: randomUUID(), did: genesis.did, operationCid: genesis.cid,
      registryOrigin: plcOrigin, operationBytes: genesis.operationBytes,
      dagCbor: genesis.dagCbor, operation: genesis.operation, submissionState: "prepared",
    }, genesis.expectedState);
    plc.occupy(genesis.did, genesis.operation);
    await expect(service(plc.client).onboard(canonicalAddress)).rejects.toThrow("different genesis");
    expect(plc.sends).toBe(0);
    expect((await repository.getAccount(account.id)).state).toBe("prepared");
  });
});
