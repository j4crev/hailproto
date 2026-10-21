# PLC reader refactor

Hail is pre-alpha. This document tracks replacing synchronous mirror agreement
with the smallest read policy that matches PLC's actual trust model.

## Decision

PLC mirrors are replicas, not consensus participants. `plc.directory` remains
the canonical write and ordering authority. Reader/operator declarations can
prevent obvious configuration mistakes, but they cannot prove administrative
independence or that a reader response was obtained. Requiring two unsigned
replica responses to match therefore adds defense in depth against one broken
reader while making one outage block unrelated Hail work.

Routine resolution uses the canonical directory by default. Explicitly configured
readers remain ordered availability fallbacks. One bounded audit response is
authoritative only after local validation of the DID,
operation and audit logs, CIDs, recovery/nullification behavior, resulting state,
Hail keys and service endpoint. A failed, stale or malformed reader is skipped;
responses from different readers are never combined.

Sensitive transitions retain stronger checks that do not depend on mirror
voting: the exact user-authorized operation CID/state, canonical public registry
registration, and the applicable signed monitor attestation.

## Work

- [x] Replace routine two-reader unanimity with ordered validated fallback.
- [x] Allow one to three bounded HTTPS reader declarations.
- [x] Retain the selected reader's complete evidence before returning authority.
- [x] Reject per-DID history regression against previously retained audit evidence.
- [x] Refactor public cutover to one validated reader while preserving exact-CID,
      exact-state, bootstrap-checkpoint and monitor-attestation requirements.
- [x] Require a direct canonical readback where sensitive publication currently
      relies only on a replica.
- [x] Move multi-reader comparison to asynchronous structured-log diagnostics.
- [x] Update the pre-alpha protocol read-evidence text after the implementation and
      migration evidence formats settle.
- [x] Remove the operational requirement for a Hail-operated mirror.
- [x] Derive routine authority from one canonical `/log/audit` response.

## Non-goals

- Mirrors do not vote on canonical PLC state.
- Reader health timestamps are operational freshness signals, not signed proofs.
- Fallback does not authorize stale cached state.
- This does not claim that a provider-operated reader or monitor is independent.
