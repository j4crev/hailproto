import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { requireFreshPublicAuthority } from "./authority.js";
import type { PlcResolutionEvidence } from "./resolver.js";

export type PublicSigningAction = "address-binding" | "sender-profile" | "delivery-status";

export async function retainPublicSigningAuthority(
  sql: SQL,
  input: {
    actionType: PublicSigningAction;
    localAccountId: string;
    did: string;
    role: "hail-identity" | "hail-messaging";
    key: string;
    serviceBase: string;
    representation: Uint8Array;
    evidence: PlcResolutionEvidence;
  },
): Promise<void> {
  if (input.evidence.verification?.profile !== "strict-public-v1") return;
  const now = (await sql<{ instant: Date }[]>`SELECT clock_timestamp() AS instant`)[0]!.instant;
  const evidenceDigest = await requireFreshPublicAuthority(sql, input.evidence, input, now);
  const representationDigest = new Uint8Array(createHash("sha256").update(input.representation).digest());
  const inserted = await sql`
    INSERT INTO public_signing_authority_evidence (
      action_type, local_account_id, authority_did, authority_role,
      representation_digest, evidence_digest, committed_at
    ) VALUES (
      ${input.actionType}, ${input.localAccountId}, ${input.did}, ${input.role},
      ${representationDigest}, ${evidenceDigest!}, ${now}
    )
    ON CONFLICT (action_type, local_account_id, representation_digest) DO NOTHING
    RETURNING action_type
  `;
  if (inserted.length) return;
  const retained = (await sql<{
    authority_did: string;
    authority_role: string;
  }[]>`
    SELECT authority_did, authority_role
    FROM public_signing_authority_evidence
    WHERE action_type = ${input.actionType}
      AND local_account_id = ${input.localAccountId}
      AND representation_digest = ${representationDigest}
  `)[0];
  if (
    !retained ||
    retained.authority_did !== input.did ||
    retained.authority_role !== input.role
  ) {
    throw new Error("Public signing authority conflicts with retained action evidence");
  }
}
