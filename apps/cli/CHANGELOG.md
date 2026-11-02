# Hail CLI release notes

## 0.1.2 (prerelease)

The `v0.1.1` tag did not produce a release: GitHub rejected its workflow because
the reusable CI workflow required read permissions that its caller omitted.
Version 0.1.2 supplies those permissions and carries the intended 0.1.1 changes
below. The immutable `v0.1.1` tag is retained.

- Plain-text sends and conversation replies now support bodies up to 1 MiB,
  including their encoded Safe Portable Text framing. The CLI checks the exact
  encoded size locally and rejects oversized text before submission.
- Retry files accommodate larger messages, including JSON escaping and the
  duplicated text retained by conversation operations.
- Message and conversation reads allow larger responses for the expanded body
  budget. Unrelated account API responses retain their existing limits.
- `grant update` help clarifies that omitted categories are removed from the
  full-state revision and expanded permission requires fresh verified consent.

### Upgrade and compatibility

Replace the `hailp` executable using the archive, checksum, and provenance
verification steps in [the installation guide](docs/cli-installation.md).
No CLI credential, vault, or retry-file migration is required.

Bodies above the former 256 KiB ceiling require providers implementing the new
1 MiB body budget. Older providers can reject them; this remains an alpha
protocol without a promise of cross-version interoperability. The CLI still
composes plain-text `spt-1` bodies; this release does not add advanced publisher
layouts or general file attachments.

Provider upgrades are separate from installing the CLI. The matching provider
change includes database migration 98; its rollback refuses retained bodies
above 256 KiB rather than truncating them. Follow the
[provider content-storage guidance](../../agents/content-storage-and-attachments.md)
when upgrading or rolling back a provider.

Release binaries target Linux x86-64, with packaged-artifact checks on Ubuntu
22.04 and 24.04. This release remains a prerelease.
