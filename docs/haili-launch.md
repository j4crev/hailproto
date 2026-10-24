# `haili.app` launch milestone

## Teal Browser Client Deployed — October 24, 2026 UTC

- Release `f54120f7bed5d426eccfd15be6495d10bf7f101c` was committed, pushed and
  deployed through `hail-provider-ops deploy`. The wrapper verified encrypted
  pre-deploy backup `provider/haili-20261024T143454Z.tar.gpg`, SHA-256
  `58b0fda9f128e8f7bef9c3df6d17083342a109278947335c6879290d14ee19c9`;
  its initial upload failed with 501 and the existing retry succeeded.
- Provider and GUI were rebuilt/recreated and are healthy. Image config digest:
  `sha256:613f2d1c7f389a629a8c6143fb1973bfd2d41bb128faf0ac4353074ffc613ac8`.
  PostgreSQL remains 18.6 with unchanged uptime; Caddy and the monitor were not
  restarted. No database migration or enrollment-policy change was introduced.
- Public checks returned 200 for readiness, the focused homepage, login and the
  favicon. Allowed Senders, Security, Sent and Compose each returned the expected
  non-cacheable 303 to the shared login with a local return destination. The
  signed-out homepage contains no private folder navigation.
- Local proof before release: build, typecheck, 25 unit tests, desktop/mobile-width
  Chromium through the real GUI proxy, and browser crypto with network denied.
  Authenticated production passkey use still needs operator confirmation; no live
  account, Grant, invitation or message was created for deployment verification.

## Live Permission, Delivery And Reply Navigation Repair — October 23, 2026 UTC

- The operator approved `canary-prov@haili.app` from `j4@haili.app` through the
  new UI. Received `updates` Grant `01a16897-2df7-72c9-8aef-e3efbb458291`
  was checked from the canary without issuing another permission. One labeled
  test message `01a1689a-b499-72f9-a334-8edfe934f43c` reached authenticated
  `delivered` revision 2; the operator confirmed opening it. It offers one reply
  for seven days, not standing reciprocal authorization.
- The reply form exposed document-scoped CSP leaking through SPA navigation:
  signup's `form-action 'none'` remained active after entering the inbox, so the
  browser blocked native form submission before the API. Local Chromium reproduced
  the exact violation; the canary inbox showed no reply had arrived.
- Release `903af3ebb0325a8068b0dc6a66e3dbafb26d605f` forces full-document
  navigation when leaving signup/recovery pages, preserving their strict policy
  while giving normal pages their own policy. No Grant, reply capability, session,
  key or database lifetime was reset. GUI checks pass 23 tests and typecheck;
  desktop/mobile-viewport browser proof now follows signup to native reply/Sent
  through the real provider GUI proxy, without a manual reload concealing CSP.
- Guarded deployment and public readiness/login/permissions checks passed. The
  production signup page retains its no-form CSP and serves the full-load link
  boundary. After hard-refreshing the original message, the operator confirmed
  success. Reply `01a168ab-3373-787a-a7d8-9e722dd8b64d` arrived from j4 in the
  canary inbox at `2026-10-23T12:10:14.276Z`; its body was not collected for proof.
  The invited browser signup → inbox → passkey-approved sender permission →
  delivered message → one-time reply pilot is complete. Real phone-camera and
  broader platform/recovery/deliverability gates remain separate.

## Allowed Senders Deployed — October 23, 2026 UTC

- Release `377c62cd9aa57d96628b6c7849c7390eb9d0f4a8` deployed through the
  existing encrypted-backup/build/readiness wrapper; image
  `sha256:6023ee459640be16349748e400fd050fa24bd5d680c2aa28ccbd3226fd2d5269`.
  Provider, GUI and PostgreSQL remain healthy. PostgreSQL stays 14.24; no monitor,
  SSH, sudoers or service-secret changes were needed.
- `/permissions` now offers typed-address review, public identity-pinned sender
  QR links, category/expiry review, exact-action passkey approval, permission
  listing and revocation. Scanning only prefills review. Normal passkey sessions
  still have no general `grants:write` or credential-management scope.
