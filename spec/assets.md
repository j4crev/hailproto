# Hail Asset Manifest

Status: Draft

This document defines the first bounded asset primitive shared by message bodies
and Sender Profile v2. Version 1 supports bundled PNG images only. It does
not fetch arbitrary URLs, expose user opens to senders, or define attachments.

## Manifest

```json
{
  "version": 1,
  "assets": [
    {
      "id": "hero-image",
      "role": "header",
      "media_type": "image/png",
      "loading": "bundled",
      "size": 48321,
      "digest": { "algorithm": "sha-256", "value": "<32 bytes>" },
      "width": 1200,
      "height": 480,
      "data": "<48321 bytes>"
    }
  ]
}
```

The manifest and every entry are closed Hail maps. A manifest contains one or
two entries, with unique `id` and `role` values. IDs match
`[a-z][a-z0-9-]{0,63}`. Version 1 roles are `avatar` and `header`.

Each entry uses `image/png` and `bundled`; `size` equals the byte-string length,
and `digest` is SHA-256 over those exact bytes. The bytes must be a structurally
bounded, non-animated PNG whose IHDR dimensions equal `width` and `height`.
Decoders still treat image bytes as untrusted input.

| Role | Maximum bytes | Maximum width | Maximum height | Maximum pixels |
| --- | ---: | ---: | ---: | ---: |
| `avatar` | 32 KiB | 512 | 512 | 262,144 |
| `header` | 192 KiB | 2,400 | 1,200 | 2,000,000 |

Message and profile schemas decide which roles they permit and reference assets
by `id`; the manifest alone grants no rendering position. Meaningful message
images require alt text at the referencing block. Clients serve verified bytes
from local storage with `Content-Type: image/png` and `X-Content-Type-Options:
nosniff`; they never convert manifest data into a sender-controlled URL.

Deferred: JPEG/WebP, animation, remote loading, attachments, responsive
variants, and manifests containing more than one asset per role.
