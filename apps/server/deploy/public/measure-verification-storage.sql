-- Aggregate-only production diagnostic. No application data or schema changes.
-- Run with psql -X -v ON_ERROR_STOP=1. Sizes are allocated bytes, not bloat.
\pset pager off
\timing on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '2s';
SET LOCAL TIME ZONE 'UTC';

SELECT current_timestamp AS measured_at_utc,
       pg_database_size(current_database()) AS database_bytes;

-- Same evidence-table membership as operator/storage.ts in the current schema.
SELECT c.relname AS table_name,
       pg_table_size(c.oid) AS table_bytes,
       pg_indexes_size(c.oid) AS index_bytes,
       pg_total_relation_size(c.oid) AS total_bytes
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN (
  'public_plc_resolution_evidence', 'public_envelope_authority_evidence',
  'public_grant_authority_evidence', 'public_signing_authority_evidence',
  'public_onboarding_evidence', 'plc_operation_evidence', 'connection_proof_signatures'
) ORDER BY total_bytes DESC;

SELECT 'public_plc_resolution_evidence' AS table_name, count(*) AS rows FROM public_plc_resolution_evidence
UNION ALL SELECT 'public_envelope_authority_evidence', count(*) FROM public_envelope_authority_evidence
UNION ALL SELECT 'public_grant_authority_evidence', count(*) FROM public_grant_authority_evidence
UNION ALL SELECT 'public_signing_authority_evidence', count(*) FROM public_signing_authority_evidence
UNION ALL SELECT 'public_onboarding_evidence', count(*) FROM public_onboarding_evidence
UNION ALL SELECT 'plc_operation_evidence', count(*) FROM plc_operation_evidence
UNION ALL SELECT 'connection_proof_signatures', count(*) FROM connection_proof_signatures;

SELECT count(*) AS observations, count(DISTINCT did) AS dids,
       count(DISTINCT (did, operation_cid)) AS did_head_pairs,
       min(verified_at) AS oldest_observation, max(verified_at) AS newest_observation,
       sum(octet_length(bundle_bytes)) AS logical_bundle_bytes,
       round(avg(octet_length(bundle_bytes))) AS average_logical_bundle_bytes,
       max(octet_length(bundle_bytes)) AS largest_logical_bundle_bytes,
       sum(pg_column_size(bundle_bytes)) AS stored_bundle_datum_bytes
FROM public_plc_resolution_evidence;

-- Same head does NOT prove identical full audit (nullified branches can differ).
-- These groups identify repetition candidates, not safely deletable records.
SELECT count(*) AS did_head_pairs, sum(observations) AS observations,
       max(observations) AS most_observations_for_one_head,
       sum(observations - 1) AS observations_beyond_first_per_head
FROM (SELECT did, operation_cid, count(*) AS observations
      FROM public_plc_resolution_evidence GROUP BY did, operation_cid) heads;

-- Observation dates, not insertion dates: imported history can predate import.
SELECT verified_at::date AS observation_day_utc, count(*) AS observations,
       count(DISTINCT did) AS dids, sum(octet_length(bundle_bytes)) AS logical_bundle_bytes
FROM public_plc_resolution_evidence
GROUP BY verified_at::date ORDER BY observation_day_utc DESC LIMIT 31;

-- Partial reference coverage only. JSON authority, signed snapshots, and the
-- latest per-DID regression checkpoint also matter; this is NOT a GC predicate.
WITH linked AS (
  SELECT evidence_digest FROM public_envelope_authority_evidence
  UNION SELECT evidence_digest FROM public_grant_authority_evidence
  UNION SELECT evidence_digest FROM public_signing_authority_evidence
  UNION SELECT plc_evidence_digest FROM public_onboarding_evidence
)
SELECT (linked.evidence_digest IS NOT NULL) AS referenced_by_four_action_tables,
       count(*) AS observations, sum(octet_length(e.bundle_bytes)) AS logical_bundle_bytes
FROM public_plc_resolution_evidence e LEFT JOIN linked USING (evidence_digest)
GROUP BY (linked.evidence_digest IS NOT NULL);

SELECT count(*) AS proofs, sum(octet_length(cose)) AS signed_proof_bytes,
       sum(pg_column_size(authority)) AS stored_authority_datum_bytes
FROM connection_proof_signatures;
COMMIT;
