# Portable content builder

A reusable TypeScript content builder, with a standalone app and Hail web-client
integration. No Hail account, Sanity project, provider API, or hosted backend is
required to edit. The host controls persistence and publication. This workspace
package is not yet published to a public package registry.

Run the independent application from the repository root:

```sh
bun install
bun run --cwd packages/hail-codec-ts build
bun run --cwd apps/content-builder dev
```

`bun run --cwd apps/content-builder build` produces a static `dist/` application.
Serve it on localhost or HTTPS (Web Locks and image hashing need a secure context).
It saves explicitly on the current device with **Save as Draft**, and exports a
validated Hail body on **Use this content**. There is no automatic recovery, bundle
file import/export, or unsaved-change warning.
It does not publish or contact Hail/Sanity services. Clearing browser storage removes
local drafts. Hail uses the account Drafts folder instead of this demo storage.

## Integrate into any web client

Use a bundler supporting Svelte components (Vite with the Svelte plugin is the
included example). The public API is ordinary TypeScript and a DOM element;
React, Vue, Svelte and plain JavaScript hosts can all call it. Svelte owns the
builder shell and the official React Portable Text editor owns its editing area.
Neither framework's application state is required from the host. A prebundled
CDN script/custom element is not part of this initial release.

```ts
import {mountBuilder} from '@racrproto/content-builder';
import {emptyBody} from '@racrproto/content-builder/core';

const instance = mountBuilder(document.getElementById('editor')!, {
  version: 1,
  profiles: ['spt-2', 'spt-3'],
  initial: {version: 1, body: emptyBody()},
  revision: 0,
  save: async (draft, expectedRevision) => {
    // Your storage must atomically compare expectedRevision before replacing data.
    // Reject on conflict or ambiguous save; return only the acknowledged revision.
    return myDraftStore.save(draft, expectedRevision);
  },
  change: (draft, diagnostics) => {
    // draft is null when input cannot be saved; diagnostics also report send errors.
  },
  handoff: draft => myPublicationFlow(draft.body),
});

// Before removing the container:
await instance.dispose();
```

`BuilderHost` in `src/core.ts` is the v1 host contract. Initial document and bundled
assets are carried in the validated draft body; supported profiles are explicit.
Change events contain a draft snapshot and publication diagnostics. An empty image
description is allowed in a draft, but prevents preview/handoff until completed. Saves carry
an expected revision and must acknowledge a newer revision. A rejected save retains
editor input. Handoff does not confer authorization or bypass host validation.
`toPortable` exports JSON blocks plus verified bundled assets; `fromPortable`
imports them strictly; `{draft:true}` permits unfinished image descriptions.
These are programmatic adapters, not file controls. Disposal removes editor listeners.

The `./svelte` entry exposes the same component for Svelte hosts; `./core`,
`./schema` and `./rendering` do not import editor UI or host services.
`./renderer` is shared by builder preview and Hail's received-message view.
All buttons are non-submitting so embedding inside a host form is supported.
Svelte hosts can set `showPreview={false}` and render change snapshots in their
existing preview. Hail uses its shared Preview / Back to writing toggle, keeping
the editor mounted so previewing preserves editing history.

## Included authoring behavior

Paragraphs, H1–H3, quotes, captions, bullet/number lists with levels 1–3, bold,
italic, code, HTTPS links, block insertion/duplication/deletion/reordering and
undo/redo are available without drag-and-drop. A compact icon toolbar groups
formatting actions, names paragraph styles, and exposes block operations through
a keyboard-accessible disclosure menu. List-only indent/outdent controls enforce
levels 1–3. Icon buttons have accessible names and native title tooltips. Native keyboard editing and
IME handling belong to the upstream editor. The Text / Image palette inserts blocks after the selection. Images are local
static PNGs with required alternative text and optional captions. Up to eight
image blocks may appear among text, with drag handles and keyboard Move up/down
alternatives. Image bytes stay in the local bundle; no remote URL is accepted. Preview has
narrow/wide, light/dark and images-unavailable settings and uses the recipient
renderer. The interface reflows to small screens; the toolbar is more comfortable
at wide widths. Plain-text paste preserves text and explicitly reports dropping
HTML formatting. Arbitrary HTML import is intentionally absent.

Undo/redo includes text, image insertion/removal, descriptions, captions and
block reordering. Removed asset bytes stay in memory for undo; saved and published
bodies include only referenced assets. Explicit saves permit unfinished image
descriptions. Handoff and publication require a complete,
validated body; empty text documents can be saved as drafts.