- Expand-only migration 59 retains provider-local immutable Grant approval
  intents and terminal proof. Rollback is verified while empty and refused once
  approval records exist. Old-account/key/session preservation and older migration
  rollback ordering checks passed against disposable PostgreSQL schemas.
- Checks: 238 server tests passed (22 environment/live checks skipped), 23 GUI
  tests passed, server/GUI typechecks passed, and the packaged image built and
  served the anonymous permission landing page with no-store/no-referrer/CSP.
  Chromium exercised typed and QR-linked review, no automatic approval, virtual
  user-verified passkey approval and revocation. Backend integration covers foreign
  accounts/sessions, unchanged scopes, expiry, concurrent retries, changed consent,
  a Grant edit racing revocation, and lost committed revocation responses.
- External health, login, signed-out home and permission landing return 200.
  Permission writes without a session return 401; foreign-Origin and bearer-only
  attempts return 403. These probes issued no live Grant. The next live operation
  is the operator's explicit approval of `canary-prov@haili.app` from `j4@haili.app`.
  Actual phone-camera behavior and the message exchange remain pilot checks.
  See [browser permissions](browser-permissions.md) for authority/rollback limits.

## Invited Pilot And Inbox Repair — October 23, 2026 UTC

- The operator enabled the invited pilot, received the security enrollment email,
  and reported successful passkey creation and setup completion. The real message
  exchange and authenticated inbox confirmation remain outstanding.
- Release `606a7cb` corrected premature signup sign-in: a locally signed DID must
  not offer passkey authentication before provider-confirmed enrollment. Browser
  regression checks cover the prepared, monitoring and unenrolled states.
- First inbox access exposed an account-client contract gap: the server returned
  retained `reduced-assurance-alpha-v1`, but the shared client rejected it and the
  GUI loader failed. Release `f9d30bb9304f47822c58d5b21a8930bce51c9c97`
  accepts this label only for managed custody with the frozen managed profile;
  it does not relabel monitoring as independent or relax authority checks.
- GUI checks pass 20 tests and typecheck; all 21 CLI tests and typecheck pass.
  Desktop/mobile-viewport Chromium proof now follows the actual inbox link with
  a session cookie through the real account client and empty-inbox loader.
  Fixture mail/PLC/monitor data remain distinct from the operator's live account.
- Guarded deployment completed with an encrypted pre-deploy backup. Public
  readiness, login, signup and signed-out home return 200. No account keys,
  passkeys, sessions, setup lifetimes or database records were rewritten by the
  patch. Confirmation from the operator's authenticated inbox is still required.

## Browser Wizard Staged — October 23, 2026 UTC

- Provider/GUI release `93d5be6db4c57bcabc2af20a6cbfa5220f25189d` deployed
  through the existing guarded wrapper; image
  `sha256:0d6638bcc7bfc68552fc75e297119fe33ec6b1b7913ba2debfdc44eae207ccad`.
  The pre-deploy encrypted backup upload recovered on retry before the build.
- Full server checks passed 236 tests with disposable PostgreSQL 14.24, plus
  the new address-route test passed separately. GUI checks passed 18 tests,
  typecheck with zero warnings, build and a packaged GUI startup/headers check.
  Chromium checks cover offline recovery crypto and the built wizard at desktop
  and a 390px mobile viewport. Virtual passkeys were cryptographically verified;
  mail, monitor and activation were local fixtures in the UI check. Separate
  backend integration exercises those real services against local PLC/mail data.
- External readiness and passkey login return 200. `/signup`,
  `/signup/recovery`, `/api/v1/signup` and `/api/v1/signup/check-address`
  return 404 with the gate off. The already-enabled monitor orchestration route
  returns 401 without setup authority. The monitor is healthy and its HTTPS edge
  still returns 403 for non-provider traffic with a spoofed forwarding header.
- The console-only `enable-signup-pilot.py` is ready for one operator invitation:
  it backs up, validates and atomically sets only alpha declarations and displays
  an intended-recipient invitation URL. No new sudo/SSH privileges are installed.
  Console enablement and subsequent guarded recreation have **not** happened.
  No live invitation, account, DID, email binding or passkey was created during
  this rollout; the real operator-handled ceremony remains the next gate.
