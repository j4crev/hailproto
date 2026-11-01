# Account transfer formats

Status: Current alpha transfer profile. The handshake and handover rules define
peer exchanges. Snapshot v7/v8 has a complete logical record schema in
[account-history.md](account-history.md), with an explicit reference-storage mapping. Earlier snapshot formats are not part
of the current contract and no historical-reader support is required.

Authority, fencing and cutover rules in [did-profile.md](did-profile.md),
[managed-custody.md](managed-custody.md) and
[connection-portability.md](connection-portability.md) remain mandatory.
A validly signed record alone never authorizes a cutover or releases a fence.

## Detached signed records

A signed record is exactly the JSON object:

```text
{"payload": base64url(payload_bytes), "signature": base64url(signature_bytes)}
```

Senders use unpadded base64url. Payloads are deterministic Hail CBOR maps with
closed fields, not JSON payloads and not COSE wrappers. A digest reference to a
transfer record is SHA-256 of its exact payload bytes, excluding the signature.
The signature input for ordinary portable and managed handshake records is:

```text
UTF8(payload.type + ".v1") || 0x00 || payload_bytes
```

Portable handshake records use Ed25519 with 64-byte signatures. The owner signs
Grant, Address Selection and Cancellation with current `#hail-identity`; the
source signs Invitation and Cancellation Receipt with current `#hail-messaging`;
the destination signs Offer, Reservation and Request with its prepared messaging
key proven at the approved HTTPS origin. A self-asserted destination key is not
sufficient. Grant/Offer/destination identity and the complete chain of digests,
challenge, nonce, transfer ID and chosen address MUST agree.

Managed Grant, Address Selection and Approval use the current highest-priority
owner recovery key with ES256 (P-256, 64-byte raw signature). Managed provider
records use Ed25519: Acknowledgement is signed by the source messaging key;
Offer, Reservation and Fence Request by the prepared destination messaging key.
The owner recovery key MUST be independently authorized by current PLC state;
a key merely named in the payload does not authorize itself. Portable consent
and activation receipt use the same type-based prefix above and Ed25519, signed
by the owner's identity key and destination messaging key respectively.

Unless a binding below supplies a larger limit, the signed-record payload is
1–4096 bytes and the complete transfer JSON request is at most 16384 bytes.
Managed cryptographic validation permits 8192-byte payloads, but the ordinary
HTTP signed-record parser still imposes the smaller 4096-byte limit.
Reject duplicate JSON keys, trailing CBOR data, unknown payload fields,
non-deterministic CBOR and incorrect signature lengths before using a record.

## Payload field schemas

The following declarations are normative structural notation, not executable
server code. Every field is required; maps are closed. `Uint8Array` means a CBOR
byte string, `string` a CBOR text string and `number` a safe integer. Every digest
and challenge is 32 bytes. DID fields use canonical `did:plc`; key fields are
`did:key`; addresses and service bases use their canonical Hail forms. Nonces and
transfer/request IDs use lowercase hyphenated UUID strings. Senders create fresh cryptographically random IDs; this transfer profile accepts
lowercase UUIDs without imposing the envelope profile's UUIDv7 restriction.
Retained IDs are never regenerated.
Timestamps are integer Unix seconds.

Portable Grant and all other portable handshake records with `issued_at` have a
positive lifetime at most 3600 seconds, except Cancellation Receipt permits 604800
seconds. Invitation inherits the Grant deadline and has no `issued_at` field.
Managed handshake lifetimes are positive and at most 3600 seconds. Receivers also
check current time, exact operation state and the authority chain; a structurally
valid historical record is not a fresh authorization. Source and destination
service bases differ; the selected destination domain binds
`https://{domain}/hail` and the destination address domain.

### Portable handshake

