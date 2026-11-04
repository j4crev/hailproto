# Hail specification index

Hail is the communication medium; a hail is an individual recipient-authorized
message. RACR (Recipient-Authorized Content Retrieval, pronounced “racer”) is
the underlying protocol for exchanging hail messages. Existing `hail.*` identifiers name
its protocol objects and remain current.

Status: Working alpha specification; not an RFC or an adopted standard.

The specification describes the current intended system. Alpha changes may break
wire, API and stored-data compatibility. An implementation is not required to
accept superseded formats merely because the reference provider still has an old
reader. Preserve security invariants and authenticated current history; do not
invent backward-compatibility obligations for test data.

## Scope and requirements language

Core protocol requirements govern independently implemented peers: exchanged
objects, signatures, discovery, authorization, state transitions, failure/privacy
semantics and continuity of authority. A local database schema, UI, client API,
worker arrangement or deployment topology is not a core protocol requirement.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, NOT RECOMMENDED, MAY, and OPTIONAL in this specification are to be
interpreted as described in BCP 14 when, and only when, they appear in all capitals.
Existing lower-case requirements retain their ordinary mandatory or advisory
meaning; conversion to uniform RFC editorial style is still in progress.

The object-specific authorization rules specialize the common delivery rules.
Transport wrappers do not change embedded signature or digest domains. CDDL defines
structural constraints; the associated prose defines additional semantic checks.
Historical implementation/rollout notes do not override the current profile below.

## Current profiles

| Area | Current format and specification |
| --- | --- |
| Data encoding | Deterministic Hail CBOR and COSE in [encoding](encoding.md); explicitly separate transfer representations below |
| Identity and address discovery | `did:plc`, Address Binding v2; [DID profile](did-profile.md), [address binding](address-binding.md), [PLC evidence](plc-read-evidence.md) |
| Sender discovery and consent | Sender Profile v2, Grant v1; [sender profile](sender-profile.md), [grants](grants.md) |
| Message delivery | Envelope v1 for Grant delivery; v2 for unthreaded connection delivery; v3 for threaded direct/reply-capability delivery; v4 for shared conversations; [envelopes](envelopes.md) |
| Bodies and assets | All providers support `spt-1` plain text, `spt-2` rich text, and `spt-3` rich text with bundled header image; asset manifest v1; optional PNG/JPEG/WebP/PDF/TXT/LOG attachment declarations (25 MiB/message); [bodies](bodies.md), [assets](assets.md), [attachments](attachments.md) |
| Delivery results | Delivery Status v1; [delivery state](delivery-state.md), [HTTP binding](http-binding.md) |
| Connections | Invitation, confirmation and control v1; [consent](connection-auth.md), [federation](connection-federation.md), [wire binding](connection-wire.md) |
| Shared conversations | Descriptor/revival v1, Envelope v4; [shared conversations](shared-conversations.md) |
| Custody | [Account onboarding](account-onboarding.md), [managed custody](managed-custody.md); [reduced-assurance alpha](alpha-onboarding.md) is an explicitly weaker deployment profile |
| Transfer | Handshake v1, portable snapshot v7, managed snapshot v8, connection checkpoint v3, conversation checkpoint v1; [transfer formats](transfer-formats.md), [logical history schema](account-history.md), [connection portability](connection-portability.md) |

Envelope versions select different authority models. V4 is not a replacement for
Grant delivery. New direct replies use v3 rather than the historical unthreaded
v1 reply representation. Historical Sender Profile v1 and connection-grant objects
may remain in codecs or retained evidence, but are not required creation formats.

## Reference client namespace

