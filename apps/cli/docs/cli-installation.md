# Reproducible hailp installation (0.1.0)

The supported baseline builds from a reviewed client source revision plus pinned
sibling libraries. Registry dependencies resolve through committed lockfiles;
installs use frozen mode. No provider credentials, database, vault or live account
is needed to install or run the offline smoke test.

## Toolchain and source pins

Verified build toolchain: **Bun 1.4.0**, **Node 26.7.0**, **pnpm 11.11.0**, Git and
tar on Linux x64. Node/pnpm build the PLC dependency; the finished compiled CLI
does not require Node, pnpm, Bun or sibling repositories at runtime.

| Checkout | Exact revision |
| --- | --- |
| `hailproto` | `fb9697b4074086fb86f6dc61f26805ec0450d315` |
| `did-method-plc` | `996e23b5ced9c15b32bcc612dd304880342ca4ab` |
| `hail-user-client-ts` | Select the reviewed milestone-6 client commit; retain its SHA with the binary |

Keep these checkouts beside each other. The client has local `file:` dependencies,
so `bun link` alone is not a reproducible distribution. All three repositories
are needed at build time. The client is still a private reference package; no
registry publication is implied by version `0.1.0`.

## Build and install

From the client checkout, after selecting the pinned sibling revisions:

```bash
bun install --cwd ../hailproto --frozen-lockfile
bun run --cwd ../hailproto/packages/hail-codec-ts build
pnpm --dir ../did-method-plc install --frozen-lockfile
pnpm --dir ../did-method-plc --filter @did-plc/lib build
bun install --frozen-lockfile
bun run build
bun run smoke
bun run smoke -- dist/hailp
install -Dm755 dist/hailp "$HOME/.local/bin/hailp"
hailp --version
hailp account show --help
```

Put `$HOME/.local/bin` on PATH. `--version` prints `0.1.0`. The executable bundles
the CLI, dependencies and Bun runtime for the build host's platform. HTTPS
verification remains enabled; normal platform trust configuration still matters.
Keep credentials and vaults in private storage independently of the executable.

`build` typechecks the CLI/scripts and compiles the binary. The full development
`typecheck`/`test` gates also cover legacy tests importing sibling provider source;
those require a `hail-server-ts` development checkout, not for installation.
`bun run hailp -- ...` and `bun link` remain useful for development. To build the
binary again, rerun `build`; it embeds the package version at build time.
Cross-platform builds/releases are not yet verified by this Linux proof.

## Fresh-environment gate

```bash
bun run verify:install
```

The gate copies candidate client source (tracked and nonignored new files) into
a disposable empty sibling layout and uses Git archives of the exact library
pins. It carries over no `node_modules` or `dist`, performs frozen installs,
builds/typechecks, then tests help/version/strict errors and offline private vault
creation/verification through both the Bun source CLI and the compiled executable.
It deletes its own temporary tree on
completion. Registry access is required to populate dependencies; a local cache
may supply them. This proves a clean filesystem install, not an empty registry
cache or byte-identical binaries across different operating systems/toolchains.
