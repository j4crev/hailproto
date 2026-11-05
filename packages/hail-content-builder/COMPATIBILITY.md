# Phase 0 compatibility inventory and editor decision

This is a client integration contract and evidence record, not a new protocol
profile. The authoritative wire vocabulary remains in `spec/bodies.md`,
`spec/assets.md`, the codecs, and the conformance vectors. Phase 1 stops at the
current text vocabulary plus one bundled PNG header.

## Tested toolchain

Pinned direct integration versions: `@portabletext/editor` **8.2.11**, React and
React DOM **19.3.1**, `@sanity/schema` **6.22.0**, `@portabletext/to-html` **6.0.0**,
Svelte **5.57.2**. Transitive versions are locked in `bun.lock`. Upgrade these
intentionally and repeat both semantic and browser tests.

The official editor is a React editor, not a native Svelte component. The bounded
spike selected an in-process React root, mounted/disposed inside the reusable
Svelte shell. It needs no iframe messaging, credentials or remote Sanity backend.
The independently built app measured approximately **149 KB gzip** for the shell
and shared codec validators, plus **210 KB gzip** for the lazily loaded editor.
This cost buys maintained selection, IME, clipboard, undo and Portable Text editing
instead of a custom rich-text engine. The same DOM mounting API works in other
web clients when built with Svelte-aware tooling; an unbundled drop-in script is
not supplied. No iframe or network API is needed for the core/UI boundary.

Primary upstream references:
[Portable Text specification](https://www.portabletext.org/specification),
[official editor and framework requirements](https://github.com/portabletext/editor),
[Sanity block configuration](https://www.sanity.io/docs/studio/block-type).
The installed editor README and declarations were also used to verify the exact
API for this pinned release.

## Model mappings and semantics

| Concern | Current SPT | Portable Text / supported Sanity integration |
| --- | --- | --- |
| Text blocks/spans | `block`, `span`, children and marks | Same standard structures; no flattened/Markdown intermediate |
| Styles | normal, h1–h3, blockquote, caption | Same names; caption is an explicitly configured custom style |
| Decorators | strong, em, code | Same configured names; combinations preserved |
| Annotation | `spt.link`, block-local key, href, optional title | Conventional `link`, same key/href/title; strict HTTPS/credential rules on import/export |
| Lists | bullet/number, optional level 1–3 | Same names and levels; omitted level equivalent to 1 |
| Block/span identity | Wire schemas forbid `_key` | Generated stable editor keys; retained during editing, regenerated on a fresh body load |
| Annotation identity | Required `_key`, referenced by marks | Preserved; changing both key and references is semantically equivalent |
| Image | First `spt.image`, local asset ID, alt/caption | Custom `hailImage` object, local asset ID, alt/caption plus paired bundle |
| Asset | Bundled digest-verified PNG manifest | Asset metadata **and bytes** travel in the bundle; not a CDN URL or fabricated Sanity asset reference |
| Wrapper | version/profile/assets/blocks, deterministic CBOR for transport | Not itself a Portable Text array; exported bundle explicitly separates blocks from assets |

Keep `spt.link` and `spt.image` on the current wire: the link adapter is a lossless
name mapping; the image represents a verified local bundle, a distinct purpose
from Sanity's remote image reference/crop/hotspot model. Do not rename it to the
built-in Sanity `image` while retaining incompatible fields. No obsolete alpha
format or new profile is added by this choice. Custom `hailImage` schemas and
rendering are necessary; default Sanity image/CDN renderers are not compatible.

Semantic equivalence compares ordered blocks, exact text, styles, lists, effective
marks/link targets/titles, image alt/caption and asset identity/bytes. It ignores
block/span editor keys, consistent annotation-key renaming, mark ordering,
segmentation of adjacent identically marked spans, and unused annotations. Empty
blocks remain ordered blocks. Empty spans do not contribute text. Body-digest
identity is **not** an editor round-trip criterion. Line breaks and Unicode text
are preserved exactly; editor keys are not a reason to rewrite signed bytes.
Image descriptions/captions must meet existing NFC/plain-text requirements; UI
entry normalizes those fields explicitly. Text itself is not globally normalized.

## Interoperability evidence

`fixtures/text.json` covers every style, all decorators including combinations,
links with titles, mixed/nested lists, line breaks, multilingual text and an empty
block. Unit tests compile the supplied `contentSchema` with the pinned Sanity
schema compiler, render the text through the pinned Portable Text renderer, and
round-trip a digest-verified PNG bundle. Adversarial cases cover unknown fields,
unknown/custom types, invalid links, keys/levels/marks, excessive content, damaged
PNG chunks and digest mismatch. Unsupported constructs are rejected with field
paths, not silently stripped or downgraded.

The independent browser harness loads this fixture plus an asset, loads it into
the official editor, edits/saves/reloads it, checks semantic equality, undo/redo,
reordering, explicit saves of unfinished headers, conflicting host revisions, narrow layouts and image
fallback. It records all network requests and rejects sender-controlled origins.
The web client's acceptance tests separately prove direct publication handoff and
rich draft save/resume. The shared renderer is used for both preview and received
content; content cannot inject HTML, CSS, scripts, remote fonts or image URLs.
Links are navigation only and may track a user who chooses to click them.

This proves the configured subset with the pinned schema/compiler, renderer and
standalone editor. It does not claim a deployed Sanity Studio/Content Lake upload
integration, default rendering of custom objects, compatibility with arbitrary
Sanity releases, or unrestricted Portable Text import. To use the schema in a
Studio, include `contentSchema` as an array type and keep the accompanying assets
in a separately controlled bundle; enforce `fromPortable` before exporting to Hail.
No backend asset acquisition is performed automatically.

## Remaining validation and limits

Automated Chromium tests exercise focusable buttons, actual text entry, undo/redo,
save/reload and responsive layout. Human screen-reader, touch, IME and cross-browser
usability evaluation remains necessary before making broader accessibility claims.
Header operations use separate form state, not the text editor's history.
Saving is explicit; there is no recovery copy or unsaved-change warning.
Host save failures remain visible and host CAS remains mandatory.
No protocol vocabulary expansion, HTML newsletter conversion, remote asset import,
collaboration or production rollout is included.
