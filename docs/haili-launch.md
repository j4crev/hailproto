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
