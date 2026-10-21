import { createHash, randomUUID } from "node:crypto";
import { createWebCryptoVerifier, verifySignedPayload } from "@hailproto/codec";
import type { SQL } from "bun";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import type { HailDidResolver } from "../plc/resolver.js";
import { PrivatePocCutoverGate } from "./poc-cutover-gate.js";
import { assertPrivatePocRegistry } from "./poc-profile.js";

export class PrivatePocAddressPublication {
  constructor(private readonly sql: SQL, private readonly resolver: HailDidResolver,
    private readonly gate: PrivatePocCutoverGate,
    registryOrigin: string, private readonly serviceBase: string) {
    assertPrivatePocRegistry(registryOrigin, serviceBase);
  }

  async publish(transferId: string): Promise<string> {
    const assessment = await this.gate.assess(transferId);
    const pending = await this.sql<{ did: string; destination_address: string;
      destination_binding_cose: Uint8Array; destination_binding_digest: Uint8Array;
      state: string }[]>`
      SELECT did, destination_address, destination_binding_cose,
        destination_binding_digest, state FROM pending_migration_imports
      WHERE transfer_id = ${transferId}`;
    const row = pending[0];
    if (!row || row.state !== "staged") throw new Error("Only an inactive POC import can publish its address");
    const resolved = await this.resolver.resolve(row.did);
    if (resolved.did !== row.did || resolved.serviceBase !== this.serviceBase ||
      assessment.operationCid !== (await this.gate.assess(transferId)).operationCid) {
      throw new Error("Private PLC no longer designates the pending target");
    }
    const checked = await verifySignedPayload("hail.address-binding", row.destination_binding_cose,
      createWebCryptoVerifier(async (kid) => {
        if (kid !== `${row.did}#hail-identity`) throw new Error("Binding has another DID signer");
        return ed25519PublicKeyFromDidKey(resolved.identityDidKey);
      }));
    const binding = checked.payload;
    const digest = new Uint8Array(createHash("sha256").update(row.destination_binding_cose).digest());
    if (binding.address !== row.destination_address || binding.did !== row.did ||
      binding.expires_at <= Math.floor(Date.now() / 1000) ||
      !Buffer.from(digest).equals(Buffer.from(row.destination_binding_digest))) {
      throw new Error("POC address selection does not match the signed target binding");
    }
    return this.sql.begin(async (tx) => {
      const current=await tx<{state:string}[]>`SELECT state FROM pending_migration_imports WHERE transfer_id=${transferId} FOR UPDATE`;
      if(current[0]?.state!=="staged")throw new Error("Address publication lost inactive staging authority");
      const reservations = await tx<{ reserved_account_id: string | null; state: string;
        canonical_address: string }[]>`
        SELECT reserved_account_id, state, canonical_address
        FROM transfer_address_reservations WHERE transfer_id = ${transferId} FOR UPDATE`;
      const reservation = reservations[0];
      if (!reservation?.reserved_account_id || reservation.state !== "submitted" ||
        reservation.canonical_address !== row.destination_address) {
        throw new Error("POC address was not durably reserved before source fencing");
      }
      const existing = await tx<{ id: string; cose: Uint8Array }[]>`
        SELECT id, cose FROM address_bindings WHERE account_id = ${reservation.reserved_account_id}
          AND canonical_address = ${row.destination_address} FOR UPDATE`;
      if (existing[0]) {
        if (!Buffer.from(existing[0].cose).equals(Buffer.from(row.destination_binding_cose))) {
          throw new Error("POC pending address was published with another binding");
        }
        return existing[0].id;
      }
      const id = randomUUID();
      await tx`INSERT INTO address_bindings
        (id, account_id, canonical_address, did, cose, representation_digest,
         issued_at, expires_at, hosted_at, selected_at, published_at)
        VALUES (${id}, ${reservation.reserved_account_id}, ${row.destination_address},
          ${row.did}, ${row.destination_binding_cose}, ${digest},
          ${new Date(binding.issued_at * 1000)}, ${new Date(binding.expires_at * 1000)},
          clock_timestamp(), clock_timestamp(), clock_timestamp())`;
      return id;
    });
  }
}
