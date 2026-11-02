# Install racr

The default executable is native Rust. The release qualification targets Linux
x86-64 on Ubuntu 22.04 (glibc 2.35) and Ubuntu 24.04 (glibc 2.39). Users need
system CA roots and the distribution's normal C runtime, but no Bun,
Node, pnpm or Rust installation to run a release binary.

## Download a release

Check [GitHub Releases](https://github.com/j4crev/hail/releases) for a
published version with `racr` assets. Older releases use `hailp` asset names;
follow their release-specific instructions. Until a release with the new name
is published, use the source-build instructions below.

On Linux x86-64, choose the version explicitly from the release page. Run this in
Bash, replacing `X.Y.Z` with that version (without the `v` prefix):

```bash
(
  set -euo pipefail
  version='X.Y.Z'
  test "$(uname -s)" = Linux && test "$(uname -m)" = x86_64
  archive="racr-${version}-linux-x64.tar.gz"
  base="https://github.com/j4crev/hail/releases/download/v${version}"
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  cd "$work"
  curl --fail --location --proto '=https' --proto-redir '=https' \
    --output "$archive" "$base/$archive"
  curl --fail --location --proto '=https' --proto-redir '=https' \
    --output "$archive.sha256" "$base/$archive.sha256"
  curl --fail --location --proto '=https' --proto-redir '=https' \
    --output "$archive.sigstore.json" "$base/$archive.sigstore.json"
  sha256sum --check "$archive.sha256"
  gh attestation verify "$archive" --bundle "$archive.sigstore.json" \
    --repo j4crev/hail \
    --signer-workflow j4crev/hail/.github/workflows/release-linux.yml \
    --source-ref "refs/tags/v${version}" --deny-self-hosted-runners
  tar -xzf "$archive" racr
  test "$(./racr --version)" = "$version"
  install -Dm755 racr "$HOME/.local/bin/racr"
)
export PATH="$HOME/.local/bin:$PATH"
racr --version
```

Add `export PATH="$HOME/.local/bin:$PATH"` to your shell startup file if needed.
Downloads require curl, tar, sha256sum and a GitHub CLI (`gh`) supporting the
attestation flags above. Install GitHub CLI through its official distribution
instructions and authenticate if it requests GitHub API access. Checksums detect
corruption; the signed Sigstore bundle binds the archive digest to this repository,
release workflow, tag and GitHub-hosted runner. Verification happens before
extraction or execution. Stop if verification fails; do not skip it or disable TLS.

This trusts GitHub Actions/OIDC, Sigstore's verification roots, the protected
repository and its release maintainers. It does not prove the code is safe or
the build reproducible, nor protect against compromise of the trusted workflow.
For a separately reviewed commit, also pass `--source-digest FULL_COMMIT_SHA`.
See [GitHub's verification command](https://cli.github.com/manual/gh_attestation_verify).

The build environment is Ubuntu 22.04, rather than a moving `ubuntu-latest`
runner. Every release archive must pass clean Ubuntu 22.04 and 24.04 runtime
checks. Other distributions, older glibc, musl/Alpine, ARM64, macOS and Windows
are not qualified. Containers exercise distribution userspace on the host kernel;
they do not establish a minimum kernel or real desktop/passkey compatibility.
A `GLIBC_* not found` error requires a compatible release or local source build;
installing Bun will not fix it. First hosted qualification and downloaded-release
acceptance remain tracked in the production-readiness checklist.

## Upgrade or uninstall

### Moving from hailp to racr

Update scripts and command invocations from `hailp` to `racr`, and replace
`HAILP_CREDENTIAL_FILE` with `RACR_CREDENTIAL_FILE` in shell configuration and
service environments. The old environment variable is no longer read;
`--credentials` remains supported.

This is a breaking alpha update: deploy matching provider, browser client, and
CLI revisions together. Provider migration 99 discards pending browser logins
and changes the accepted client ID to `racr-cli-v1`. API tokens now use `racr_`;
file/response types and client signing domains now use `racr.*`. Old identifiers
are rejected, with no compatibility aliases. CLI output reports contract version 2.

Reissue API credentials through browser login, owner-key login, or the provider
operator credential tool; revoke obsolete credentials. Restart pending signup,
login/recovery, custody-transition and transfer ceremonies with fresh state files.
Do not change a token's prefix or edit signed state files: token hashes and
signatures bind the original bytes. Reconcile any fenced or partially completed
provider operation before starting another; a CLI file deletion is not a server
rollback. Retained test history with old signed client approvals is not converted
by this change and cannot be assumed valid under the new domains.

Keep existing `hail.user-vault` files, keys and recovery secrets: their format and
encryption are unchanged. Hail federation identifiers such as `hail.envelope`
and `#hail-identity` are unchanged as well.

Installing `racr` does not overwrite an installed `hailp`. Remove the old binary
once the matching stack works. Rollback requires the matching old provider and
client versions plus a pre-upgrade database backup; reverting only the executable
or database client-ID constraint is insufficient. This repository change does
not alter any installed binaries or live account data.

### Routine upgrades and removal

Read the selected release notes before upgrading. Record `racr --version`, keep
the previous executable if rollback is needed, and repeat the versioned download
procedure. Existing credentials, vaults and retry state stay at the paths you chose;
keep them until their operations are confirmed complete. Binary rollback does not
reverse provider changes or guarantee older software can read newer state formats.

To remove the executable installed above:

```bash
rm -- "$HOME/.local/bin/racr"
```

This does not revoke credentials or delete recovery material. Revoke unwanted
access through your provider before disposing of private credential files; retain
recovery backups for identities you still own.

## Build from source

Build a reviewed revision with rustup, a C linker and Python 3 installed. Rust
1.97.1 and Cargo dependencies are pinned in `apps/cli`. No provider credentials,
database, vault or live account is needed.

```bash
git clone https://github.com/j4crev/hail.git
cd hail
python3 apps/cli/scripts/build.py
install -Dm755 apps/cli/dist/racr "$HOME/.local/bin/racr"
racr --version
racr account show --help
```

Alternatively, run `cargo build --release --locked` inside `apps/cli` and install
`target/release/racr` directly. Put `$HOME/.local/bin` on PATH. HTTPS certificate
verification remains enabled; keep private credentials and vaults separate.

Tagged releases retain `racr-<version>-linux-x64.tar.gz`, its SHA-256 checksum,
and its `.sigstore.json` provenance bundle. Verify both checksum and provenance
before extracting and installing. Local source builds use the local C runtime
and do not inherit the release compatibility promise. The package remains private;
a local build is not registry publication.

## Development

Workspace development and test fixtures use Bun 1.4.0, Node 26.7.0 and pnpm
11.11.0 with the pinned PLC submodule. Install those dependencies, then
`bun run build:cli` builds the native executable and `bun run test:cli` runs its
unit and workflow regressions. The `package.json` in this directory only connects
native builds and test tooling to the monorepo; no TypeScript CLI remains.

Only current `racr.*` credential and retry formats are supported. When resuming
a write created by this revision, preserve its exact arguments and saved files.
Encrypted `hail.user-vault` files remain supported without conversion.

## Fresh-install verification

```bash
python3 apps/cli/scripts/verify-install.py
```

This copies only Rust source and lockfiles into a disposable tree, builds it,
packages and verifies a checksum, extracts the executable, and checks offline
help/errors and private vault creation/verification with an empty `PATH`. It needs
registry access or a populated Cargo cache. It proves an isolated installation
without Bun/Node at runtime, not byte-identical builds or universal Linux support.

Release qualification additionally runs `scripts/verify-artifact.py ARCHIVE VERSION`
inside clean supported distribution containers. It tests the exact archive's
checksum, version, help/errors, private vault creation/verification, rejection of
untrusted TLS, and authenticated HTTPS account/inbox reads using disposable local
fixtures. Python and OpenSSL are test tools, not CLI runtime requirements. This
does not replace downloading the published release and completing the browser
login quickstart with a dedicated test account.