- Wider mobile/WebAuthn support, post-signup browser recovery (not approved),
  asynchronous bounce handling and a useful invited message exchange are not
  established by these local checks. Do not treat this staged release as public
  consumer signup approval.

## Monitor API Bridge Completed — October 23, 2026 UTC

- Operator-applied bridge and provider connection use code release
  `dc6458d3fc5d3dea916913ee130d020609f1769b`. The monitor now builds monorepo
  code at `/opt/hailproto` while preserving legacy configuration/key mounts,
  PostgreSQL 14.4 image and data volume. Old checkouts were retained for rollback.
- Console setup passed migration-checksum, signing-key, immutable-history and
  delivery-receipt preservation checks. The monitor public key remains
  `did:key:z6Mknh84ZKz6BNm2mh4LFGKc1JkW2WN9ZdfCVRbi58s1k4Zr`.
- Encrypted post-switch archive `monitor-20261023T002149Z-ba9721a1.tar.gpg`
  was downloaded to private off-host operations storage and verified against
  SHA-256 `eb62effee05d28aa5141b8b7a6d729853b91070ea26f10699b3c05ca90923434`.
  It remains outside temporary configuration staging with its checksum sidecar.
- Opening the previously blocked TCP 80/443 rules and restarting only the new
  edge allowed certificate issuance. Trusted HTTPS at `enroll.plcmonitor.us`
  now returns 401 for unsigned service access and 400 for an authenticated empty
  enrollment request. Non-provider access returns 403, including when a
  forwarding header falsely claims the provider IP. Backend 3001 binds loopback.
- Matching provider settings were installed through the console-approved narrow
  wrapper action, backed up before mutation and loaded through a guarded
  recreation. Provider/GUI readiness and login return 200. Monitor heartbeat is
  fresh, and existing monitor/database containers remain healthy.
- `/api/v1/signup-monitor` is mounted and returns 401 without setup authority,
  or 400 for malformed setup input. `/api/v1/signup` and `/signup/recovery`
  remain 404/gated off. No production account, DID, enrollment binding or passkey
  was created for a test. Full consumer signup still needs the browser wizard
  and an explicitly invited live ceremony.
- Temporary service-secret copies were removed from both `hailops` staging
  directories and the workstation after hash checks. Protected runtime settings,
  rollback state and encrypted backups were retained. SSH keys, root-login
  policy and wrapper-only passwordless sudo were unchanged.

## Monitor Enrollment Rollout Preparation — October 23, 2026 UTC

- Provider code staged through the existing backup/build/readiness wrapper at
  `dc6458d3fc5d3dea916913ee130d020609f1769b`; image
  `sha256:8b06df15a9d0455f898b4559f1c14e35d5a7fb51392615c577eeb9a07b892b23`.
  The wrapper's encrypted backup upload recovered on retry before deployment.
- Compatible receiver deployed as version `8566a060-ed8b-4a83-a5c6-45a904f1f9b4`.
  Unsigned consumer alert/binding requests return 401. Existing operator alerts
  and heartbeat handling remain available.
- External provider readiness and login return 200; `/api/v1/signup`,
  `/api/v1/signup-monitor` and `/signup/recovery` remain 404. No invitation,
  account, DID or new passkey was created as a production test.
- Monitor preflight confirmed `hailops@2.25.206.150` agent access, healthy legacy
  containers, active heartbeat supervision, matching five migration source
  checksums, and an unchanged reviewed monitor public key. The existing
  PostgreSQL 14.4 image, volume and key paths have not been migrated or changed.
- The one-time source bridge, DNS-only HTTPS edge and service configuration are
  still awaiting operator DNS/console actions. Private mode-0600 staging files
  are inside mode-0700 directories. No root SSH or unrestricted sudo was enabled.
  Actual monitor database snapshots, encrypted backups, runtime switch and
  external TLS/ACL verification remain required before rollout completion.

## Consumer Signup Email Plumbing — October 22, 2026

