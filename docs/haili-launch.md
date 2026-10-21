# `haili.app` launch milestone

Status: in progress. The strict-public provider and permanent owner-controlled
canary were deployed October 21, 2026. This checklist does not enable public
managed transfer or turn the disposable `hailproto.app` and `hailproto.dev`
alpha providers into production services.

## Launch checklist

- [x] Run monorepo CI on pull requests and `main`, covering typecheck, tests,
  builds and both production images.
- [x] Add a single-provider public deployment profile. It uses canonical public
  PLC reads and keeps onboarding, custody transitions and managed transfer off
  until their separate gates pass.
- [x] Deploy owner-controlled public onboarding with canonical
  `https://plc.directory` reads, `strict-public-v1`, independent monitoring and
  `PUBLIC_MANAGED_TRANSFER=false`.
- [ ] Close the operational gates: production provider-key protection and
  least-privilege access; off-host backups and cross-host restoration; external
  monitor dead-man supervision and outage recovery; documented rate, size and
  load limits with alerts; and named incident/abuse ownership.
- [x] Onboard a permanent owner-controlled canary and prove Sender Profile,
  reciprocal Grants, bidirectional delivery and provider restart against both
  existing public-alpha providers.
- [ ] Complete the tabled off-host backup and restoration drills for the
  provider and permanent canary.

## Base deployment record

- Hetzner host `5.161.254.78` / `2a01:4ff:f0:a15f::1`, with direct Cloudflare
  DNS-only `A` and `AAAA` records.
- Application source `346cc66349cb7601b7113574dbb929a65e624539`, pinned PLC
  submodule `996e23b5ced9c15b32bcc612dd304880342ca4ab`, provider schema
  migration 51.
- Ubuntu 26.04, Docker Compose, host firewall limited to SSH and HTTP/HTTPS,
  key-only SSH authentication, and automatic security updates.
- PostgreSQL, provider and Caddy containers are healthy and recovered after a
  controlled host reboot. `https://haili.app/health/ready` passed over IPv4 and
  IPv6 with a valid Let's Encrypt certificate.
- Runtime is `strict-public-v1` against canonical `https://plc.directory`.
  Owner-controlled public onboarding is enabled; custody transitions,
  private-POC features and public managed transfer remain explicitly disabled.

## Permanent canary record

- `canary@haili.app` is owner-controlled as
  `did:plc:uqoxoluvchbmcxcdvihmzzj5`, with independently monitored genesis CID
  `bafyreifedv3s5firylavyq5kb3gokpmqnlnsdmbbymrc4zsrxx25thcfym`.
- Its explicit Sender Profile revision 1 and reciprocal `updates` Grants are
  live with `canary@hailproto.app` and `canary@hailproto.dev`.
- Four test messages, one in each direction with each alpha provider, reached
  terminal `delivered` state. The account, profile, diagnostic PLC read and
  IPv4/IPv6 readiness remained healthy after a controlled provider restart.

Provider-key backup, cross-host restoration, dead-man supervision, calibrated
load controls and named incident ownership remain tabled for this alpha.

The reviewed public managed canary ceremony completed October 21, 2026. The
`canary@hailproto.app` DID moved to `canary-app@haili.app` and returned to its
original address/provider, advancing from serving generation 2 to 4 under two
fresh transfer IDs and independently reviewed monitor attestations. Its four PLC
operations are canonical with no nullified entries, and its Grant history survived
both moves. Public managed transfer was disabled again on both providers after
the proof; general enablement remains a later milestone behind the tabled
operational gates.

## `spt-2` rollout record

Migration 52 and the additive `spt-2` rich-text profile were deployed to
`haili.app`, `hailproto.app`, and `hailproto.dev` on October 21, 2026. The
release archive SHA-256 is
`ff6031cdb912da44d238c696a9ffe43da86cde8c7fd4879f747e8c7937d0fd15`.
Verified pre-rollout logical backups are retained at
`/var/backups/hail-public/pre-spt2-20261021T151547Z` and
`/var/backups/hail-poc/pre-spt2-20261021T151547Z` on their respective hosts;
compatible pre-`spt-2` provider images remain tagged for rollback.

