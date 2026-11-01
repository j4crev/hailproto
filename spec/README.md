# Hail specification index

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
| Bodies and assets | `spt-3` is the latest body profile; `spt-1` plain text and `spt-2` rich text remain distinct supported body profiles; asset manifest v1; [bodies](bodies.md), [assets](assets.md) |
| Delivery results | Delivery Status v1; [delivery state](delivery-state.md), [HTTP binding](http-binding.md) |
| Connections | Invitation, confirmation and control v1; [consent](connection-auth.md), [federation](connection-federation.md), [wire binding](connection-wire.md) |
| Shared conversations | Descriptor/revival v1, Envelope v4; [shared conversations](shared-conversations.md) |
| Custody | [Account onboarding](account-onboarding.md), [managed custody](managed-custody.md); [reduced-assurance alpha](alpha-onboarding.md) is an explicitly weaker deployment profile |
| Transfer | Handshake v1, portable snapshot v7, managed snapshot v8, connection checkpoint v3, conversation checkpoint v1; [transfer formats](transfer-formats.md), [logical history schema](account-history.md), [connection portability](connection-portability.md) |

Envelope versions select different authority models. V4 is not a replacement for
Grant delivery. New direct replies use v3 rather than the historical unthreaded
v1 reply representation. Historical Sender Profile v1 and connection-grant objects
may remain in codecs or retained evidence, but are not required creation formats.

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

Before proposing an RFC-style standard, complete these explicit gates:

- Exercise the full protocol with an independently developed provider. Go vector
  verification is independent format evidence, not a deployed provider trial.
- Resolve provisional media types and registries, capability discovery, production
  size requirements and the remaining open questions in individual specifications.
- Consolidate normative requirements, security/privacy considerations, references,
  conformance requirements and registration considerations into submission documents.

No official-body approval, registration or interoperable third-party deployment is
implied by this working specification.