```typescript
interface TransferGrant {
  type: "hail.transfer-grant"; version: 1; did: string; nonce: string;
  source_service_base: string; destination_service_base: string; destination_domain: string;
  issued_at: number; expires_at: number;
}
interface TransferInvitation {
  type: "hail.transfer-invitation"; version: 1; did: string; nonce: string;
  source_service_base: string; destination_service_base: string;
  grant_digest: Uint8Array; challenge: Uint8Array; expires_at: number;
}
interface TransferOffer {
  type: "hail.transfer-offer"; version: 1; did: string; nonce: string;
  transfer_id: string; source_service_base: string; destination_service_base: string;
  grant_digest: Uint8Array; invitation_digest: Uint8Array;
  invitation_challenge: Uint8Array;
  destination_rotation_key: string; destination_messaging_key: string;
  issued_at: number; expires_at: number;
}
interface TransferAddressSelection {
  type: "hail.transfer-address-selection"; version: 1; did: string; nonce: string;
  transfer_id: string; grant_digest: Uint8Array; offer_digest: Uint8Array;
  address: string; selection_nonce: string; issued_at: number; expires_at: number;
}
interface TransferReservation {
  type: "hail.transfer-reservation"; version: 1; did: string; nonce: string;
  transfer_id: string; offer_digest: Uint8Array; selection_digest: Uint8Array;
  address: string; issued_at: number; expires_at: number;
}
interface TransferRequest extends Omit<TransferOffer, "type"> {
  type: "hail.transfer-request"; offer_digest: Uint8Array;
  destination_address: string; selection_digest: Uint8Array; reservation_digest: Uint8Array;
}
interface TransferCancellation {
  type: "hail.transfer-cancellation"; version: 1; did: string; nonce: string;
  grant_digest: Uint8Array; issued_at: number; expires_at: number;
}
interface TransferCancellationReceipt {
  type: "hail.transfer-cancellation-receipt"; version: 1; did: string; nonce: string;
  grant_digest: Uint8Array; invitation_digest: Uint8Array;
  destination_domain: string; source_service_base: string;
  issued_at: number; expires_at: number;
}
```

### Managed handshake

```typescript
interface ManagedTransferGrant {
  type: "hail.managed-transfer-grant"; version: 1; did: string; nonce: string;
  source_service_base: string; destination_service_base: string; destination_domain: string;
  owner_recovery_key: string; source_identity_key: string; issued_at: number; expires_at: number;
}
interface ManagedTransferAcknowledgement {
  type: "hail.managed-transfer-acknowledgement"; version: 1; did: string; nonce: string;
  source_service_base: string; destination_service_base: string; grant_digest: Uint8Array;
  source_messaging_key: string; issued_at: number; expires_at: number;
}
interface ManagedTransferOffer {
  type: "hail.managed-transfer-offer"; version: 1; did: string; nonce: string; transfer_id: string;
  source_service_base: string; destination_service_base: string; grant_digest: Uint8Array;
  acknowledgement_digest: Uint8Array;
  destination_rotation_key: string; destination_identity_key: string; destination_messaging_key: string;
  issued_at: number; expires_at: number;
}
interface ManagedTransferAddressSelection {
  type: "hail.managed-transfer-address-selection"; version: 1; did: string; nonce: string; transfer_id: string;
  grant_digest: Uint8Array; offer_digest: Uint8Array; address: string; selection_nonce: string;
  issued_at: number; expires_at: number;
}
interface ManagedTransferReservation {
  type: "hail.managed-transfer-reservation"; version: 1; did: string; nonce: string; transfer_id: string;
  offer_digest: Uint8Array; selection_digest: Uint8Array; address: string;
  destination_rotation_key: string; destination_identity_key: string; destination_messaging_key: string;
  issued_at: number; expires_at: number;
}
interface ManagedTransferFenceRequest {
  type: "hail.managed-transfer-fence-request"; version: 1; did: string; nonce: string; transfer_id: string;
  source_service_base: string; destination_service_base: string; destination_address: string;
  owner_recovery_key: string; source_identity_key: string; destination_rotation_key: string;
  destination_identity_key: string; destination_messaging_key: string;
  grant_digest: Uint8Array; acknowledgement_digest: Uint8Array; offer_digest: Uint8Array;
  selection_digest: Uint8Array; reservation_digest: Uint8Array; issued_at: number; expires_at: number;
}
interface ManagedTransferApproval {
  type: "hail.managed-transfer-approval"; version: 1; did: string; nonce: string; transfer_id: string;
  source_service_base: string; destination_service_base: string; destination_address: string;
  owner_recovery_key: string; source_identity_key: string; destination_rotation_key: string;
  destination_identity_key: string; destination_messaging_key: string;
  grant_digest: Uint8Array; offer_digest: Uint8Array; selection_digest: Uint8Array;
  snapshot_version: 8; snapshot_digest: Uint8Array; history_checkpoint_digest: Uint8Array;
  source_generation: number; previous_operation_cid: string; operation_cid: string;
  issued_at: number; expires_at: number;
}
```