- Guarded provider release: `95f36b19a7f0706cad15ea9c789659be27394999`.
  Provider image: `sha256:20bbe6c33aba4ab91c2a9f8c2f9a307b01aa69000c22741096a430bcad29650c`.
- Alert Worker version: `92d42dfd-93b8-4bc6-9d9d-a4c077dee95e`, using
  Cloudflare Email Sending on `notify.haili.app`. Existing monitor, heartbeat
  and backup secrets were retained; the new service-authentication secret was
  installed without exposing it to the browser or repository.
- Before configuration changes, encrypted backup
  `haili-20261022T205019Z.tar.gpg` was uploaded and downloaded for verification:
  SHA-256 `8684ef8cfb13f2a026311a7c4605c32e0293588bcecdfeb5311133fced809455`.
  The guarded deployment took another backup before checkout. Each upload
  recovered from an initial R2 `501` through its existing retry path.
- Schema advanced from 56 to 57. The four accounts, two active passkeys, three
  active API credentials and account-key snapshot remained unchanged. Provider,
  GUI, monitor and backup health checks passed. Existing onboarding/transfer
  settings were preserved; the production recovery preview remains disabled.
- A real verification email from `welcome@notify.haili.app` was accepted and
  the operator confirmed inbox receipt. A live provider-proxy retry returned
  the same pending verification/expiry, without another email. Unauthenticated
  Worker requests were refused. This did not create an account, publish a DID
  or bind a security-email destination to an existing identity. Correct-code
  verification and per-user alert binding have local regression proof, not a
  completed live consumer signup ceremony.
- The existing SSH-agent key authenticated successfully once its socket was
  supplied. With operator approval, temporary unrestricted passwordless sudo
  was replaced by wrapper-only access. `visudo` validation, wrapper status and
  rejection of unrestricted noninteractive sudo passed. No SSH keys or `sshd`
  configuration were changed. Temporary local service-secret material was removed.

The full browser wizard, automatic monitor enrollment, terminal signup authority
cleanup and asynchronous email-delivery event handling remain separate work.

Status: operational gates completed. The strict-public provider and permanent
owner-controlled canary were deployed October 21, 2026. Public provider transfer
was enabled on Haili October 22; this does not turn the disposable
`hailproto.app` and `hailproto.dev` alpha providers into production services.

## Launch checklist

- [x] Run monorepo CI on pull requests and `main`, covering typecheck, tests,
  builds and both production images.
- [x] Add a single-provider public deployment profile. It uses canonical public
  PLC reads and keeps onboarding, custody transitions and managed transfer off
  until their separate gates pass.
- [x] Deploy owner-controlled public onboarding with canonical
  `https://plc.directory` reads, `strict-public-v1`, independent monitoring and
  `PUBLIC_MANAGED_TRANSFER=false`.
- [x] Close the operational gates: production provider-key protection and
  least-privilege access; off-host backups and cross-host restoration; external
  monitor dead-man supervision and outage recovery; documented rate, size and
  load limits with alerts; and named incident/abuse ownership.
- [x] Onboard a permanent owner-controlled canary and prove Sender Profile,
  reciprocal Grants, bidirectional delivery and provider restart against both
  existing public-alpha providers.
- [x] Complete the tabled off-host backup and restoration drills for the
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
  Owner-controlled public onboarding and public provider transfer are enabled;
  custody transitions and private-POC features remain explicitly disabled.

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
load controls and named incident ownership were completed later that day as
recorded below.

The reviewed public managed canary ceremony completed October 21, 2026. The
`canary@hailproto.app` DID moved to `canary-app@haili.app` and returned to its
original address/provider, advancing from serving generation 2 to 4 under two
fresh transfer IDs and independently reviewed monitor attestations. Its four PLC
operations are canonical with no nullified entries, and its Grant history survived
both moves. Public managed transfer was disabled again on both providers after
the proof; general enablement remains a later milestone behind the tabled
operational gates.

