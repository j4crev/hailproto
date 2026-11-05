# SPT content builder roadmap

Status: nonnormative roadmap. Created 2026-11-04.

Implementation update 2026-11-05: Phases 0–1 are implemented, with human
accessibility/cross-browser evaluation still outstanding. The first Phase 2 slice
adds up to eight bundled inline PNG images, a text/image insertion palette, drag
handles, keyboard reordering and shared image/text undo history. Current `spt-3`
is expanded under the pre-launch policy; no new profile identifier is allocated.
See the builder README and compatibility inventory for limits and evidence.
Recovery, autosave and unsaved-change warnings are intentionally excluded.
CTA blocks and left/center/right text alignment are now implemented. Selected
image/button settings use a separate sticky sidebar on wide workspaces and a
modal bottom sheet on narrow screens, keeping form fields off the canvas.
Next: image preparation and editable templates; notices, image links, JPEG and
controlled import remain separate work.

This document plans a reusable content builder for haili.app and future Hail
clients. It does not introduce a new protocol profile or authorize deployment.
[`spec/`](../spec/README.md) remains authoritative. Protocol changes must update
the affected specifications, [IETF draft](../drafts/draft-creviston-racr-00.xml)
(core protocol only), schemas, version inventories, and conformance vectors
in the same change as their implementation.

## 1. Product outcome

Let a sender create an accessible, attractive message using a convenient editor,
preview it as a recipient will read it, save it, and hand it back to the host
client for publication. The builder should be usable inside haili.app and in a
small standalone application without depending on haili.app routes, account state,
or publication APIs.

Make Safe Portable Text a defensible restricted profile of Sanity's Portable
Text. Prefer existing Portable Text semantics over inventing equivalent Hail
semantics. Richer content must not reintroduce arbitrary sender HTML, CSS,
executable behavior, or remote resources loaded when a recipient opens a message.

The first release is a content editor, not a general website designer, campaign
manager, analytics product, or full Sanity Studio replacement.

## 2. Compatibility and safety contracts come first

### Portable Text compatibility

The intended relationship is directional: all supported SPT content must have a
faithful Portable Text representation; arbitrary Portable Text is not necessarily
valid SPT. Unsupported incoming content must produce explicit diagnostics rather
than silent loss or relaxed validation.

Separate three claims and prove each independently:

1. **Data-model compatibility:** text uses Portable Text blocks, spans, styles,
   decorators, and keyed annotations with their established meanings. Any added
   objects use supported extension points, not incompatible replacements for
   standard structures.
2. **Sanity interoperability:** a published schema configuration and integration
   can load, edit, save, and render our supported content with tested versions of
   Sanity tooling. Custom types need explicit schemas and renderers; validity as
   Portable Text does not guarantee default renderer support.
3. **Hail transport correctness:** deterministic CBOR, the body wrapper, asset
   bundles, profiles, and signatures are Hail concerns. The complete Hail body
   is not itself a Sanity JSON block array. Export must explain the boundary and
   provide the required assets, not just a JSON file with unresolved references.

Compatibility is an acceptance condition, not a label earned merely by writing
an adapter. Prefer direct reuse of standard names and field shapes. Document
every necessary mapping, prove it preserves supported semantics, and disclose
any integration requirements. Do not claim byte-identical round trips through
an editor or unrestricted compatibility with every historical Sanity release.

Audit the current differences before choosing the next format:

- `spt.link` versus the conventional `link` annotation, and `spt.image` versus
  Sanity's image object and asset reference model.
- Block/span `_key` requirements and stability during editing. Current closed
  SPT schemas do not allow arbitrary editor metadata; do not send keys or editor
  fields until their treatment is specified.
- Custom `caption` style, permitted decorators, list levels, line breaks,
  Unicode normalization, empty blocks, and annotation scope.
- Asset identity and packaging across standalone drafts, Sanity, and Hail.

