# Current protocol conformance vectors

These are public synthetic fixtures. They contain test signatures, key identifiers,
bearer capabilities and message content. Never use their keys, tokens or identities
for a real account. No production account or hosted database was read to create them.
Normal tests read committed files; they do not generate their own expected bytes.

## Artifacts and provenance

| Artifact | Actual producer and coverage |
| --- | --- |
| `cbor-resource-limits.json` | Synthetic exact CBOR boundaries for default depth, item, array, map and encoded-byte budgets; small override cases isolate map-key counting and UTF-8/byte-string lengths. Segments expand to fixed bytes checked against committed length and SHA-256 in both codecs. These are data-model tests, not valid signed Hail objects. |
| `portable-history.json` | `MigrationTransferService.exportFenced` in the private-PLC transfer/return integration test; v7 with Grants, consent, accepted and delivered messages, body provenance, immutable statuses and retry obligations |
| `managed-history.json` | `ManagedMigrationExportService.exportFenced` in the managed network orchestration integration test; v8 with public source role metadata, managed custody, Grants, detached body authorization and pending delivery |
| `connection-history.json` | `collectConnectionHistory` after real local connection admission in the shared-conversation integration test; nonempty pair, proof, result and signing-evidence history |
| `conversation-creator.json` | `collectConversationHistory` after shared sends and revival processing; immutable descriptor, creator membership and terminal shared/revival outboxes |
| `conversation-renewed.json` | Same collector for a recipient renewed by the creator's signed revival |
| `conversation-left.json` | Same collector for a recipient who left and disabled introductions; exact leave and opt-out state survive reconstruction |
| `transfer-wire.json` | Real portable/managed signing functions, handover signing functions and wire wrapper; 32 fixed Ed25519/ES256 records, all handover signature roles, consent, activation and cancellation |
| `connection-wire.json` | Real COSE codec; coherent invitation, confirmation, address bindings, reviewed coordinator snapshot and deterministic bundle, lifecycle/ack controls, conversation descriptor/revival, exact JSON request/response bodies and ingress rejection cases |
| `history-negative.json` | Shared mutation instructions for unknown/private fields, missing domains, wrong scalar types, foreign ownership and changed checkpoint digests |

Snapshot fixtures retain exact manifest bytes in `manifestBase64`, source public
key, signature and expected digest. JSON objects displayed after parsing are not
replacement signed representations. Checkpoint fixtures contain the exact logical
object and expected deterministic-CBOR SHA-256. Transfer records include
schema-aware diagnostic values (`{"$bytes":"hex"}` is a fixture-only byte marker),
payload hex, digest, signature input hex, signature, public key and signed-record
wire object. `$bytes` is not a RACR protocol field.

Portable/managed fixture generation uses isolated synthetic databases and injected
PLC/HTTPS dependencies. Their retained evidence does not claim public PLC registry
membership. Transfer-wire digest subjects and PLC CIDs marked as placeholders test
encoding, signatures and linkage only; they are not admissible live cutover proof.
Receiver freshness is evaluated at the fixture's `time` where applicable.

## Independent verification

Run from the repository root:

```sh
bun run --cwd apps/server test -- test/protocol-interop-vectors.test.ts
bun run --cwd packages/hail-codec-ts test -- test/resource-vectors.test.ts
mise exec -- go -C packages/hail-codec-go test -run 'Test(AccountHistory|TransferWire|ConnectionWire)Interoperability|TestPublishedHistoryRejections' ./...
mise exec -- go -C packages/hail-codec-go test -run TestPublishedResourceBudgets ./...
```

TypeScript calls the actual server decoders/verifiers and manifest/checkpoint
validators. Ajv validates the published JSON Schema. HTTP tests exercise the real
connection ingress parser, with a service double isolating transport from database
authority; the existing database suites exercise the real state transitions.

Go imports no server code. It independently encodes checkpoint/handshake CBOR,
computes exact JSON and CBOR digests, reconstructs the managed history projection,
verifies Ed25519 and P-256 signatures using Go's crypto, checks COSE using the Go
codec, checks closed wire shapes and rejects duplicate JSON keys. A test-only
schema evaluator covers exactly the JSON Schema vocabulary used by this artifact;
unknown vocabulary is an error. It also loads records into in-memory collections,
with no SQL dependency, and checks ownership/checkpoint linkage. This is an
independent format consumer, not a complete second provider or live PLC verifier.

Both consumers run the published history rejection cases. Additional checks reject
changed signatures, substituted signature purposes, incorrect byte digests and
manifest reserialization (even adding whitespace changes the signed digest).
Existing codec vectors separately cover full CBOR/COSE malformed forms and
conversation roster/schema constraints in both languages.

## Schema drift and actual export checks

```sh
DATABASE_TEST_ADMIN_URL=<disposable-postgres-admin-url> bun scripts/export-account-history-schema.ts --check
DATABASE_TEST_ADMIN_URL=<disposable-postgres-admin-url> bun scripts/test-database-integration.ts private-poc-migration managed-network-orchestration server/test/shared-conversations.integration
```

The schema check creates and drops its own fresh database, applies every migration,
and compares the export projections to the committed schema. Integration tests
validate actual new exports/checkpoints against that schema and perform their
existing staging, cutover, return and conversation reconstruction assertions.
CI runs the schema drift check, ordinary TS/Go vector tests and database suites.

## Deliberate fixture maintenance

To update signed wire examples using fixed public test keys:

```sh
bun apps/server/scripts/generate-transfer-vectors.ts
```

To capture new history examples, set `HAIL_WRITE_HISTORY_VECTORS=1` on the three
isolated database suites above. Only test code honors this opt-in. Capture is not
byte reproducible: the real account workflows generate fresh IDs, timestamps and
keys. Once captured, expected bytes are frozen and reviewed. Do not regenerate
fixtures during ordinary verification or change expected digests merely to make
a failed test pass. Record schema/version changes and inspect the affected data.

The passing corpus is evidence for the cases represented here. It does not prove
all recovery races, resource-exhaustion behavior or a third-party deployment's
correctness. Those require the separate state-machine, database, authority and
operational conformance tests.

`provider-drafts.json` covers the provider-local draft content format, including
incomplete input, forwarding references, audience constraints and UTF-8 budgets.
It is not signed federation evidence. `apps/client/src/lib/drafts.test.ts` executes
these examples against the shared parser.

`attachments.json` freezes one SPT-2 detached LOG declaration, its CBOR and body
digest, and exact file bytes. TypeScript and Go both verify the encoded body.
The portable/managed history vectors were recaptured for migration 102's current
alpha schema expansion and contain a received/outgoing attachment respectively,
including verified file bytes and owner references, from actual round-trip tests.

`attachment-png.json` freezes a non-animated PNG attachment, including exact file
bytes, the authenticated SPT-2 declaration, body CBOR, and body/file digests.
TypeScript and Go verify the same declaration bytes; provider tests verify PNG
structure separately from the message-body and bundled-header budgets.

`attachment-images.json` freezes small baseline/progressive JPEG and static
lossy/lossless/transparent WebP files generated with ImageMagick, plus their
authenticated metadata and deterministic body encodings. Tests use these committed
bytes without requiring an image encoder or pixel decoder.
