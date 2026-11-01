# Independent provider and web-client deployments

## Objective and boundaries

Keep the monorepo, but deliver a provider that can be built and operated without
the reference web client. Other web clients and native apps use the documented
HTTP API; they must not require reference-client source or Haili infrastructure.
The reference web client is optional and its name, logo and favicon are replaceable.

This work does not deploy production, change registration policy, move databases,
or promise cross-origin browser authentication or independently versioned APIs.
Initially publish both images from the same verified revision. Same-origin browser
hosting preserves the existing cookie, Origin and passkey security boundaries.

## Stage 1 — Application boundaries and naming

- [x] Move client-consumed API types out of server implementation into shared contracts.
- [x] Use package exports instead of client imports into server/shared source trees.
- [x] Rename `THIN_GUI_ORIGIN` to `WEB_CLIENT_ORIGIN` and `thinGuiOrigin` to
  `webClientOrigin` across runtime, fixtures, deployment and documentation.
- [x] Require explicit client provider configuration; remove Haili URL fallbacks.
- [x] Supply runtime branding configuration for name, logo and favicon, defaulting
  to neutral Hail branding. Keep protocol terminology distinct from product branding.
- [x] Verify configuration, proxy boundaries, branding and both application typechecks.

Client settings also move from `HAIL_GUI_*` to `HAIL_WEB_CLIENT_*`.
The environment rename is a deliberate pre-launch breaking change: update private
environment/Compose configuration and recreate the provider. No legacy alias is
planned. Rolling back requires restoring the matching old configuration.

## Stage 2 — Independent artifacts

- [x] Build provider and web-client images with separate Dockerfiles and contexts.
- [x] Ensure the provider build never invokes Vite or copies client source/builds.
- [x] Include supported provider administration CLIs in the provider image.
- [x] Implement publication and recording of two immutable image digests for the
  verified commit (hosted publication remains pending).
- [x] Add CI verification for both images, including absence of client artifacts
  in provider; equivalent local image builds/checks passed.

## Stage 3 — Generic deployment

- [x] Provide a server-only deployment with a supported PostgreSQL baseline.
- [x] Add an optional web-client overlay with independent image selection.
- [x] Provide direct HTTPS ingress and document the trusted client-IP boundary.
- [x] Keep Cloudflare/Haili deployment configuration separate from generic setup.
- [x] Document CLI/native-client access, first-account bootstrap and optional browser
  signup dependencies. A healthy container alone is not a usable account setup.

## Stage 4 — Haili transition and operations

- [x] Separate site-specific scripts/configuration from reusable deployment assets.
  Generic assets live in `deploy/standalone`; `deploy/public` is explicitly the
  Haili site profile and retains its path to preserve installed operational identity.
- [x] Update the release wrapper and regression tests to select, retain and restore
  two images, including recovery from the existing combined-image installation.
- [x] Preserve image-selection/database overlays, volumes, backup material and
  rollback records. Application rollback never rolls back the database.
- [x] Update release and operations instructions. Root-owned installed wrappers need
  separate reviewed installation through existing privileged access before rollout.
- [ ] Publish through GitHub Actions; never build on the live provider.
  Workflow changes are implemented; no publication or hosted rollout has run.

## Stage 5 — Acceptance evidence

- [x] Run focused tests, typechecks and independent builds.
- [x] Validate rendered server-only and optional-client Compose configurations.
- [x] Run the full database integration release gate against disposable PostgreSQL.
- [ ] Exercise a fresh isolated provider with an unrelated domain: migrations,
  readiness, CLI onboarding and an authenticated API exchange without a web client.
- [ ] Add the reference client; verify configured branding, signup, passkey login
  and messaging under the same public origin.
- [ ] Rehearse two-image upgrade/failure recovery before an authorized Haili rollout.

Record completed checks and unavailable external validation below. Do not equate
local checks with fresh-domain or production acceptance.

## Evidence and remaining work

Local evidence (2026-11-01):

- Workspace typechecks passed, including provider, client, monitor and shared packages.
- Client unit suite: 155 tests passed. Server unit suite: 328 tests passed;
  171 database/live opt-in tests skipped by the ordinary suite. Additional
  split-image wrapper cases were then added and verified separately (20 wrapper tests passed).
- Provider and client images built separately on the development machine. Provider
  runtime dependency checks found no resolvable Vite, Svelte or SvelteKit, and the
  provider image has no `apps/client` tree. Supported operator CLIs are included.
- `scripts/check-independent-deployment.py` passed with disposable PostgreSQL 18:
  server-only fresh migrations/readiness/404 page behavior, then optional-client
  readiness, custom brand text and mounted logo/favicon over the provider proxy.
  Both Compose profiles rendered correctly. All fixture containers/volumes removed.
- Direct-ingress Caddy configuration validated in its pinned container image.
- Chromium wizard test passed with local API fixtures and virtual WebAuthn, using
  a custom brand: signup, sign-in/return paths, messaging, permissions and security.
- CI now repeats separate image builds and the disposable deployment check.
- Full database integration gate passed (2026-11-01): rebuilt the codec and native
  CLI (`cargo build --locked`), then ran `bun run test:integration` against a
  dedicated disposable PostgreSQL 18.6 container. All 56 server/monitor suites
  passed, with no failed, skipped or todo tests. The runner created fresh source
  and target databases per suite; the container and its storage were removed
  afterward. No product-code changes were needed.

Remaining external acceptance: a real unrelated-domain HTTPS installation,
strict-public CLI signup/monitor ceremony and authenticated exchange; successful
hosted publication; reviewed wrapper
installation and live two-image rollout/recovery. No production service, account,
registration policy, wrapper or volume was changed. Local wizard fixtures are not
proof of public signup readiness.

The rollout wrapper's mocked regression suite verifies both candidate digests,
revision checks, separate image retention, first combined-image transition,
failed startup/readiness restoration, and refusal of a missing retained client.
A real hosted rollback rehearsal remains outstanding.

Existing unrelated edits to `docs/production-readiness.md` are outside this work.
