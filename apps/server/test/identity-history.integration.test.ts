import {SQL} from "bun";
import {expect,it} from "vitest";
import {previousAddressIdentities} from "../src/accounts/identity-history.js";

it.skipIf(!process.env.DATABASE_URL)("compares saved consent and completed relationships without crossing accounts",async()=>{
  const sql=new SQL(process.env.DATABASE_URL!,{max:1});
  const owner="00000000-0000-4000-8000-000000000001",other="00000000-0000-4000-8000-000000000002";
  const old="did:plc:"+"a".repeat(24),next="did:plc:"+"b".repeat(24),stranger="did:plc:"+"c".repeat(24);
  try{await sql.begin(async tx=>{
    // Temporary tables exercise the actual query with distinct account/role and
    // lifecycle evidence. Existing approval suites exercise the full schema.
    await tx`CREATE TEMP TABLE grant_lineages(grant_id integer,local_account_id uuid,local_role text,grantee_did text) ON COMMIT DROP`;
    await tx`CREATE TEMP TABLE grant_consent_evidence(grant_id integer,grantee_address text) ON COMMIT DROP`;
    await tx`CREATE TEMP TABLE federated_connection_pairs(account_id uuid,peer_did text,peer_address text,state text) ON COMMIT DROP`;
    await tx`CREATE TEMP TABLE connection_handover_barriers(account_id uuid,moving_did text,destination_address text,state text) ON COMMIT DROP`;
    await tx`INSERT INTO grant_lineages VALUES(1,${owner},'grantor',${old}),(2,${other},'grantor',${stranger}),(3,${owner},'grantee',${stranger})`;
    await tx`INSERT INTO grant_consent_evidence VALUES(1,'friend@example.com'),(1,'friend@example.com'),(2,'friend@example.com'),(3,'friend@example.com')`;
    expect(await previousAddressIdentities(tx as unknown as SQL,owner,'friend@example.com',next)).toEqual([old]);
    expect(await previousAddressIdentities(tx as unknown as SQL,owner,'friend@example.com',old)).toEqual([]);
    expect(await previousAddressIdentities(tx as unknown as SQL,owner,'unseen@example.com',next)).toEqual([]);
    await tx`INSERT INTO federated_connection_pairs VALUES(${owner},${old},'former@example.com','disconnected'),(${owner},${stranger},'former@example.com','empty')`;
    expect(await previousAddressIdentities(tx as unknown as SQL,owner,'former@example.com',next)).toEqual([old]);
    await tx`INSERT INTO connection_handover_barriers VALUES(${owner},${old},'moved@example.com','completed'),(${owner},${stranger},'moved@example.com','frozen')`;
    expect(await previousAddressIdentities(tx as unknown as SQL,owner,'moved@example.com',next)).toEqual([old]);
  });}finally{await sql.close();}
});