Use the pre-launch policy to correct unnecessary divergence now, rather than
preserving it indefinitely. Compatibility with Sanity is a deliberate product
requirement; preserving obsolete Hail alpha formats is a different question.
See [the pre-launch policy](haili-operations.md#pre-launch-development-policy--developers-and-agents).

### Meaning of “Safe”

Suggested public description, subject to the compatibility proof:

> Safe Portable Text is Hail's restricted profile of Portable Text. It permits
> defined content types and validated links, with verified bundled images and
> no sender-controlled scripts, arbitrary HTML/CSS, or remote resource loading
> when a message is displayed.

Recipients should not need to configure HTML sanitization or decide whether to
enable remote content. Implementations still must validate schemas and resource
limits, escape text, enforce link rules, safely decode images, and keep sender
content separate from trusted application controls. Portable Text alone is not
a security boundary; its extensibility can represent unsafe content too.

This does not promise that text is truthful, links are trustworthy, or clicked
URLs cannot track users. SPT does not replace sender authorization, abuse
controls, or security updates. No automatic link previews, URL resolution, font
requests, or resource fetching should occur during recipient rendering.

## 3. Experience: desktop-first authoring, responsive content

Recommend full authoring on a sufficiently wide viewport, not a desktop-device
check. Start usability testing around 1024 CSS pixels of available width; this
is a provisional design target, not a protocol requirement or fixed release gate.

- Wide view: block palette, editing canvas, and contextual properties; collapse
  panels as needed rather than requiring all three to remain open.
- Include insertion, duplication, deletion, and reordering with keyboard controls
  as well as pointer interactions. Drag-and-drop must not be the only method.
- Provide undo/redo, explicit Save as Draft, clear validation
  errors, and an explicit handoff to the host's publication flow.
- Preview narrow and wide recipient layouts, light/dark themes, and images
  unavailable. Preview uses the recipient renderer, not an unrelated template.
- On small screens, preserve draft access and readable preview. If full editing
  is unavailable in the first release, say so without losing work; retain the
  existing simple compose path where practical.
- Test keyboard navigation, screen readers, zoom/reflow, touch, and input method
  composition. A desktop-first editor must still produce mobile-readable content.

## 4. Reusable architecture

Keep package boundaries proportional to actual reuse. These are logical roles,
not a requirement to create five packages immediately:

1. **Content core:** supported Portable Text model, editing commands, structured
   diagnostics, profile capability checks, and import/export. Keep browser UI,
   authentication, and network publication out of this layer. Reuse the codec's
   authoritative validation rather than implementing a competing schema.
2. **Recipient renderer:** explicit rendering of allowed nodes and locally
   resolved verified assets. Shared behavior between reader and builder preview.
3. **Editor UI:** selection, toolbars, block controls, asset picker, and properties.
   Evaluate maintained Portable Text tooling before building a rich-text engine.
4. **Host integration:** load/save drafts, acquire local assets, provide supported
   profiles, and accept validated output. Haili owns identity, recipients,
   authorization, signing, publication, and delivery.
5. **Standalone shell:** exercises the same editor with local draft persistence
   and import/export, without requiring a Hail account or Sanity-hosted backend.

Define a versioned host contract for initial document/assets, capabilities,
change events, save results, validation diagnostics, export, and disposal. Keep
draft schema versions distinct from wire-profile identifiers. Host persistence
must handle stale revisions and failed saves without overwriting newer work.
Never switch a rich document through the current Markdown-like compose parser
as a supposedly lossless intermediate representation.

Start with an in-process integration in the current Svelte client and a minimal
standalone harness. Evaluate the official Portable Text editor's actual framework
requirements, dependency cost, accessibility, and schema behavior in a bounded
spike. Do not assume native Svelte support or choose a framework bridge blindly.
If an iframe or web-component boundary is needed, decide it from that evidence.
An iframe integration needs strict origin/source checks, bounded messages, an
explicit handshake, and no ambient publication credentials.

Existing integration points to inspect and reuse:

- [`compose.ts`](../apps/client/src/lib/compose.ts) and the
  [compose route](../apps/client/src/routes/compose/+page.svelte).
- [`RichText.svelte`](../apps/client/src/lib/RichText.svelte) and
  [`messages.ts`](../apps/client/src/lib/messages.ts).
- The [drafts route](../apps/client/src/routes/drafts/+page.svelte), existing
  publication flow, reply/forward behavior, and their acceptance tests.
- [`hail-codec-ts`](../packages/hail-codec-ts), the Go codec, and the
  [body](../spec/bodies.md) and [asset](../spec/assets.md) specifications.

## 5. Phased delivery and exit gates

### Phase 0 — prove the subset and select the editor

Deliver a compatibility inventory, a supported Sanity schema, representative
fixtures, and a small editor/renderer integration spike. Pin the tested tooling
versions and record mappings and limitations. Decide whether standard naming
should replace existing custom names before expanding the vocabulary.

**Exit gate:** supported text, marks, lists, and an asset-backed example survive
SPT → Portable Text/Sanity editing → SPT with defined semantic equivalence.
Check ordering, links, marks, keys, alt text, captions, and asset identity.
Unsupported constructs fail with actionable diagnostics. Explicitly define
whether normalized text or editor-generated keys are equivalent; do not use
body-digest equality as an editor round-trip test.

### Phase 1 — ship the reusable builder on current capabilities

Implement text editing, supported headings/lists/marks/links, and the current
single bundled PNG header. Add save/reload, undo/redo, shared previews, asset
validation, and host handoff. Integrate with haili.app and exercise the standalone
harness using the same core. Publish through the existing host flow only.

**Exit gate:** a sender can create, save/reload, edit, preview, and publish supported
content; a recipient reads the same semantics. Existing compose, drafts,
reply/forward, and asset handling remain correct. The standalone harness works
without haili.app account state. Network assertions show no sender-controlled
requests from previews or received content.

### Phase 2 — add a bounded newsletter vocabulary

Use the Coinbase, Indy Ignite, and Starbucks examples as requirements evidence,
not pixel-perfect templates. Proposed priorities, subject to Phase 0:

- Multiple bundled static images between text blocks, optional validated links,
  required meaningful alternatives, optional captions, and uncropped responsive
  sizing. Specify decorative-image labeling separately.
- Prominent navigation links, preferably using existing text and annotation
  structures plus a constrained style if the compatibility spike supports it.
- Bounded labeled link groups with optional bundled icons. Use a custom Portable
  Text object only if ordinary supported blocks cannot express the required
  grouping clearly; supply its Sanity schema and renderer.
- A small semantic presentation vocabulary, such as emphasis or notices, whose
  accessible colors and sizes are chosen by clients. No free-form CSS fields.

Specify image count, encoded bytes, dimensions, decoded pixels, total body size,
node count, and nesting limits together. Evaluate JPEG for photos separately
from layout. Preserve aspect ratio; portrait artwork must not be forced into a
banner crop. Start static-only; no animation, arbitrary SVG, or remote fonts.

**Exit gate:** the chosen profile and asset changes are documented and implemented
across codecs, provider validation, readers, builder, and conformance vectors.
Define whether support is mandatory or negotiated before enabling publication;
current providers reject unknown profiles and fields. No silent downgrade or
discarding unknown received nodes. Any sender-selected simplified edition is a
separate validated body with an explicit loss report, not a mutation of signed
received bytes. Re-run the Sanity compatibility suite for every added feature.

### Phase 3 — templates and controlled import

Offer a few templates made solely from the approved vocabulary: announcement,
newsletter, and image-led promotion. Templates are editable content, not arbitrary
executable plugins or sender-defined renderer code.

Add Portable Text import first, with a visible report of unsupported features.
Treat email HTML conversion as a separate, optional workflow after the native
builder works. Parse untrusted HTML without executing or loading it; retain
content and navigation, not email-client scaffolding. Network asset acquisition
must be a separate controlled operation with redirect, size, timeout, and private
network protections where server fetching is used.

Conversion requirements from the three supplied examples:

- Remove tracking pixels, remote fonts, spacer artwork, VML, and layout tables.
- Extract preheaders only into explicitly specified metadata; omit padding noise.
- Choose a documented alternative-rendering branch; report differing targets.
  Deduplicate equivalent local variants, not intentional repeated calls to action.
- Preserve supplied alt text, including dates or words embedded in artwork.
  Do not invent descriptions or infer image formats from URL suffixes.
- Treat empty links as text. Report unsupported HTTP destinations; do not silently
  upgrade schemes or follow personalized redirects to discover destinations.
- Preserve disclosures and meaningful line breaks. Do not globally remove
  Unicode controls or normalize all whitespace without considering language.
- Report uncertain background-image content and icon/text destination mismatches.

**Exit gate:** sanitized fixtures for all three examples convert with documented
losses, no unrequested network requests, and accessible fallback content. Replace
personalized URLs, recipient addresses, and tracking tokens before committing
fixtures. Every converted output passes the same validators as native authoring.

### Phase 4 — expand only from demonstrated needs

Evaluate two-column content groups, footnote references, a controlled brand
palette, and richer asset formats individually. Each needs a concrete authoring
use case, a Sanity compatibility proof, accessible linear reading order, bounded
resource use, and a specified fallback or unsupported-profile behavior.

General layout grids, custom fonts, animation, arbitrary HTML/CSS, automatic link
previews, collaboration, and campaign analytics are not first-release scope.
Do not add a new primitive merely to reproduce an email's rendering workaround.

## 6. Verification and release discipline

- Maintain positive and adversarial interoperability fixtures for each supported
  type, with pinned upstream test versions and intentional upgrade review.
- Test malicious links, escaped text, unsupported fields, excessive nesting,
  oversized images, malformed assets, and zero rendering-time remote fetches.
- Test draft revision conflicts, failed saves, saved draft reload, undo/reorder,
  narrow preview, keyboard use, and actual host publication acceptance.
- Test preview/recipient semantic parity and body verification independently.
  Rendering can adapt to client preferences; signed bytes cannot be rewritten.
- Keep protocol requirements in `spec/`, importer/provider policy in their own
  documentation, and editor layout choices in client documentation.
- Follow the existing release procedure for any later production rollout; a
  standalone demo does not authorize a separate production deployment.

## 7. Decisions still open

Resolve in Phase 0: the exact tested Sanity/editor versions; standard versus
custom annotation/image names; wire versus editor-only keys; asset interchange;
the UI framework boundary; and supported draft persistence guarantees.

Resolve before Phase 2: the next profile's support requirements and negotiation,
precise resource budgets, standalone export packaging, and which proposed
presentation semantics are truly necessary. No `spt-4` identifier is allocated
by this roadmap.

The first implementation stop condition is Phase 1: a reusable builder that
authors current valid SPT in haili.app and in a standalone harness, backed by
the compatibility and safety evidence. Do not make all future newsletter
features prerequisites for delivering that useful slice.

## References

Primary upstream references consulted 2026-11-04:

- [Portable Text specification](https://github.com/portabletext/portabletext):
  block arrays, spans, keyed annotations, and custom typed objects.
- [Sanity block reference](https://www.sanity.io/docs/studio/block-type):
  configurable styles, lists, decorators, annotations, and custom content.
- [Portable Text project](https://www.portabletext.org/): entry point for the
  editor/tooling evaluation; actual framework and version support must be
  verified during the spike.

These establish the extension model, not proof that current SPT already passes
the proposed interoperability gates. Record that proof in the implementation.
