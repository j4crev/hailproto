# Build and install hailp

The default executable is native Rust. Linux x86-64 is the supported release
platform; users need system CA roots and the normal Linux C runtime, but no Bun,
Node, pnpm or Rust installation to run a release binary.

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
