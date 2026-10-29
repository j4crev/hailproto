# Build and install the TypeScript hailp CLI

Build from a reviewed monorepo revision and its pinned `vendor/did-method-plc`
submodule. Dependencies resolve through committed lockfiles. No provider credentials,
database, vault or live account are needed for installation or offline smoke checks.

## Toolchain and checkout

The clean-install verifier requires Bun 1.4.0, Node 26.7.0 and pnpm 11.11.0, plus
Git and tar on Linux x64. Node/pnpm build the PLC dependency. The compiled CLI bundles
the Bun runtime; end users do not need those build tools or sibling repositories.

```bash
git clone --recurse-submodules https://github.com/j4crev/hailproto.git
cd hailproto
# Select a reviewed release and retain its SHA with the installed binary.
git submodule update --init --recursive
pnpm --dir vendor/did-method-plc install --frozen-lockfile
pnpm --dir vendor/did-method-plc --filter @did-plc/lib build
bun install --frozen-lockfile
bun run --cwd packages/hail-codec-ts build
bun run --cwd apps/cli build
bun run --cwd apps/cli smoke
bun run --cwd apps/cli smoke -- dist/hailp
install -Dm755 apps/cli/dist/hailp "$HOME/.local/bin/hailp"
hailp --version
hailp account show --help
```

Put `$HOME/.local/bin` on PATH. The TypeScript build currently targets
`bun-linux-x64-baseline` and embeds the package version. HTTPS verification remains
enabled; keep normal trust configuration and private credentials/vaults separate.
The package remains private; building a binary is not registry publication.

For development, use `bun run --cwd apps/cli hailp -- ...`. Integration tests import
provider code from the same workspace; no separate provider checkout is required.

## Fresh-environment verification

From the repository root:

```bash
bun run --cwd apps/cli verify:install
```

The verifier copies candidate workspace source without `node_modules`/build output,
archives the checked-out PLC dependency, performs frozen installs and builds, and
checks help/version/errors plus offline vault creation/verification through source
and binary. It removes its temporary tree afterward. Registry access or a populated
cache is required. This is a clean-filesystem check, not a byte-identical build or
cross-platform distribution guarantee.