### Portable final consent

```typescript
interface PortableMigrationConsent {
  type: "hail.portable-migration-consent";
  version: 1;
  did: string;
  transfer_id: string;
  snapshot_digest: Uint8Array;
  plc_operation_sha256: Uint8Array;
  source_service_base: string;
  destination_service_base: string;
  destination_address: string;
  destination_rotation_key: string;
  destination_messaging_key: string;
  user_recovery_key: string;
  user_identity_key: string;
  created_at: number;
  expires_at: number;
}
```

### Activation receipt

```typescript
interface MigrationActivationReceipt {
  type: "hail.portable-migration-activated";
  version: 1;
  did: string;
  transfer_id: string;
  snapshot_digest: Uint8Array;
  destination_service_base: string;
  destination_messaging_key: string;
  destination_address: string;
  address_binding_digest: Uint8Array;
  activated_at: number;
}
```

`TransferRequest` includes every `TransferOffer` field except its `type`, which
is replaced by `hail.transfer-request`. Its additional digest fields bind the
specific Offer, user selection and destination reservation. Managed Approval fixes
`snapshot_version` to 8 in the current profile. Portable final consent binds the
exact signed PLC operation bytes via `plc_operation_sha256`; it is separate from
the owner's top-priority PLC signature. Activation binds the destination address
binding's complete COSE digest, snapshot and transfer ID.

Portable final consent has a positive lifetime at most 604800 seconds; `created_at`
may be at most 300 seconds ahead of the verifier and `expires_at` must not have
passed. Its cryptographic payload ceiling is 16384 bytes, with the smaller
signed-record HTTP parser limit applying at completion. Activation receipts have
no expiry field; `activated_at` must not be more than 300 seconds ahead. Their
continued use requires the exact retained transfer and authenticated destination,
not just a mathematically valid old signature.

## HTTP operation inventory

`W` means `https://{approved-destination-domain}/.well-known/hail/transfers/`;
`S` means the current source service base plus `/transfers/`.
All entries use POST and `application/hail-transfer+json`, no content coding,
HTTPS validation and pinned public DNS, and no redirects. JSON signatures are the
signed records above; an enclosing JSON object is not itself signed. Successful
bodies use the same transfer media type and are not cacheable.

