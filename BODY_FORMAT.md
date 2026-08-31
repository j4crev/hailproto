# Hail Body Format Notes

Hail message bodies need to be secure by design while still allowing senders to create beautiful, branded messages.

The preferred direction is not raw HTML. It is a structured visual document format that can be rendered by clients into safe HTML, native UI, plain text, or other presentation targets.

## Core Idea

Authoring format and wire format do not need to be the same thing.

Senders may use visual composers, drag-and-drop editors, templates, or conversion tools. The transmitted body should be a schema-validated document structure, not arbitrary markup.

```text
Sender composer -> Hail Body document -> recipient client renderer -> safe UI
```

This avoids the email model:

```text
Sender HTML -> sanitizer -> risky render
```

## Why Not Raw HTML

Raw HTML is powerful, but it brings a large attack surface:

- scripts
- iframes
- external resources
- tracking pixels
- arbitrary CSS
- hidden content
- fake UI overlays
- parser differentials
- inconsistent rendering across clients
- phishing-friendly layout tricks

Even strong sanitizers still require clients and servers to safely parse untrusted markup. A better format makes dangerous behavior impossible to express.

## Recommended Strategy

Use a Safe Portable Text-style structured block document model.

A Hail Body should mimic Portable Text's general shape while allowing only a strict, security-reviewed subset of fields, marks, annotations, and block types. New Safe Portable Text-specific blocks can be added over time when the project needs them.

A Hail Body should be a tree of typed blocks and inline content, plus optional theme tokens and declared asset references.

Example:

```json
{
  "version": 1,
  "theme": {
    "accent": "#146ef5",
    "font": "sans",
    "radius": "medium",
    "density": "comfortable"
  },
  "blocks": [
    {
      "type": "heading",
      "level": 1,
      "text": "Weekend Sale"
    },
    {
      "type": "paragraph",
      "inlines": [
        { "type": "text", "text": "Save up to " },
        { "type": "text", "text": "40%", "strong": true },
        { "type": "text", "text": " on summer gear." }
      ]
    },
    {
      "type": "image",
      "asset": "hero-image",
      "alt": "Weekend sale banner"
    },
    {
      "type": "button",
      "label": "Shop Sale",
      "url": "https://example-store.com/sale"
    }
  ]
}
```

## Safe Portable Text Starter Kit

Hail should start with a constrained Portable Text-like profile rather than arbitrary Portable Text.

Portable Text uses arrays of blocks, where text blocks contain child spans and mark definitions. Hail can preserve that familiar syntax while restricting what is valid.

Starter document shape:

```json
{
  "version": 1,
  "profile": "spt-1",
  "theme": {
    "accent": "#146ef5",
    "font": "sans",
    "radius": "medium",
    "density": "comfortable"
  },
  "blocks": [
    {
      "_type": "block",
      "style": "h1",
      "children": [
        {
          "_type": "span",
          "text": "Weekend Sale",
          "marks": []
        }
      ],
      "markDefs": []
    },
    {
      "_type": "block",
      "style": "normal",
      "children": [
        {
          "_type": "span",
          "text": "Save up to ",
          "marks": []
        },
        {
          "_type": "span",
          "text": "40%",
          "marks": ["strong"]
        },
        {
          "_type": "span",
          "text": " on summer gear.",
          "marks": []
        }
      ],
      "markDefs": []
    },
    {
      "_type": "spt.image",
      "asset": "hero-image",
      "alt": "Weekend sale banner"
    },
    {
      "_type": "spt.button",
      "text": "Shop Sale",
      "url": "https://example-store.com/sale"
    }
  ]
}
```

Allowed top-level fields:

- `version`: integer profile version.
- `profile`: exact body profile identifier.
- `theme`: optional safe design tokens.
- `blocks`: ordered array of valid blocks.

No unknown top-level fields should be accepted in v1. Strict validation is better than permissive parsing for the first security profile.

### Allowed Text Block

Portable Text-style text blocks should use `_type: "block"`.

Allowed fields:

- `_type`: must be `block`.
- `style`: one of `normal`, `h1`, `h2`, `h3`, `blockquote`, or `caption`.
- `children`: array of `span` nodes.
- `markDefs`: array of allowed annotation definitions.
- `listItem`: optional, one of `bullet` or `number`.
- `level`: optional integer from `1` to `3`, only valid with `listItem`.

Disallowed fields:

- arbitrary custom styles
- raw HTML
- inline objects inside `children` for v1
- hidden text flags
- layout or positioning fields

### Allowed Span Node

Allowed fields:

- `_type`: must be `span`.
- `text`: string.
- `marks`: array of allowed decorator names or annotation keys.

Allowed decorator marks:

- `strong`
- `em`
- `code`

Possible later decorator marks:

- `underline`
- `strike`

Disallowed span behavior:

- arbitrary style marks
- custom colors per span
- custom font sizes per span
- hidden text
- embedded HTML