The reference provider's account API and client state use `racr.*` type names,
`racr_` API tokens, and browser-login client ID `racr-cli-v1`. Client-only signing
domains include `racr.account-access.v1\0` and `racr.custody-transition.v1\0`
(the final byte is NUL). These replace the former `hailp` namespace in the current
alpha; they do not establish a required cross-provider account API. See the
[client contract](../apps/cli/docs/cli-contract.md) and
[breaking upgrade instructions](../apps/cli/docs/cli-installation.md#moving-from-hailp-to-racr).
Federation object names, DID fragments, and encrypted `hail.user-vault` files
remain unchanged.

## Protocol extensions and implementation policy

Connections and shared conversations are protocol extensions: advertising or using
them requires their wire and authorization rules. A signature or a generic HTTP
receipt is never evidence that an unsupported peer admitted an extension.

Reference-provider policy includes conversation lease duration (currently 24
calendar months), activity coalescing, UI defaults, local rate limits, account APIs,
passkey sessions and operator controls. Policy choices MUST NOT bypass signature,
consent, replay, leave/disconnect or account-isolation requirements. Clients should
not infer a peer's permission state from the reference provider's local defaults.

The current migration snapshot defines logical record collections independently
of storage. Its historical `tables` and hex-text wire names do not require SQL.
The [complete account-history schema](account-history.md) documents every exported
field, reference mapping and continuity requirement. Schema and signature validity
alone do not replace live cutover, owner and monitor authority checks.

## Conformance and publication work

The separate [first Internet-Draft workspace](../drafts/README.md) contains
`draft-creviston-racr-00`, its RFCXML source and readable renderings. It is an
unsubmitted review draft anchored to a fixed specification snapshot, not a
replacement for these working specifications or a claim of IETF adoption.

The [CDDL](hail.cddl), codec vectors and reference-provider tests provide evidence,
not a blanket interoperability certification. Changes to the protocol should update
its prose, schemas, version inventory and applicable positive/negative vectors in
the same change. A reviewer should be able to derive the exchanged bytes and
required decisions without inspecting private implementation details.

Completed specification/conformance artifacts:

- [Storage-independent logical history schema](account-history.md), including the
  current portable/managed field differences and retained checkpoint domains.
- [Cross-language conformance vectors](vectors/README.md) for actual synthetic
  exports, conversation/connection checkpoints, lifecycle/revival wire objects,
  transfer/handover signatures, and malformed/tampered representations.

An initial Internet-Draft may document the current design and explicitly identify
open issues. Prepare a separate submission document consistent with these
specifications. Before proposing a stable specification for RFC publication:

- Document conformance coverage and its limitations. Independent-provider trials
  are valuable additional evidence, not a mandatory project publication gate.
  No particular implementation language or second provider implementation is
  required. Go vector verification is independent format evidence, not a deployed
  provider trial.
- Resolve provisional media types and registries and the remaining open questions
  in individual specifications, especially historical authority and recovery.
  Current mandatory body profiles and size requirements are defined; capability
  discovery is future work for optional profiles, not a plain-text-only restriction.
- Consolidate normative requirements, security/privacy considerations, references,
  conformance requirements and registration considerations into submission documents.

No official-body approval, registration or interoperable third-party deployment is
implied by this working specification.

## Specification audit follow-up (2026-11-01)

The current-feature/deferred inventory is in
[core delivery](core-delivery.md#questions-that-can-be-deferred). Connections,
threaded replies, shared conversations and authenticated history handover are
specified extensions, not missing first-flow features. Local send batching, local
read state and public discovery do not imply bulk federation submission, read
receipts or a global directory protocol.

Resolved audit findings:

- **Body capacity:** current bodies permit 1 MiB of deterministic CBOR, with a
  separate 2 MiB compressed-transfer ceiling. Image, signed-object and structural
  limits remain independent. Publisher layouts still require explicit profiles. Detached attachments have
  a separate 25 MiB budget; see [bodies](bodies.md#separate-content-budgets).

- **Resource-budget interoperability:** [encoding](encoding.md#current-cbor-budgets)
  now specifies numeric limits, counting rules and independent COSE domains.
  Shared [boundary vectors](vectors/cbor-resource-limits.json) exercise both codecs
  and their pre-allocation scanners. The Go scanner now enforces encoded-byte
  budgets itself, including when invoked for protected headers.
- **Body retrieval error disclosure:** authorization lookup exceptions use the
  concealed `404` schedule. Storage failures after verified authorization retain
  retryable `503`; regression tests cover both sides of that boundary. The
  availability cost of concealed lookup failures is explicit in [bodies](bodies.md).
- **Decompression contract:** bounded buffered or streaming decompression is
  permitted. The TypeScript retriever uses asynchronous buffered gzip with a hard
  output cap equal to the signed size, bounded compressed input, and exact final
  size/digest verification. Tests cover the ceiling, excess aggregate member
  output, truncated/corrupt input and untrusted lengths.

Remaining issues, not resolved by these fixes or passing conformance vectors:
- **Historical authority:** exact evidence retention, current-key checks and
  connection-history verification exist, but general recovery/nullified-branch
  reconciliation and unacknowledged Grant rotation still need a reviewed procedure.
- **Publication and extensions:** media-type registration remains pending. Future
  optional SPT profiles need support negotiation; additional attachment formats need explicit wire,
  availability and delivery rules. These are not implied by existing header assets.

This audit checks specification consistency against repository source and selected
tests. It is not a full security review, a production exercise, or a claim that
all database state transitions have been revalidated.

Reference-provider application policy: [mailbox cleanup](provider-mailbox.md)
defines Sent/Trash cleanup, restore, retention and its separation from protocol evidence.
[Saved drafts](provider-drafts.md) defines the current provider-local draft JSON
format, device synchronization, revision checks and atomic publication consumption;
it introduces no signed protocol version.
