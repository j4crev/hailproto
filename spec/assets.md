# Hail Asset Manifest

Status: Draft

This document defines the first bounded asset primitive shared by message bodies
and Sender Profile v2. Version 1 supports bundled PNG images only. It does
not fetch arbitrary URLs or expose user opens to senders. Detached file
[attachments](attachments.md) use a separate authenticated list.

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

The manifest and every entry are closed Hail maps. A manifest contains one to
eight entries, with unique `id` values. The `avatar` and `header` roles occur at most once; `image` may repeat. IDs match
`[a-z][a-z0-9-]{0,63}`. Version 1 roles are `avatar`, `header`, and `image`.

Each entry uses `image/png` and `bundled`; `size` equals the byte-string length,
and `digest` is SHA-256 over those exact bytes. The bytes must be a structurally
bounded, non-animated PNG whose IHDR dimensions equal `width` and `height`.
Decoders still treat image bytes as untrusted input.

| Role | Maximum bytes | Maximum width | Maximum height | Maximum pixels |
| --- | ---: | ---: | ---: | ---: |
| `avatar` | 32 KiB | 512 | 512 | 262,144 |
| `header` | 192 KiB | 2,400 | 1,200 | 2,000,000 |
| `image` | 192 KiB | 2,400 | 2,400 | 2,000,000 |

Message and profile schemas decide which roles they permit and reference assets
by `id`; the manifest alone grants no rendering position. Meaningful message
images require alt text at the referencing block. Clients serve verified bytes
from local storage with `Content-Type: image/png` and `X-Content-Type-Options:
nosniff`; they never convert manifest data into a sender-controlled URL.

Deferred: JPEG/WebP, animation, remote loading, responsive
variants.

SPT-3 permits only `image` and `header` assets, with at most eight image blocks
and eight million decoded pixels summed over image-block occurrences. Every asset
MUST be referenced. Repeated references count against both display limits. A
`header` asset is reserved for a leading image block; `image` assets can appear
anywhere. Sender Profile v2 continues to permit exactly one `avatar` asset only.

These asset limits are independent of the 1 MiB message-body ceiling. Bundled
bytes count toward both their per-asset limit and the complete body limit.
Detached attachments have their own 25 MiB aggregate byte and 20-file count
budgets; a larger body ceiling does not authorize larger images.