| Path | Request | Success |
| --- | --- | --- |
| `S grants` | signed Grant | 200 signed Offer, or empty 202 while delivery is pending |
| `W invitations` | `{grant,invitation}` | 200 signed Offer |
| `W reservations` | signed Address Selection | 200 signed Reservation, or 202 with the same receipt while final request delivery is pending |
| `S requests` | `{selection,reservation,request}` | empty 204 after durable fence |
| `S cancellations` | signed Cancellation | 200 signed Cancellation Receipt |
| `W cancellations` | `{cancellation,receipt}` | empty 204 after verified release |
| `W managed-invitations` | `{grant,acknowledgement}` | 200 signed managed Offer |
| `W managed-reservations` | signed managed Address Selection | 200 signed managed Reservation, or 202 with receipt while push is pending |
| `S managed-requests` | `{selection,reservation,request}` | empty 204 after durable managed fence |
| `W completions` / `W managed-completions` | retained snapshot and owner cutover artifacts, with optional fresh monitor evidence | 200 phase result; only `active` with verified activation receipt establishes completed activation |
| `/.well-known/hail/transfers/retirements` / `managed-retirements` at the source origin | signed activation receipt | empty 204 after source retirement |

The completion endpoint permits up to 100000000 request bytes because it carries
snapshot history. It is a reference-profile operation, not a 16 KiB handshake.
Its JSON artifact contract remains tied to the reference snapshot/import profile.
Portable completion has exactly `{snapshot,consent,operation,binding}` and
optionally `monitor`; managed completion has exactly `{snapshot,approval,operation}`
and optionally `monitor`. Consent, approval and monitor are signed records.
`operation` is canonical base64url of the exact signed PLC operation JSON bytes;
portable `binding` is canonical base64url of the signed destination Address Binding.
The portable binding limit is 16384 bytes and operation limit is 16000 bytes.
The snapshot container has exactly `type`, `version`, `manifest`, `digest`,
`signature`, `sourceMessagingPublicKey`. Type is `hail.portable-migration-transfer`
with version 7 or `hail.managed-migration-transfer` with version 8. Manifest, digest
and signature are canonical base64url strings; decoded manifest size is at most
67108864 bytes, digest is 32 bytes and signature is 64 bytes. Container and manifest
versions MUST match. Preserve exact artifacts across retries; fresh monitor evidence
may be supplied without changing the snapshot, consent/approval or PLC operation.

Phase responses have `type` (`hailp.transfer-completion` or
`hailp.managed-transfer-completion`), `version:1`, `did`, `accountId`, `transferId`,
`operationCid` and `phase`. Active responses additionally carry `receipt` as a
signed record; managed active responses also carry `generation`.
The lifecycle and monitor requirements are specified in the HTTP binding and
custody profile. `awaiting-monitor` and `awaiting-connection-handover` are pending
phases, not activation acknowledgements.

The current handlers use empty 400 for invalid transfer input/verification,
415 for media/coding mismatch and 429 for rate limiting. An authenticated
unavailable address may use 409. A timeout or failed exchange is not evidence that
a fence did not commit. Retry the same immutable signed intent; retain ambiguous
submitted reservations until a verified no-fence cancellation or coordinated
rollback proves release safe. Exact retry semantics apply independently at each
phase. Local worker retry intervals are not signature validity extensions.

## Connection handover records

Handover payloads use the signed-record wrapper above, with a different domain:

```text
UTF8("hail.connection-handover." + role + ".v1") || 0x00 || payload_bytes
```

All signatures are Ed25519. Preparation roles are `source`, `destination`,
`peer-ack`; freeze roles are `source-freeze`, `destination-freeze`, `peer-freeze`;
abort roles are `source-abort`, `destination-abort`, `peer-release`; transition
roles are `destination-commit`, `destination-complete`, `peer-commit`, `peer-complete`.
A signature for one role MUST NOT verify another. Source authority is current
before cutover; destination authority comes from the origin-proven prepared keys
and then canonical cutover; the peer signs using its own messaging authority.