### Allowed Mark Definitions

The only recommended v1 annotation is a link.

Example:

```json
{
  "_key": "link-1",
  "_type": "spt.link",
  "href": "https://example-store.com/sale",
  "title": "Shop the weekend sale"
}
```

Allowed link fields:

- `_key`: unique mark id within the block.
- `_type`: must be `spt.link`.
- `href`: HTTPS URL.
- `title`: optional human-readable link description.

Link restrictions:

- `href` must use `https://`.
- `mailto:`, `tel:`, `javascript:`, `data:`, and custom schemes are disallowed in v1.
- clients should warn when `href` points outside the verified sender domain or approved link domains.
- visible raw URLs should match the destination URL or be rendered with a warning.

### Allowed SPT Blocks

Safe Portable Text-specific blocks should use namespaced `_type` values so they do not collide with Portable Text's base model.

Recommended starter blocks:

- `spt.image`
- `spt.button`
- `spt.divider`
- `spt.callout`
- `spt.keyValue`
- `spt.footer`

These blocks give enough visual range for early newsletters, receipts, alerts, and account messages without opening a general layout engine.

### `spt.image`

```json
{
  "_type": "spt.image",
  "asset": "hero-image",
  "alt": "Weekend sale banner",
  "caption": "Optional caption"
}
```

Allowed fields:

- `asset`: id of a declared asset in the message manifest.
- `alt`: required for meaningful images.
- `caption`: optional short text.

Disallowed fields:

- arbitrary `src` URLs
- inline base64 image data
- CSS dimensions
- click maps
- image overlays

### `spt.button`

```json
{
  "_type": "spt.button",
  "text": "View Statement",
  "url": "https://bank.example/statements/123",
  "variant": "primary"
}
```

Allowed fields:

- `text`: visible button label.
- `url`: HTTPS URL.
- `variant`: optional, one of `primary`, `secondary`, or `plain`.

Button restrictions are the same as link restrictions.

### `spt.divider`

```json
{
  "_type": "spt.divider"
}
```

No additional fields are needed for v1.

### `spt.callout`

```json
{
  "_type": "spt.callout",
  "tone": "warning",
  "title": "Payment failed",
  "text": "Update your card to avoid service interruption."
}
```

Allowed fields:

- `tone`: one of `info`, `success`, `warning`, or `danger`.
- `title`: optional short text.
- `text`: required body text.

### `spt.keyValue`

```json
{
  "_type": "spt.keyValue",
  "items": [
    { "key": "Order", "value": "12345" },
    { "key": "Total", "value": "$42.19" }
  ]
}
```

Allowed fields:

- `items`: array of key/value text pairs.

This is useful for receipts, bookings, account notices, and summaries without needing tables in v1.

### `spt.footer`

```json
{
  "_type": "spt.footer",
  "text": "You are receiving this because you subscribed to promotions.",
  "links": [
    {
      "text": "Manage subscription",
      "url": "https://example-store.com/preferences"
    }
  ]
}
```

Allowed fields:

- `text`: footer text.
- `links`: optional array of HTTPS links.

Footer links do not replace protocol-level grant revocation. Clients should always provide local unsubscribe/revoke controls outside the message body.

### Excluded From Starter Kit

These should not be part of the v1 Safe Portable Text profile:

- raw HTML blocks
- arbitrary custom blocks
- arbitrary custom marks
- forms
- embeds
- iframes
- scripts
- tables
- columns
- absolute layout controls
- CSS classes
- inline styles
- remote fonts
- arbitrary image URLs
- video and audio
- SVG
- interactive widgets
- client-specific extensions

Some excluded features may become safe later as Safe Portable Text-specific blocks with strict schemas and fallback rules.

### Unknown Fields And Unknown Blocks

For v1, unknown fields and unknown block types should be rejected during validation.

Longer term, Hail can allow versioned extensions only if they include safe fallbacks and cannot introduce active behavior.

## Security Rules

The body format should enforce these rules:

- no script execution
- no iframes or embeds
- no forms in v1
- no arbitrary CSS
- no absolute positioning
- no z-index or overlays
- no undeclared external resources
- no hidden tracking pixels
- no remote fonts in v1
- mandatory alt text for meaningful images
- mandatory readable fallback for visual blocks

The safest rule is that body content may only reference assets declared in the message manifest.

Example asset reference:

```text
spt-asset:hero-image
```

## Design Tokens Instead Of CSS

Hail should avoid arbitrary CSS and use controlled design tokens instead.

Examples:

- accent color
- font family category, such as `sans`, `serif`, or `mono`
- border radius scale
- spacing density
- tone, such as `info`, `success`, `warning`, or `danger`
- button variant
- section emphasis

This gives brands expressive control without giving them a full browser layout engine.

## Candidate V1 Blocks

The first useful body vocabulary should be small but expressive.

Recommended POC blocks:

- paragraph
- text inline spans

Recommended early rich blocks:

- heading
- paragraph
- image
- button
- divider
- list
- key-value
- callout
- footer

Possible later blocks:

- section
- card
- columns
- table
- receipt
- itinerary
- event
- product
- coupon

Layout-heavy blocks such as `columns`, `table`, and `section` should be added carefully because layout primitives can become a path back to HTML-like complexity.

## Replies

Replies do not need the same expressive format as sender messages.

Recommended reply body support:

- plain text
- paragraphs
- bold and italic inline spans
- links
- quoted prior text
- small attachments later

Receivers do not need hero images, columns, or marketing layouts for most replies.

## Assets

Assets should be declared outside the body in a manifest.

Each asset should include:

- id
- content type
- byte size
- hash
- dimensions, where relevant
- role
- loading mode

Body blocks should reference assets by id or content hash, not by arbitrary URL.

This allows clients and recipient servers to:

- block remote assets
- proxy remote assets
- cache assets
- deduplicate assets
- verify hashes before rendering
- render placeholders safely

## URL Safety

Links and buttons remain a phishing surface even without HTML.

Clients should clearly show destination domains and warn when a link points away from the verified sender domain.

Sender profiles may declare approved link domains.

Example:

```json
{
  "verified_domain": "airline.example",
  "allowed_link_domains": [
    "airline.example",
    "booking.airline.example",
    "payments.airline.example"
  ]
}
```

## Accessibility

A structured body format can enforce accessibility better than email HTML.

The format should require:

- alt text for meaningful images
- semantic heading levels
- meaningful button labels
- readable text fallback
- visual order matching reading order
- no color-only meaning

Clients can then render accessibility-first views, larger text modes, dark mode, and reduced-motion experiences.

## Renderer Consistency

The main risk of client-owned rendering is inconsistent output.

Hail should eventually provide:

- official renderers
- sample documents
- schema validators
- conformance tests
- visual rendering expectations
- fallback behavior tests
- accessibility tests

Without this, senders may push for raw HTML because they cannot trust how clients will render their messages.

## Portable Text

Portable Text is worth serious consideration, but probably not as the complete Hail Body format by itself.

Portable Text is an open JSON-based rich text specification originally from Sanity. It is designed around portable structured content rather than HTML strings.

Strengths:

- open specification
- JSON-based and easy to inspect
- good model for spans, marks, annotations, and rich text
- supports custom block types
- avoids raw HTML as the primary content representation
- compatible with modern editor workflows
- useful prior art for schema and inline text modeling

Gaps for Hail:

- not specifically designed for secure inter-server messaging
- not a complete branded message layout system
- extension model could hurt interoperability if unconstrained
- does not by itself define Safe Portable Text-specific asset privacy rules
- does not by itself define safe design tokens
- does not by itself define phishing-resistant link policy
- does not by itself define client renderer conformance
- does not solve message-specific blocks like receipts, itineraries, coupons, or account alerts

Best use of Portable Text:

- borrow or adopt its inline span and mark model
- study its block representation and extension approach
- potentially define a strict Safe Portable Text profile of Portable Text

Risky use of Portable Text:

- allowing arbitrary custom Portable Text blocks from any sender
- treating Portable Text as sufficient without a Safe Portable Text renderer spec
- allowing extensions that only one client understands

## Recommended Portable Text Approach

The best path may be a Safe Portable Text profile inspired by Portable Text:

```text
Safe Portable Text Profile v1
- Portable Text-like inline spans and marks
- fixed Safe Portable Text block vocabulary
- no arbitrary custom blocks in v1
- declared assets only
- design tokens instead of CSS
- mandatory fallback rules
- strict schema validation
- official renderer behavior
```

This captures the benefits of Portable Text without outsourcing Hail's security and interoperability model to a more general content format.

## POC Recommendation

For the prototype, use the body structure even if only plain text is supported.

```json
{
  "version": 1,
  "blocks": [
    {
      "type": "paragraph",
      "inlines": [
        { "type": "text", "text": "Hello from the prototype." }
      ]
    }
  ]
}
```

This keeps the prototype simple while preserving the path to a richer block document format.

## Open Gaps

- Decide whether Hail Body should use Portable Text directly, Safe Portable Text, or a custom format inspired by Portable Text.
- Define the exact v1 block vocabulary.
- Define the inline text model.
- Define the asset manifest schema.
- Define allowed URL behavior and client warning rules.
- Define design tokens.
- Define fallback rules for unsupported blocks.
- Define renderer conformance tests.
- Define whether body documents are JSON, CBOR, or both.
- Define how semantic message types like receipts and itineraries map to visual blocks.

## Current Recommendation

Use a structured visual document format, not raw HTML.

For v1, define a strict Hail Body profile that uses Safe Portable Text: a Portable Text-inspired profile with security, asset, link, theme, and renderer rules suitable for untrusted messaging.