On October 22, commit `88bd34b69909da1c5adc23a825b5a9ab29043e6a`
removed the global two-provider startup assumption and added strict-public
owner-controlled completion alongside managed custody. Haili enabled
`PUBLIC_MANAGED_TRANSFER=true` with local operator `haili-provider` and the
independent `plcmonitor.us` key while keeping public onboarding enabled. Both
portable and managed transfer routes, monitor health, provider readiness and the
active managed canary credential passed after recreation; temporary rollback and
full sudo access were then removed.

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

Two exploratory same-provider Grants initially returned HTTP 409 because normal
Grant reception did not attach the existing migration-31 collocated receiver
reference. Commits `54412ec` and `ac9ee91` fixed that path without duplicating
the immutable Grant chain or adding a migration. A local receiver is now attached
only when the received bytes exactly match the authoritative revision.

Fresh reciprocal same-provider Grants
`01a15fdb-2bd0-7433-8afa-bd0355e0608c` and
`01a15fdb-2d9a-7b89-a84b-f85a4e64f0b3` were acknowledged with HTTP 201 and
appear under the correct role for both Haili accounts. GUI message
`01a15fdb-b699-7637-ad65-7450615855aa` delivered locally with a signed one-shot
reply invitation; managed-account GUI reply
`01a15fdb-fb6d-7b3e-8f4d-009252386928` reached authenticated `delivered`
revision 2. Retained evidence records authorization type `reply` and the original
capability as consumed by that exact reply. The consumed invitation disappeared
from its Inbox detail while the explicitly solicited continuation remained
available.

The final release archive SHA-256 is
`7b297c9fb923e6bdee397c022583fd74b03aeec22f94dc8c374263f7991e9075`.
The provider remained healthy with zero unexpected restarts.

## Security hardening deployment

Commit `9b41cab2257f5e16cca5714e58e4d0af2cf8734d` completed the October 22,
2026 source review and was deployed to `haili.app`, `hailproto.app` and
`hailproto.dev`. The release removed unauthenticated bootstrap enrollment,
made migration admission atomic, isolated ingress quotas by trusted client or
authenticated account, hardened signed-evidence and codec validation, and
updated affected dependencies. `bun audit` reported no remaining advisories.

The provider, PLC and monitor databases were upgraded in place from PostgreSQL
14.4 to 14.24. All three providers, both independent monitors and their database
health checks remained healthy after deployment. Caddy was restarted on each
provider and now overwrites `X-Hail-Trusted-Client-IP` before forwarding private
provider traffic.

The signed-alert Worker was deployed as version
`46fd47ce-6e63-40c3-a521-24cf235e2120`. It rejects alerts older than seven days
or more than five minutes in the future, atomically claims alert UUIDs in a
Durable Object and suppresses completed replays for 30 days.

## Production operations gate record

The five operational gates closed October 21, 2026. Direct root, password,
keyboard-interactive and X11 SSH access were disabled on the provider and
independent monitor hosts. Named, key-only `hailops` access was verified first,
then restricted to root-owned fixed-command operations wrappers. Both runtime
containers remain unprivileged, read-only and capability-free. VPS-console
access is the root recovery path.

The private `haili-production-backups` Cloudflare R2 bucket now receives nightly
provider backups using bucket-scoped credentials. The host encrypts to an
off-host OpenPGP recipient and has no recovery private key. Automated object
`provider/haili-20261021T200312Z.tar.gpg` round-tripped with SHA-256
`b4093df7f41007d698a0275266f694f2d03318995101f627053f1c4e7c62de60`
and restored schema 53, 3 accounts, 12 Grant lineages, 17 sent and 15 received
envelopes in disposable PostgreSQL 14. The preceding independent drill also
decrypted all 8 retained operational keys. Owner-controlled and managed-canary
recovery material was separately encrypted and round-tripped as
`accounts/haili-account-recovery-20261021T195007Z.tar.gpg`, SHA-256
`290773eb445347a250d4ab6226f330a4c27d6fa69ba57f96bce446ddf133a7d3`.