Fresh rich messages `01a15f0c-3aee-737b-8ba5-920777f6011d` from
`canary@hailproto.app` and `01a15f0c-404b-7dfd-91ab-f12bbe2398cd` from
`canary@hailproto.dev` reached terminal `delivered` state at
`canary@haili.app`. Account reads returned `spt-2`, and the disposable GUI
rendered the heading, grouped list, blockquote, decorators, and HTTPS link.

## `spt-3` rollout record

Migration 53 and commit `4523b88f7fd65ce66c6855bbdbb6045a248f38dc`
were deployed to all three providers on October 21, 2026. The release archive
SHA-256 is
`af39cb6d8a8201ddcf9d86cd0dbe0ed33af9afaab20ce207c306c7f4640dc166`.
Verified pre-rollout backups are retained at
`/var/backups/hail-public/pre-spt3-20261021T160350Z` and
`/var/backups/hail-poc/pre-spt3-20261021T160350Z`; compatible pre-`spt-3`
images remain tagged for rollback.

Fresh messages `01a15f36-a189-7b61-86a4-d770a4067617` from
`canary@hailproto.app` and `01a15f36-a698-78ef-a3c6-e71195612ca2` from
`canary@hailproto.dev` delivered an 8,879-byte 1200 by 400 PNG with SHA-256
`42fa1887bf6b4ab2c7fef10c18d3c0cc2a50808454702ed8c9179bc87146faaf`.
Recipient account reads matched the exact bundled bytes, and the disposable GUI
rendered both headers with their alt text and captions without a remote image
request. The GUI subsequently exposed those headers in its inbox feed with a
browser-local show/hide preference.

## Sender Profile v2 avatar rollout record

Commit `25f6e3c118cc960aaeafd7c04cdd7482ed207190` was deployed to all
three providers on October 21, 2026 without a schema migration. The release
archive SHA-256 is
`7c91294cd4618ecc45762449f13f1d01717758459fea2758d3f891c0cbdd387d`.
Verified pre-rollout backups are retained at
`/var/backups/hail-public/pre-profile-v2-20261021T165526Z` and
`/var/backups/hail-poc/pre-profile-v2-20261021T165526Z`; compatible prior
images remain tagged for rollback.

`canary@hailproto.app` published profile revision 4 with a 1,777-byte 256×256
avatar (`8943d595e7b835d12461a61ff3cff782662a7408fedea950d4df9b508064486d`),
and `canary@hailproto.dev` published revision 2 with a 2,113-byte 256×256
avatar (`244fa6bf84b6215b45027a1340b63b6e64881cda735ca474b87b0471567b5133`).
`haili.app` independently retrieved and verified both signed v2 profiles while
retaining their v1 evidence. The disposable GUI rendered the exact bundled
avatars in inbox and detail views with initials fallback and no remote image
request.

## Thin-client composer proof

The disposable GUI gained a server-side composer for active categorized Grants,
plain and structured heading/body text, optional bundled PNG headers, local
preview, and refreshable delivery status. Live form submissions from
`canary@haili.app` reached terminal `delivered`: plain message
`01a15f6f-d097-7381-b831-83d80f2d4c36` at `hailproto.dev`, and bundled-header
`spt-3` message `01a15f6f-9e2e-7260-ba02-83c723aff995` at `hailproto.app`.
Recipient reads matched the authored text and exact bundled image bytes.
Selection-based bold, italic, code, and HTTPS-link controls were then exercised
in live `spt-2` message `01a15f77-1d85-7417-96db-90e9f36612ff`; the recipient
read retained the expected native marks and link definition and reached
terminal `delivered`.

