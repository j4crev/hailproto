# Public Authentication And Consumer Signup

Implementation update: the invited signup refactor now uses focused wizard screens
and one recovery package. Provider schema 73 separates provisional preparation
from verified backup evidence; the UI saves and verifies a final identity-bound
package before explicit publication. Existing pending files are supported, and
`hailp vault import` extracts a compatible v1 vault offline. See
[invited signup](../apps/client/README.md#invited-signup) for rollout order,
interruption behavior, expiry limits and rollback. This is a local implementation
update, not a production deployment or a broader recovery-platform validation.


Status: product plan, not implementation approval or a change to protocol requirements.

## Implementation Progress

- Browser-safe vault encryption/verification is shared with `hailp`, preserving
  the existing v1 backup format. Managed genesis signing also shares the reviewed
  role checks and signing implementation with the CLI.
- A real Chromium check covers generation, encrypted export, saved-material
  verification, incorrect-secret refusal and exact-state signing, with network
  connections blocked by CSP. Unit tests cross-check signatures, DID and CID
  against the official PLC library. Other browser/platform results remain open.
- An opt-in local recovery preview exists at `/signup/recovery` with
  `HAIL_GUI_SIGNUP_PREVIEW=true`. It creates no account, publishes nothing and
  does not implement post-signup recovery import.
- Migration 57 and the public onboarding service support separately retained
  `reduced-assurance-alpha-v1` monitoring for explicitly consenting managed
  accounts. Tests cover strict/alpha isolation, old-writer mislabel refusal,
  unchanged freshness checks and guarded rollback.
- [The alpha profile](../spec/alpha-onboarding.md) records its exact limits.
  No public alpha account-creation route or automatic monitor enrollment is
  enabled in production yet. Browser signup is not end-to-end complete.
- Cloudflare Email Sending is selected, using `notify.haili.app`. The existing
  Worker now supports authenticated verification codes and immutable per-DID
  routing to verified consumer destinations, while retaining operator alerts for
  existing unmapped canaries and infrastructure health transitions.
- An optional same-origin provider proxy hides the Worker service secret and
  binds email only to the matching owner-authorized, registered alpha genesis.
  Enable it with private `SIGNUP_EMAIL_ORIGIN` and `SIGNUP_EMAIL_TOKEN` settings.
  This does not yet connect the full browser wizard or automate monitor enrollment.
  See the [email Worker runbook](../apps/plc-monitor/deploy/cloudflare-alert-worker/README.md).
- The email Worker and provider proxy were deployed October 22, 2026, from
  release `95f36b1`. The operator confirmed receipt of the verification email;
  the provider-to-Worker exact start retry returned the same expiry without a
  second email. Schema 57, provider/GUI health and unchanged account keys/passkeys
  were checked. No test DID or account was created or bound. The recovery preview
  remains disabled in production.
- Automatic monitoring now has local end-to-end proof across the provider,
  monitor and email receiver. It binds verified email, independently confirms
  that binding through a signed monitor request, enrolls the exact owner-signed
  genesis and waits for accepted consumer-only notification plus a fresh poll.
  The provider cryptographically verifies the returned attestation before
  activation. Operator fallback cannot satisfy consumer notification.
- Exact retries preserve monitoring history and ambiguous replies do not create
  replacement identities. Tests cover notification failures, stale coverage,
  tampered signatures and restart. Optional API/configuration gates default off;
  the initial implementation left production unchanged pending a guarded rollout.
  See the [monitor enrollment runbook](../apps/plc-monitor/deploy/public/README.md#automatic-reduced-assurance-alpha-enrollment).
- The invited, resumable signup backend now has local proof through real passkey
  registration and scoped sign-in. It creates no full-access signup credential;
  fixed-expiry setup/enrollment authority is retired only after tested passkey
  access. Migration 58 retains immutable intent, exact genesis, activation proof
  and terminal authority. Activation epochs fence superseded controllers.
  Admission is provider-bound and single-use; the account-creation surface is
  explicitly gated off by default.
  See the [backend runbook](../apps/server/deploy/public/README.md#invited-browser-signup-backend-local-implementation).
- Rollout preparation staged provider release `dc6458d` and compatible receiver
  version `8566a060-ed8b-4a83-a5c6-45a904f1f9b4`. Provider readiness and passkey
  login return 200; signup, monitor orchestration and the recovery preview remain
  404/gated off. Monitor containers and heartbeat remain on their legacy runtime.
  Private configuration is staged for the console-approved setup; it has not
  enabled a listener, changed monitor keys or broadened SSH/sudo access.
- The monitor bridge and provider connection are now complete (October 23, 2026
  UTC). Trusted HTTPS returns 401 without service authentication and 400 for an
  authenticated empty request; non-provider traffic is denied with 403 even with
  a spoofed forwarding header. Port 3001 is loopback-only, the original monitor
  key/database paths remain, and the encrypted post-switch backup is verified
  off-host. Provider readiness/login and external heartbeat remain healthy.
  Setup staging secrets were removed after handover. The orchestration endpoint
  is enabled; public signup and recovery preview remain disabled.
- The invited browser wizard is implemented at `/signup`, behind the same
  explicit alpha gate (mapped to private GUI flag `HAIL_GUI_SIGNUP`). It checks
  address availability under an invitation before key generation, verifies the
  saved recovery kit, and stores/exports only AES-GCM-encrypted pending setup.
  The separately saved recovery secret is never retained with that state.
  Prepared genesis signing, external email, monitored activation and existing
  passkey ceremonies reuse the backend. A final v1 recovery vault includes the
  actual DID. A fresh passkey login retires setup authority and clears browser
  pending state; downloaded obsolete setup files must be removed by the user.
- Local Chromium proof exercises the built page, real saved-file import,
  wrong-secret refusal, storage eviction, exact signed-genesis retries, reloads
  during monitoring/after passkey enrollment, virtual-authenticator WebAuthn
  registration/login verification and terminal cleanup. It uses simulated mail,
  activation and monitor responses, not a real production identity. Separate
  PostgreSQL integration tests cover the real coordinator/monitor/mail services.
  Both desktop and 390px mobile-viewport Chromium checks pass; this is not proof
  of native mobile passkeys. Real mobile platforms and the invited live ceremony
  remain outstanding.
- Release `93d5be6` is deployed with the wizard/account-creation gates still off.
  External readiness and passkey login return 200; `/signup`, recovery preview,
  account creation and invited address checks return 404. The monitor and source-IP
  restriction remain healthy. No live invitation, account or DID has been created.

The monitor uses the confirmed `hailops@2.25.206.150` agent connection and its
restricted wrapper. One-time console approval installed the protected source
bridge and provider configuration operation; no root SSH or unrestricted sudo
was enabled. The legacy checkout remains for rollback, not for new code builds.

Pilot update: invitation-gated signup is now enabled. The operator confirmed the
enrollment security email and passkey/setup completion. Premature sign-in and
alpha account-client validation bugs were repaired in `606a7cb` and `f9d30bb`.
The operator confirmed inbox access, created the sender permission through the
GUI, opened the delivered canary message and successfully replied once. The
canary inbox independently confirms receipt. This completes the first invited
browser pilot, not wider consumer enrollment or general recovery validation.
Follow with wider platform/recovery validation before more invitations.
The GUI now implements [Allowed senders](browser-permissions.md): address
entry and identity-pinned public QR links lead to a single review; managed Grant
approval/revocation requires an account/session-bound exact-action passkey proof.
It reuses the existing Grant lifecycle without adding broad session write scopes.
This slice is deployed at `377c62c`; public health and access guards pass. The
operator approved the live canary sender from j4 and completed the exchange.
No live Grant was pre-created by the agent.
Do not treat a delivered operator email as verification of a signup
user's external alert destination. Asynchronous email bounce/complaint handling
and broader deliverability monitoring remain rollout gates.

Treat guided CLI signup as a bridge, not the consumer solution. The long-term
goal is a mobile-friendly browser wizard that handles recovery, monitoring and
passkey enrollment without terminal commands, file paths or operator intervention.

The central product decision is where owner keys live. A prettier signup form
cannot resolve that.

## Product Decisions

- **Browser-first:** target desktop and mobile browsers. Do not require an
  installed setup application unless investigation shows a material security or
  compatibility obstacle that cannot reasonably be resolved in the browser.
- **Transient browser recovery keys:** approved for signup. Generate and use
  owner recovery keys locally in the browser for backup verification and exact
  genesis signing; do not intentionally upload keys or recovery secrets, or
  retain plaintext recovery authority for ordinary sessions. This accepts the
  risk that compromised signup JavaScript could steal recovery material.
  Approval does not yet extend to browser-based recovery import after signup.
- **Managed identity:** expect most ordinary users to select managed identity,
  with explicit consent and owner-held recovery. Preserve the owner-controlled
  path without silently changing anyone's custody.
- **Existing monitor:** use the project's existing monitor for the early rollout.
  It is not administratively independent; disclose that limitation rather than
  presenting its signatures or separate hosting as proof of independence.
- **Reduced-assurance alpha:** approved product direction for early monitoring.
  Use the existing same-operator monitor with explicit limitations, while
  preserving a distinct independent-monitor production profile.
- **Alerts:** an external email requirement is acceptable initially. Prefer
  adding Hail delivery when practical, but do not rely solely on the monitored
  provider's inbox for security alerts.

Transient browser handling of owner recovery material during signup and the
reduced-assurance monitoring direction are approved. Browser compatibility,
security controls, exact profile changes and enforcement still need implementation
and verification. Do not silently weaken existing strict-public requirements.

## Existing Implementation And Constraints

- Passkey login, browser sessions and owner-proof replacement enrollment already
  exist.
- Both custody profiles retain independent owner recovery and monitoring
  requirements under the current specifications.
- The browser currently receives neither Hail private keys nor long-lived API
  credentials. Browser-based owner-key generation and recovery would change that
  boundary, even if keys never leave the device through intended requests.
- Managed custody simplifies everyday signing, but does not eliminate owner
  recovery or the current independent-monitor requirement.
- The onboarding endpoint currently issues a full-access bootstrap credential,
  even when passkey enrollment is requested.
- [The Haili launch record](haili-launch.md) records public onboarding as enabled.
  That does not establish an unrestricted consumer launch or prove invite
  enforcement. Check launch policy and actual enforcement separately.

Relevant references:

- [Passkey authentication](passkey-authentication.md).
- [Portable custody and trust boundaries](portable-custody.md).
- [Account onboarding requirements](../spec/account-onboarding.md).
- [Managed custody requirements](../spec/managed-custody.md).
- [Device-keystore boundary](../apps/cli/docs/device-keystore.md).

## Target User Experience

A typical person should experience roughly this:

1. **Choose your address.**
2. **Review how your account is protected**, including who controls everyday
   permission signing and the early monitor's limitations.
3. **Save and verify your recovery kit**, using ordinary device save/share/print
   controls.
4. **Verify an external security-alert destination.** Email is an alert channel,
   not an account-recovery bypass.
5. **Create a passkey.**
6. **Enter Hail and complete one useful interaction**, such as accepting an
   invitation and exchanging a message.

Underneath, Hail registers the identity, enrolls monitoring under the explicitly
approved launch profile, verifies activation and removes temporary signup
authority. The interface shows meaningful progress and offers **Continue setup**
after interruption.

The precise ordering must respect activation gates. This describes the
experience, not a replacement protocol or permission to bypass current gates.

## Plan Steps

### 1. Review Browser-Based Owner Recovery

| Path | Benefit | Cost |
| --- | --- | --- |
| Managed identity, owner-held recovery | Everyday web use without a local identity signer | Provider can sign permissions; owner recovery still needs a trusted client |
| Owner-controlled identity | Preserves user-controlled consent signing | A user-controlled signer must support routine permission changes and binding renewal |

Lead the consumer experience with explicitly selected managed identity. Explain
the difference in plain language, not just an “advanced” toggle.

For managed browser signup, investigate local generation, backup verification
and exact genesis signing using the existing cryptographic formats and reusable
logic. Recovery authority must not be needed for ordinary browser sessions.

The review must address:

- Browser compatibility for the existing cryptography, encrypted exports and
  clean-browser recovery on both desktop and mobile.
- Temporary handling of recovery material without uploading plaintext keys or
  recovery secrets, retaining them for routine login, or sending them to logs,
  analytics, error reporting or service-worker caches.
- Encrypted resumable state and what survives tab closure, storage eviction,
  device loss and an ambiguous registration response.
- A minimal sensitive ceremony with no third-party scripts, restrictive content
  security policy and reviewed dependency/deployment practices.
- The remaining threat: compromised or maliciously served JavaScript can steal
  keys while they are being generated or imported. Non-exportable browser keys
  and a separate origin alone do not remove that threat. Do not claim native or
  offline signer equivalence.
- Explicit revision of the current browser-key boundary if this route is
  accepted. A PWA does not avoid that architectural decision.

If the review finds an unacceptable obstacle, compare an installed signer or
setup application before committing to one. Do not silently fall back to
provider-held owner recovery.

**Exit condition:** tested platform matrix and verified implementation of the
approved transient signup-key boundary. Review browser-based recovery import
separately before enabling it.

### 2. Define One Resumable Signup Lifecycle

Reuse existing onboarding services, vault logic, monitor evidence and passkey
ceremonies. Do not implement a second onboarding engine in the GUI.

Track distinct milestones:

- Recovery backup verified.
- Exact identity operation reviewed and retained.
- Registration submitted or awaiting reconciliation.
- Monitor enrollment and alert path confirmed, with the coverage class recorded.
- Federation activation verified under the approved profile.
- Passkey enrolled and fresh login tested.
- Temporary signup authority retired.

Distinguish **federation active** from **consumer setup complete**.

Interruption must never silently generate replacement keys or another DID.
Cancellation after public registration must explain that the public identity
record cannot be erased.

**Exit condition:** every interruption point has a documented resume or recovery
outcome, including loss of browser-local state.

### 3. Make Recovery A Usable Product Feature

Build the graphical recovery ceremony before inviting ordinary users:

- Generate recovery material locally under the approved browser trust model.
- Export a portable encrypted kit with clear instructions.
- Keep the random recovery secret separately protected; do not save it beside
  the vault by default.
- Verify recovery by reopening/importing the saved material and checking the
  expected keys—not merely checking “I backed it up.”
- Explain the difference between losing a passkey, losing a device and losing
  all recovery material.
- Offer a second passkey after signup, without presenting it as independent
  identity recovery.
- Preserve compatibility with existing recovery formats and owner-proof paths.

Keep recovery authority out of routine device signing storage, consistent with
the [device-keystore boundary](../apps/cli/docs/device-keystore.md). A passkey is
provider login authority, not an arbitrary Hail or PLC signer.

**Exit condition:** a user can restore access in a clean supported browser
without the original device, CLI or staff handling secrets.

### 4. Productize The Existing Monitor With Honest Guarantees

Use the existing monitor; do not make funding a new independent service a
prerequisite for developing the consumer experience.

Before public activation, resolve the conflict with the current specifications:
they require monitoring outside the provider's administrative control for both
portable and managed public onboarding. A same-operator monitor does not satisfy
that requirement, regardless of signed evidence.

The approved direction is a separately identified **reduced-assurance alpha**
using the existing same-operator monitor. Implement the required specification,
policy and conformance changes explicitly; preserve independent-monitor checks
for the strict-public profile. Do not impersonate independent evidence, quietly
relax strict-public validation or reuse private-POC guarantees as public proof.
Until the distinct alpha path is implemented and verified, keep the consumer
path in testing or staging rather than bypass the activation gate.

Suggested user-facing disclosure:

> Reduced-assurance alpha: Hail's monitor is operated by the same operator as
> this provider. It can detect unexpected identity changes and monitoring gaps,
> but does not provide independent protection against that operator suppressing
> alerts. You retain your own recovery material. Recovery remains time-sensitive,
> and a recovery backup alone does not guarantee protection.

Reduced assurance applies to monitor independence only. Preserve backup
verification, exact operation review, cryptographic verification, monitoring
health and alert testing, recovery deadlines and credential isolation.

The consumer enrollment flow should:

- Verify an external alert destination without asking users to configure webhooks.
- Bind enrollment to the exact reviewed DID operation and full expected state.
- Preserve signed evidence, healthy observation and notification testing.
- Distinguish notification delivery from proof the user controls the destination.
- Provide actionable coverage-loss and unexpected-change alerts, including
  recovery deadlines.
- Define support ownership, retention and ongoing operating cost.
- Preserve a path to genuinely independent monitoring without changing user
  identity or requiring signup to start over.

Automate enrollment and evidence exchange, not blind approval of unexpected
identity changes. Same-operator monitoring remains useful for operational errors
and some attacks, but does not protect against that operator suppressing alerts.

#### Email And Hail Alert Delivery

Initially retain external email for security alerts. It is an out-of-band channel,
not social login, proof of owner recovery authority or permission to reset keys.

A Hail-capable monitor is a reasonable later delivery improvement. It would
need explicit recipient Grants, a verified sender identity, durable delivery and
an enrollment test. An explicit user request must authorize any required Grant;
the monitor must not obtain permission by default or bypass normal delivery rules.

Hail delivery to the monitored account is supplementary: the provider could be
offline, compromised or withholding messages. Another Hail inbox can become an
external destination if its provider and access path are sufficiently separate,
but that does not make the monitor itself independent. Remove mandatory email
only after a tested alternative covers the relevant outage and compromise cases.

**Exit condition:** no monitor commands or operator file exchange during signup,
and the actual coverage class and activation policy are explicit and enforced.

### 5. Close The Temporary-Credential Lifecycle

The CLI cleanup proposal is necessary but incomplete:

- For the bridge, verify replacement access before revoking bootstrap access.
- Keep browser-login/PKCE credential issuance optional: web-only users do not
  need a CLI credential.
- For consumer signup, design a narrow onboarding capability instead of
  automatically issuing full account authority.
- Give temporary capabilities bounded lifetimes and explicit terminal states.
- Ensure replaying completed onboarding cannot recreate retired authority.
- Remove temporary bearer material from all retained artifacts, including
  signup state—not only credential and enrollment files.
- Retain non-secret evidence needed for reconciliation and support.

Deleting a local file is not revocation, nor guaranteed secure erasure.

**Exit condition:** completed signup leaves only intended sessions/passkeys and
any explicitly requested client credential.

### 6. Deliver The No-Terminal Browser Wizard

Reuse the provider's browser-based passkey and session flows alongside the
approved local recovery ceremony.

Include:

- Address availability and reservation.
- Plain-language custody, monitor-assurance and permanent-publication disclosures.
- Recovery-kit save and verification.
- External alert verification.
- Automatic monitored onboarding under the approved profile.
- Passkey creation and fresh-login verification.
- Clear waiting, retry and expired-enrollment screens.
- Accessible, mobile-friendly controls.

Start with one provider, the existing monitor and new managed identities. Retain
existing owner-controlled tooling; do not require the first consumer slice to
deliver a new browser-based owner-controlled signer as well. Defer provider
directories, social login, custom domains and existing-DID import from the wizard.

**Exit condition:** an invited nontechnical user completes signup in a supported
desktop or mobile browser without installation, commands, copied tokens or
administrator access.

### 7. Prove That Signup Leads To Useful Use

Do not declare success at an empty inbox:

- Let an invitation lead to an explicit permission decision.
- Demonstrate one successful message exchange.
- Provide understandable permission management and revocation.
- Verify managed binding renewal under deliberate account authority.
- Make passkey loss, device replacement and provider transfer discoverable in
  account settings. Label any remaining CLI-only operations honestly.
- Before advertising a fully browser-based owner-controlled path, provide
  routine identity signing and binding renewal without the CLI.

**Exit condition:** the managed user can complete the first meaningful
interaction and essential account-safety actions through supported interfaces.

### 8. Pilot, Measure, Then Open Enrollment

Launch in stages, subject to the browser and monitoring policy gates:

1. Existing canaries and controlled recovery drills.
2. Staff-assisted nontechnical users.
3. Invite-only, unassisted pilot.
4. Capped public signup.
5. Wider availability after measured reliability.

Measure completion, abandonment by step, time to first useful interaction,
recovery success, support demand and leftover temporary authority. Never collect
secrets or recovery-screen contents.

Before broad launch, test:

- Tab closure, browser restart, storage eviction and network loss at every
  durable boundary.
- Ambiguous PLC writes and duplicate submissions.
- Expired enrollment and interrupted credential cleanup.
- Lost passkeys and clean-browser recovery on desktop and mobile.
- Monitor failure, undeliverable alerts and monitored-provider outages.
- Accurate reduced-assurance labeling and refusal at strict-public boundaries.
- Reservation abuse, signup resource exhaustion and provider restoration.

Pausing new signups must not disable existing users' login or recovery.

## Suggested Priority

Browser recovery/trust review and explicit alpha-monitor profile → recovery ceremony →
automated monitor enrollment → resumable browser wizard → consumer pilot.

A guided `hailp account signup` is worthwhile if developers or operators need it
now. Keep it thin and reusable; do not let CLI polish delay the browser path.

## Remaining Approval Gates

1. Verify browser compatibility and security controls for approved transient
   signup-key handling. Browser-based recovery import still needs separate
   review and approval; no installed application is assumed for signup.
2. Define and verify the approved reduced-assurance alpha's exact monitoring
   profile and activation enforcement. Product approval does not mean the
   existing strict-public implementation already supports this distinction.
3. Choose the initial supported desktop/mobile browser matrix and pilot size.
4. Confirm operational ownership for monitor enrollment, external email delivery
   and urgent recovery assistance. Hail alert delivery is a later improvement,
   not a prerequisite for the first consumer signup slice.
