# Hail body format and rendering

Hail uses structured Safe Portable Text rather than arbitrary HTML. Authoring
and diagnostic JSON are projections; deterministic CBOR is the wire representation
and digest input. Clients render validated content into their own trusted UI.

## Supported profiles

- `spt-1`: constrained plain text blocks and spans.
- `spt-2`: text styles, headings, lists, decorators and safe HTTPS links.
- `spt-3`: rich text with one declared bundled PNG header.
- Sender Profile v2: a bounded bundled PNG avatar, separate from message content.

The exact document shapes, limits, validation and resource rules live in
[detached bodies](spec/bodies.md), [assets](spec/assets.md),
[Sender Profiles](spec/sender-profile.md) and [the schema](spec/hail.cddl).
Use those definitions and the shared codec vectors when implementing a renderer;
there is no arbitrary Portable Text extension or raw HTML/CSS import contract.
The [browser client](apps/client/README.md) documents authoring and preview behavior.

## Rendering and privacy

Validate the body and its digest before rendering. Bundled assets require their
declared size, dimensions, role and hash to verify. Do not fetch undeclared remote
resources, execute scripts, accept arbitrary CSS, or let message content imitate
trusted application controls. Opening a message must not notify its sender through
image loads. Links remain an explicit user action and should expose their destination.

Preserve semantic headings, lists, meaningful image alternatives, keyboard access,
readable text fallback and a sensible reading order. Delivery/security states must
not depend on color alone. Preview and reader should share rendering behavior.
Forwarded attribution is supplied by the forwarder; it is not an independent
signature by the original publisher. Quoted reply text does not establish thread
identity: signed envelope parent references do.

## Future content work

Additional blocks need concrete publisher needs and explicit schema/version rules.
Candidates include buttons, dividers, callouts, key-value summaries and semantic
receipts, bookings or itineraries. Theme tokens, layout primitives and unsupported-
block fallbacks require renderer, accessibility and phishing analysis before use.
They are not supported fields in the current profiles.

General attachments need their own integrity, authorized retrieval, limits,
retention and safe-download contract. See [content storage and attachments](docs/content-storage-and-attachments.md).
Cross-client rendering expectations, accessibility conformance and link-warning
policy remain useful follow-up work. Do not expand the wire format implicitly
because a local editor can produce more content.
