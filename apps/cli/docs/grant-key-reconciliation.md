# Grant historical-key reconciliation — milestone-4 decision

This defines the boundary before identity rotation over unacknowledged Grant
predecessors. Historical verification/reconciliation execution is **not implemented**.
The active-update/revocation paths now reject a new signing public-key epoch when
the stored predecessor's signer differs; they do not re-sign old evidence or
infer continuity from the unchanged `#hail-identity` DID URL.

## Acknowledged predecessor path

Before planned identity replacement/removal, inventory every authoritative
lineage and require every predecessor publication through its current revision
to be acknowledged with the strong ETag of the exact retained representation.
An unavailable sender is not an acknowledgement. The provider must retain the
receipt origin/service, exact COSE/digest, predecessor chain and verified PLC
key/operation evidence. A same-VPS database flag is not independent attestation.

After the exact reviewed PLC rotation is authoritative, a future reconciliation
implementation may append the next revision under the current key with unchanged
authorization and consent semantics, a higher timestamp and the acknowledged
predecessor digest. Never replace/re-sign the same revision: even an unchanged
payload produces different signature bytes/digest under the new key.

## Unacknowledged predecessor path

Pending, retrying, blocked, ambiguous or missing receipts require reconciliation,
not automatic replay under a new signer. Preserve the original signed bytes,
signing public key, signed PLC history/checkpoints and observation times, consent
representations and ordered outbox entries. Never discard them during migration
or overwrite them with a purported equivalent signature.

A future historical verifier must prove the key authorized that exact object at
the relevant accepted state, account for PLC recovery/nullified branches and
its recovery window, establish trusted observations/checkpoints and identify
which exact predecessors the grantee actually retained. Public log membership,
current-key resolution or an untrusted old timestamp alone is insufficient.
The unresolved historical DID rules must be reviewed before this path ships.

Reconcile sequentially from the shared acknowledged checkpoint. Receiver gaps,
forks, conflicting same-revision bytes or disputed key authority remain conflicts;
do not skip revisions, create an implicitly authorized replacement grant ID or
extend expired permissions merely to repair transport. Once old history is
verified/reconciled, owner consent can authorize a new snapshot under the active
key; restrictions/revocation continue to carry prior consent.

## Current implementation and gate

Stable-key restrictions and signed revocation remain unilateral and independent
of sender availability. Across a key-epoch change this reference slice fails
closed until the historical authority can be reviewed; it does not introduce an
unsigned local-blocking shortcut or claim rotation support. New active updates,
managed/owner revocations and repository appends enforce that hold.

Before lifting it, prove acknowledged and unacknowledged predecessor handling,
late/lost acknowledgements, recovered/nullified PLC branches, unavailable senders,
same-revision conflicts, sequential receiver replay, owner-key custody, portable
history preservation and explicit post-reconciliation expiry/consent choices.
Identity rotation remains separate from address renewal and provider-local
credential rotation. This decision changes no protocol signature or selector.