```typescript
type ConnectionFrontier={
  native:{connectionId:string;epoch:1;state:"active"|"disconnected"}[];
  federated:null|{connectionId:string;epoch:number;state:"active"|"disconnected";tombstones:{connectionId:string;epoch:number}[]};
};
interface ConnectionHandoverPlan {
  type:"hail.connection-handover-prepare";version:1;request_id:string;transfer_id:string;
  did:string;peer_did:string;source_service_base:string;destination_service_base:string;
  destination_messaging_key:string;source_generation:number;snapshot_digest:Uint8Array;connection_checkpoint_digest:Uint8Array;
  frontier:ConnectionFrontier;issued_at:number;expires_at:number;
}
interface ConnectionHandoverAbort {
  type:'hail.connection-handover-abort';version:1;request_id:string;transfer_id:string;did:string;peer_did:string;
  plan_digest:Uint8Array;issued_at:number;expires_at:number;
}
interface ConnectionHandoverTransition {
  type:'hail.connection-handover-transition';version:1;action:'commit'|'complete';request_id:string;transfer_id:string;
  did:string;peer_did:string;plan_digest:Uint8Array;binding_digest:Uint8Array;activation_digest:Uint8Array|null;issued_at:number;expires_at:number;
}
interface ConnectionHandoverResult {
  type:'hail.connection-handover-result';version:1;phase:'committed'|'completed';transfer_id:string;did:string;peer_did:string;
  plan_digest:Uint8Array;request_digest:Uint8Array;terminal_ids:string[];issued_at:number;
}
```

Plans and results are at most 65536 payload bytes; abort and transition payloads
are at most 4096 bytes. Plans, aborts and transitions have a positive lifetime of at most
300 seconds. The source generation and federated epochs are positive integers.
Frontier arrays have at most 1000 entries each, no duplicate connection IDs, and
at most one active native connection. A disconnected federated ID must occur in
its tombstones; tombstone epochs cannot exceed the frontier epoch. Empty history
is not a handover. Preserve terminal IDs regardless of later active receipts.
`plan_digest` and `request_digest` hash exact CBOR payload bytes. `binding_digest`
hashes complete Address Binding COSE; `activation_digest` is null for commit and
hashes deterministic CBOR of `{payload: <receipt payload bytes>,
signature: <receipt signature bytes>}` for completion.

The following are relative to the peer's service base and use the JSON transport
in [connection-wire.md](connection-wire.md). `R` is a signed record; `sig` is a
base64url 64-byte signature over the same payload with the named role.

| Operation | Exact request | Response |
| --- | --- | --- |
| `connections/handover` | `{proposal:R,destinationSignature:sig}` | `{preparation:R}` signed `peer-ack` |
| `connections/handover-freeze` | `{proposal:R,destinationSignature:sig}` | barrier response with `peer-freeze` receipt |
| `connections/handover-abort` | `{abort:R,destinationSignature:sig}`; optionally both `proposal:R` and `freezeDestinationSignature:sig` for an unobserved freeze | barrier response with retained release receipt |
| `connections/handover-commit` | `{command:R,binding:base64url(COSE)}` | `{phase:"committed",currentPhase,receipt:R}` |
| `connections/handover-complete` | `{command:R,binding:base64url(COSE),activation:R}` | `{phase:"completed",currentPhase,receipt:R}` |

A barrier response has exactly `type:"hail.connection-handover-barrier"`,
`version:1`, `phase` (`frozen`, `released`, `committed` or `completed`),
`barrierDigest` (base64url plan digest), `cutoverAuthorized:false`, `receipt:R`
and `freezeReceipt:R`. It preserves the original freeze receipt and reports the
current phase. A replayed commit may return its committed receipt while
`currentPhase` is already `completed`. Neither preparation nor a freeze receipt
is owner authorization for PLC cutover. Full transition conditions and the
source/destination orchestration exchanges remain in
[connection-portability.md](connection-portability.md).

## Snapshot profile and standardization boundary

The current reference provider exports portable snapshot **7** and managed
snapshot **8**, each embedding connection checkpoint **3** and conversation
checkpoint **1**. All four components are required even when their history is
empty. No old snapshot version is required by the current alpha specification.

