# Install hailp

The default executable is native Rust. Linux x86-64 is the supported release
platform; users need system CA roots and the normal Linux C runtime, but no Bun,
Node, pnpm or Rust installation to run a release binary.

## Download a release

Check [GitHub Releases](https://github.com/j4crev/hailproto/releases) for a
published version. At the initial readiness assessment there were no published
releases; until the first one is published, use the source-build instructions
below. These commands are the download procedure **once that version exists**.

On Linux x86-64, choose the version explicitly from the release page. Run this in
Bash, replacing `X.Y.Z` with that version (without the `v` prefix):

```bash
(
  set -euo pipefail
  version='X.Y.Z'
  test "$(uname -s)" = Linux && test "$(uname -m)" = x86_64
  archive="hailp-${version}-linux-x64.tar.gz"
  base="https://github.com/j4crev/hailproto/releases/download/v${version}"
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  cd "$work"
  curl --fail --location --proto '=https' --proto-redir '=https' \
    --output "$archive" "$base/$archive"
  curl --fail --location --proto '=https' --proto-redir '=https' \
    --output "$archive.sha256" "$base/$archive.sha256"
  sha256sum --check "$archive.sha256"
  tar -xzf "$archive" hailp
  test "$(./hailp --version)" = "$version"
  install -Dm755 hailp "$HOME/.local/bin/hailp"
)
export PATH="$HOME/.local/bin:$PATH"
hailp --version
```

Add `export PATH="$HOME/.local/bin:$PATH"` to your shell startup file if needed.
Downloads require curl, tar and sha256sum. Checksums detect corrupted downloads;
because both files come from the same release, they are not independent proof of
publisher identity. Signed provenance is tracked in the production-readiness checklist.
Do not disable TLS verification if a download fails.

The current build uses the runner's Linux C runtime. A minimum glibc/distribution
version has not yet been qualified. A `GLIBC_* not found` error requires a
compatible release or a local source build; installing Bun will not fix it.

## Upgrade or uninstall

Read the selected release notes before upgrading. Record `hailp --version`, keep
the previous executable if rollback is needed, and repeat the versioned download
procedure. Existing credentials, vaults and retry state stay at the paths you chose;
keep them until their operations are confirmed complete. Binary rollback does not
reverse provider changes or guarantee older software can read newer state formats.

To remove the executable installed above:

```bash
rm -- "$HOME/.local/bin/hailp"
```

This does not revoke credentials or delete recovery material. Revoke unwanted
access through your provider before disposing of private credential files; retain
recovery backups for identities you still own.

## Build from source

Build a reviewed revision with rustup, a C linker and Python 3 installed. Rust
1.97.1 and Cargo dependencies are pinned in `apps/cli`. No provider credentials,
database, vault or live account is needed.

```bash
git clone https://github.com/j4crev/hailproto.git
cd hailproto
python3 apps/cli/scripts/build.py
install -Dm755 apps/cli/dist/hailp "$HOME/.local/bin/hailp"
hailp --version
hailp account show --help
```

Alternatively, run `cargo build --release --locked` inside `apps/cli` and install
`target/release/hailp` directly. Put `$HOME/.local/bin` on PATH. HTTPS certificate
verification remains enabled; keep private credentials and vaults separate.

Tagged releases retain `hailp-<version>-linux-x64.tar.gz` and its SHA-256 checksum.
Verify the checksum before extracting and installing the executable. Builds on
newer Linux distributions may require a newer glibc; cross-distribution static
binaries are not currently promised. The package remains private; a local build
is not registry publication.

## Development

Workspace development and test fixtures use Bun 1.4.0, Node 26.7.0 and pnpm
11.11.0 with the pinned PLC submodule. Install those dependencies, then
`bun run build:cli` builds the native executable and `bun run test:cli` runs its
unit and workflow regressions. The `package.json` in this directory only connects
native builds and test tooling to the monorepo; no TypeScript CLI remains.

Existing credential/vault and retry formats remain supported. When resuming a
write, preserve its exact arguments and saved files.

## Fresh-install verification

```bash
python3 apps/cli/scripts/verify-install.py
```

This copies only Rust source and lockfiles into a disposable tree, builds it,
packages and verifies a checksum, extracts the executable, and checks offline
help/errors and private vault creation/verification with an empty `PATH`. It needs
registry access or a populated Cargo cache. It proves an isolated installation
without Bun/Node at runtime, not byte-identical builds or universal Linux support.
