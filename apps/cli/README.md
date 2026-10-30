# Native Rust hailp

`hailp` is the native Hail Protocol CLI. All 65 commands from the TypeScript CLI
are implemented in Rust, including vaults, account access, credentials, messaging,
Grants, profiles, connections, custody transitions and provider transfers. It does
not invoke Bun or Node at runtime. See [CLI workflows](docs/cli-workflows.md)
for usage and the [installation guide](docs/cli-installation.md) for setup.

## Build and install

Linux x86-64 is the supported release platform. Install Rust through rustup; the
repository pins the toolchain and dependencies. A C linker and system CA roots
are required. Build without installing the JavaScript workspace:

```sh
cd apps/cli
cargo build --release --locked
./target/release/hailp --help
install -Dm755 target/release/hailp "$HOME/.local/bin/hailp"
```

From the repository root, `python3 apps/cli/scripts/build.py` builds the same
binary at `apps/cli/dist/hailp`, the existing release artifact path.
`bun run build:cli` is an equivalent development convenience. Release builds use
LTO, one codegen unit and stripped symbols.

## Compatibility

Version-1 credentials and encrypted vaults, browser recovery packages, signed
objects and private retry files retain their existing formats. Interrupted writes
must reuse the same arguments and artifacts. The TypeScript CLI has been retired;
its read/output contracts are retained as fixed regression fixtures. Browser vault
interoperability is checked against independent shared cryptographic helpers.

Results use JSON stdout with `cliContractVersion: 1`; errors use JSON stderr and
exit status 1. Tokens are redacted. Help/error prose may differ. Private files must
be regular files without group/other permissions. Non-Unix credential access fails
closed. Credential expiry metadata requires RFC 3339, the provider's emitted
format. Browser login launches the system browser with `xdg-open` on Linux.

HTTPS uses Rustls and native CA roots (`SSL_CERT_FILE`/`SSL_CERT_DIR` can supply
custom trust). Redirects are refused. Requests and responses have bounded time
and size limits, with larger explicit limits for transfer snapshots. No source
credential is forwarded to a transfer destination.

## Signing and signed reads

The native codec handles deterministic CBOR, COSE, Ed25519, P-256 recovery signing,
AES-GCM vaults and PLC DAG-CBOR/CIDs. It validates schemas, canonical encodings,
Unicode/address rules, digests and bundled PNG assets. Signing workflows verify
keys, proposals and retained artifacts before submission.

As in TypeScript, read-only signed-object inspection does **not** resolve DID keys
to authenticate signatures. Do not treat `grant show`, `profile show` or binding
inspection as standalone proof of authenticity. `grant show --output` retains
exact received bytes after structural validation and refuses to overwrite files.

## Verification

```sh
cd apps/cli
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --release --locked
bun tests/compatibility.ts target/release/hailp
bun tests/vault-compatibility.ts target/release/hailp
bun tests/transfer-e2e.ts target/release/hailp
python3 tests/terminal-input.py target/release/hailp
python3 scripts/verify-install.py
```

Regression tests require Bun, OpenSSL and built workspace codec dependencies.
They run the native executable against disposable HTTPS provider fixtures,
including two-provider transfer ceremonies. They cover malformed responses,
redaction, TLS rejection, scoped access, browser PKCE, exact signatures, interrupted
requests, retained retries, monitoring/handover and retirement. They do not access
live accounts. Rust tests also consume shared conformance vectors. The terminal
test checks hidden input and terminal restoration.

The install verifier builds an isolated copy of Rust source, packages it, checks
its checksum, extracts it, and exercises help/errors and vault creation/verification
with an empty `PATH`. Registry access or a populated Cargo cache is required.
This proves filesystem isolation and no Bun/Node runtime dependency, not reproducible
builds or portability to every Linux distribution.