The snapshot manifest is UTF-8 JSON, with duplicate keys rejected. Unlike ordinary
Hail signed objects, its identity is the **exact saved JSON byte sequence**; there
is no JSON canonicalization or permission to parse/re-serialize before verification.
The source signs:

```text
UTF8("hail-migration-snapshot-v7") || 0x00 || SHA256(manifest_bytes)  # portable
UTF8("hail-migration-snapshot-v8") || 0x00 || SHA256(manifest_bytes)  # managed
```

Both use the source's authenticated Ed25519 messaging key and a 64-byte signature.
The snapshot carrier retains the manifest bytes, their 32-byte digest, signature
and source messaging public key. Verify the key against the source authority;
never trust a key simply because the carrier includes it. This is an explicit
reference-profile exception to the CBOR payload rule, not an alternate encoding
for envelopes, Grants or connection controls.

```typescript
interface TransferManifest {
  version: 7;
  sourceGeneration:number;
  conversations:ConversationHistory;conversationCheckpointDigest:string;
  connections:ConnectionHistory;
  connectionCheckpointDigest:string;
  transferId: string;
  did: string;
  accountId: string;
  sourceServiceBase: string;
  destinationServiceBase: string;
  destinationRotationPublicKey: string;
  destinationMessagingPublicKey: string;
  custodyProfile: "portable";
  capturedAt: string;
  tables: TransferTables;
}
```

```typescript
interface ManagedTransferManifest {
  version: 8; transferId: string; did: string; accountId: string;
  conversations:ConversationHistory;conversationCheckpointDigest:string;
  connections:ConnectionHistory;connectionCheckpointDigest:string;
  sourceServiceBase: string; destinationServiceBase: string;
  ownerRecoveryPublicKey: string; sourceIdentityPublicKey: string;
  destinationRotationPublicKey: string; destinationIdentityPublicKey: string;
  destinationMessagingPublicKey: string; sourceGeneration: number;
  historyCheckpointDigest: string; custodyProfile: "managed"; capturedAt: string;
  tables: ManagedTransferTables;
}
```

`tables` is the reference-provider account-history row map. It excludes live
credentials and private keys. Byte-valued database columns are represented as
text `\x` followed by hexadecimal digits; timestamp columns are text timestamps.
Do not confuse these row values with native CBOR byte strings in signed protocol
objects. The provider validates ownership, referential integrity, exact original
signed bytes, body hashes, terminal state and historical authority before import.

Each checkpoint digest is SHA-256 over deterministic Hail CBOR encoding of its
complete checkpoint object; the manifest stores that digest as unpadded base64url.
The checkpoints include account ID, DID, source generation, source service base,
capture time and closed table projections. Connection history additionally carries
`sharePolicy:"invalidate-at-cutover"`; history never revives old invitation tokens.
Conversation history carries immutable descriptors/signing evidence, explicit
preferences, membership leases and leave state, replay receipts and terminal
outboxes. Imports preserve lease timestamps and current source policy; they MUST
NOT grant fresh permission because an account moved.

Managed `historyCheckpointDigest` additionally binds the DID, source generation,
both component digests, PLC operation digests, Grant/publication history, bindings,
authority bundles and authority links. The exact projection is specified in
[account-history.md](account-history.md#managed-history-checkpoint-digest). It is a
logical record contract, not a required physical database schema.

The complete current logical account-history shape is published as
[JSON Schema](schemas/account-history-v7-v8.json), with selection, ownership,
ordering, import invariants and reference-storage mapping in
[account-history.md](account-history.md). Existing `tables` and hex-text wire
spellings remain intact; another implementation can map those logical collections
to its own storage without changing the signed manifest.

[Fixed conformance vectors](vectors/README.md) include actual synthetic exports,
nonempty checkpoint states, transfer/handover signatures and connection/revival
exchanges, verified by the reference TypeScript validators and an independent Go
consumer. These establish representation interoperability, not certification of
an unrelated provider's live authority, recovery or migration implementation.