In Hail, new subscriber and connection messages open directly in the builder.
Existing simple-compose drafts are converted on load using their existing text
formatting semantics, including title and bundled header. Loading is read-only;
only **Save as Draft** writes the structured representation, using the same draft
ID, revision, audience and attachments. Unsupported legacy content stays in the
original composer with a visible explanation, so it remains editable without
silently dropping fields. Rich drafts are never converted back to Markdown.
**Save as Draft**, **Send message**, and the shared preview remain the host flow.
Connections permit rich text only, reflecting current reference-provider policy.
Inline replies and forwards retain their existing editors and authority handling.

## Verification

```sh
bun run --cwd packages/hail-content-builder test
bun run --cwd packages/hail-content-builder typecheck
bun run --cwd apps/content-builder test:browser
bun run --cwd apps/client test
bun run --cwd apps/client test:compose
```

Browser checks use installed Chromium and do not need a logged-in account.
See [compatibility evidence and limits](COMPATIBILITY.md). No production deployment
is implied by building the standalone app or integrating the package.

The builder body is capped at 360,000 UTF-8 JSON bytes so provider draft requests
fit the existing 400,000-byte account API limit. Portable bundles allow 1,000,000
bytes to accommodate editor keys without making a valid near-limit body impossible
to export/reimport. The resulting body must still fit its own limit and all codec
budgets. No resource limit is relaxed for publication.

Rollout requires the updated provider and client together: older providers reject
the optional `builder` draft field. This uses the existing JSON draft storage and
needs no new database migration. An application rollback to code predating the
builder cannot edit these rich drafts; retain/export them before such a rollback.

## Inline image slice

Current `spt-3` supports one to eight image blocks among text. Each static PNG is
at most 192 KiB, 2400 × 2400, and two million pixels; all displayed image
occurrences total at most eight million pixels. The editor's existing 360,000-byte
JSON body budget is intentionally unchanged (and can limit uploads before the
protocol's 1 MiB encoded ceiling). Images preserve aspect ratio without cropping.
Check **Use as Feed header** on an image to designate the message's featured
image. It moves to the top and retains the `header` role (2400 × 1200 maximum),
which the Feed already displays. Other images retain the `image` role. Choosing
a different header keeps the previous one inline; unchecking the option removes the
Feed designation. The header counts toward the eight-image total and is pinned
against drag/Move actions until made inline. Role changes use editor history.
No received signed document is rewritten.

Upload failures appear in a persistent, dismissible red alert toast using Hail's
existing bottom-center notification placement. The upload control tooltip states
the 192 KiB limit. New images show description guidance beside their field; they
can be saved unfinished but cannot be sent until described. Other validation
errors remain beside the document in a red panel.

Upgrade the provider, client and codecs together before publishing this expanded
alpha vocabulary. Existing leading-header messages still validate. This slice
adds neither recovery/autosave nor templates, image links, JPEG conversion or
free-form layout. Touch users can select a block handle and use Block actions.

## Block settings

Select an image or button on the canvas (or focus its block handle) to edit it in
the **Block settings** panel. Image descriptions, captions, Feed-header selection
and removal, plus button labels and destinations, live outside the canvas. The
canvas displays the image and caption or button itself. Text stays directly
editable, with formatting in the toolbar. Selecting another block changes the
panel without saving or discarding edits; all changes share the same undo history.
The panel sits outside the editor in a sticky right sidebar when at least 1000px
is available for the workspace. Narrow layouts use a **Block settings** button
and modal bottom sheet with Done/Escape dismissal and focus returned to the
selected block. Hosts may supply an `inspectorTarget` element beside their whole
compose form; its parent supplies the workspace width and `data-builder-wide`
layout state. Editing and preview keep the same compose width. This changes only editor presentation, not saved SPT or drafts.

## Calls to action and text alignment

**＋ Button** inserts a call to action with editable label and HTTPS destination.
The toolbar aligns the selected text or CTA block left, center or right; left is
the default. CTA label/URL changes and alignment share the editor's undo history.
CTA labels are one line, up to 128 UTF-8 bytes; destinations are at most 2048 UTF-8
bytes and cannot contain login credentials. Unfinished CTA fields can be saved as
drafts, but block preview/handoff/sending until completed. Preview lists the
specific missing fields, identifies the affected block, and offers **Edit block**
to open its settings. Button settings omit persistent instructional text.

The wire representation is a constrained `cta` text style with one link annotation
and an optional `alignment` field. Both current `spt-2` and `spt-3` support it,
including connection text. No new profile or sender CSS is introduced. Upgrade the
provider, clients and codecs together before publishing these alpha additions.