The existing signed-alert Cloudflare Worker now checks public readiness each
minute and supervises authenticated monitor and verified-backup heartbeats at
five-minute and 26-hour thresholds. All three states were observed `ok`; the
controlled provider recovery transition produced a received operator email, and
the monitor and provider remained healthy with zero restarts. Email Routing forwards
only `ops@haili.app` and `abuse@haili.app` to the verified operator mailbox;
catch-all delivery remains disabled.

A later guarded monitor outage exceeded the five-minute heartbeat threshold:
external state changed to `down` and fresh attestation was refused. An independent
eight-minute systemd timer restored the monitor; state returned to `ok`, polling
was current and fresh attestation succeeded. Temporary elevated access was removed.

The monitor database, signing key and minimal configuration were then encrypted
off-host and restored into PostgreSQL 14. Artifact SHA-256
`32821ca4c9e109878ef3fd3199ef3c9c074cb69bcaf9963675f7de12807b6acc`
restored 5 monitored DIDs, 5 bootstrap checkpoints, 8 alerts, 3 approvals and
3 observations. The restored key matched the pinned monitor key; canonical polling
and fresh attestation succeeded before the plaintext clone was removed.

On October 22, 2026, the root-owned monitor heartbeat timer was updated from
one minute to the committed three-minute interval. The unit was daemon-reloaded
and restarted; systemd showed it active with consecutive firings three minutes
apart, while both independent monitor containers remained healthy. The external
receiver's six-minute missing-heartbeat threshold therefore remains two missed
heartbeats and avoids unnecessary request volume.

Readiness load calibration reached 339.0 requests/s at 16 connections with no
HTTP or transport errors, p50 45.7 ms, p99 125.1 ms and maximum 281.6 ms on the
2-vCPU host. Production mutation limits remain 120 requests/minute per surface,
with the documented 16-KiB and 256-KiB transport bounds. Named response targets,
outage/key/abuse procedures, exact limits and quarterly drill instructions are
in [`docs/haili-operations.md`](haili-operations.md).

The same-provider Grant lifecycle was subsequently completed against Grant
`01a15fdb-2bd0-7433-8afa-bd0355e0608c`. A restrictive expiry update propagated
as active revision 2 with identical digest on both local roles and publication
HTTP 204. Message `01a15fe5-dd7a-753b-a1b2-c7df83d4b200` then reached
authenticated `delivered` revision 2. Revocation propagated as revision 3 with
the same digest on both roles and publication HTTP 204.

The first post-revocation send correctly created no envelope but exposed a
classification defect: known authorization failure was returned as retryable
HTTP 503. Commit `c88cfb7` introduced a narrow authorization error boundary, so
invalid Grant scope/state and unavailable reply invitations now return
non-retryable HTTP 409 while infrastructure failures remain 503. Exact retry of
message `01a15fe6-51be-7b30-929b-22de352d7752` returned 409, remained absent
from Sent and retained no envelope. The release archive SHA-256 is
`69688be4c660265b1fb5589e47642d87f31162d13c78be2416ceede5177cf9fc`;
the provider remained healthy with zero unexpected restarts.

## Documentation disposition

Completed October 21, 2026. Active guidance now points to the strict-public
deployment and current gate documents; dated POC and milestone records were
removed after their useful guidance was consolidated.

| Document | Disposition |
| --- | --- |
| `apps/cli/docs/cli-roadmap.md` | Keep as the concise capability and gate summary. |
| `apps/cli/docs/custody-transitions.md` | Keep as the detailed production-gate authority; archive completed checklist sections when distilled. |
| Completed reader-refactor plans | Deleted after consolidation into `spec/plc-read-evidence.md`, `spec/did-profile.md` and operator guidance. |
| `docs/portable-custody.md` | Keep the custody architecture, transfer invariants and private-POC boundary; completed rollout plans were removed. |
| Completed CBOR migration plan | Deleted after its normative rules and remaining work were consolidated into the encoding specification, object specifications and codec documentation. |
| `BUILD_ORDER.md` | Keep as architectural background, not an execution checklist. |
| Completed POC cleanup audit | Deleted after the deferred compatibility cuts finished; historical migrations and required readers remain intact. |

Do not delete private-PLC fixtures, applied migrations or compatibility readers
while they remain required for recovery and regression evidence.