Commit `0730b26396679d5d8e507f07aecdb42195b5c1eb` added authenticated, account-scoped Sent list/detail APIs and
a disposable GUI Sent view with accessible status text, green accepted checks,
closed envelopes for delivered messages, and explicit refresh. No schema
migration was required. The API was deployed to `haili.app` from release archive
SHA-256 `48162ec8e48bcd73ce97ee135ff8b1d48773e9e7716b9fb469cff02f10b2a8d1`.
The live account returned all eight retained outbound messages; list and detail
views rendered the newest exact `spt-2` body at authenticated `delivered`
revision 2. The provider remained healthy with zero unexpected restarts.

Commit `3bf002b741fa5f215bfb26ac090fb15e5b194437` replaced per-row message reads with five-message body pages for
Inbox and Sent, added forward/back pagination, projected address labels directly
from account-owned retained Grant consent evidence, and exposed authenticated
delivery reasons and retry timing. Only receipt-indeterminate messages offer an
idempotent resubmission; terminal failures require a new message. Hail's privacy
rule against reverse DID-to-address lookup remains intact, so a DID is still the
fallback when the account has no retained address evidence.

The change required no schema migration and was deployed to `haili.app` from
release archive SHA-256
`7ae471cc7e4b76cc29f3f109ce53c659d63018b365811fedaf66bba9453ac1c0`.
The live account rendered Sent as five plus three records, paginated Inbox, both
verified peer addresses, exact bodies, and terminal delivery guidance. The
provider remained healthy with zero unexpected restarts.

## Managed thin-client canary

`canary-prov@haili.app` was publicly onboarded October 21, 2026 as managed
custody v1, DID `did:plc:stvgwkko467nuc2hautufvpg`, with independently reviewed
genesis CID `bafyreieu5jvsstxhx3nawryfe5bnlzrphw7ryenqg6hbnlsdqusp4xugvu`.
The owner retains the top recovery key; Haili controls distinct PLC rotation,
Hail identity, and Hail messaging keys. The local vault identity is absent from
the DID document.

The thin client accepted this account after removing its obsolete hard-coded
`canary@haili.app` address check while retaining the fixed Haili provider-origin
assertion. Reciprocal `updates` Grants with `canary@hailproto.app` supported
provider-signed rich sends and inbound delivery. Three GUI submissions and one
inbound message reached authenticated `delivered` revision 2; Inbox, Sent, both
detail views, retained address labels, and status guidance rendered correctly.

Two exploratory same-provider Grants were revoked after publication returned
HTTP 409. The current Grant store permits one local role per lineage, so
same-provider peer Grants remain a known limitation; federated Grants are the
tested path.

## Documentation disposition

Completed October 21, 2026. Active guidance now points to the strict-public
deployment and current gate documents; dated POC and milestone records are
explicitly archived in place so existing evidence links remain valid.

| Document | Disposition |
| --- | --- |
| `apps/cli/docs/cli-roadmap.md` | Keep as the concise capability and gate summary. |
| `apps/cli/docs/custody-transitions.md` | Keep as the detailed production-gate authority; archive completed checklist sections when distilled. |
| Completed reader-refactor plans | Deleted after consolidation into `spec/plc-read-evidence.md`, `spec/did-profile.md` and operator guidance. |
| `apps/cli/docs/milestone7-production-gate.md` | Archived evidence record; no longer linked as the active gate list. |
| `docs/typescript-backend-poc.md` | Archived private-PLC implementation and deployment record. |
| `docs/production-portable-custody.md` | Preserved as design history and private-POC recovery guidance. |
| `CBOR_MIGRATION.md` | Keep for remaining limits, measurements, API documentation and media-type work; it does not block this launch. |
| `BUILD_ORDER.md` | Keep as architectural background, not an execution checklist. |
| `docs/poc-cleanup.md` | Keep until private rehearsals and legacy-account disposition permit the remaining compatibility cleanup. |

Do not delete private-PLC fixtures, applied migrations or compatibility readers
while they remain required for recovery and regression evidence.
