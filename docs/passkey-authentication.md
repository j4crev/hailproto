# Passkey Authentication

Reference-provider authentication and recovery behavior.
This document defines provider-local account authentication, not a Hail
federation requirement. Hail protocol authority remains defined by the
specifications in [`../spec`](../spec).

## Goals

- Passwordless, phishing-resistant account login without SMS or TOTP.
- Support web, Android, iOS, macOS, Windows, Linux and `hailp`.
- Keep long-lived account credentials and Hail private keys out of browsers.
- Continue to work when a Hail address changes.
- Preserve independent-provider boundaries during provider transfer.
- Provide deliberate recovery without letting login silently change custody.

## Non-goals

- A passkey is not a Hail federation key, `#hail-identity` signature or PLC
  recovery signature.
- Providers do not share one central Hail relying-party identity.
- Passkeys do not migrate between providers.
- The first slice does not add passwords, SMS, TOTP, email magic links, social
  login or a custom authenticator protocol.
- The first slice does not require native WebAuthn bindings in every client.

## Decisions

1. The reference provider uses discoverable WebAuthn credentials: passkeys.
2. Each provider is its own WebAuthn relying party. For example, Haili uses an
   RP ID under `haili.app`; another provider uses its own domain.
3. WebAuthn's immutable `user.id` is an opaque random provider-local account
   identifier. It is not a Hail address. The current address is display metadata
   and may change without invalidating credentials.
4. Accounts may register multiple passkeys. A synced passkey, another device or
   a hardware security key can provide redundancy.
5. Registration and authentication require user verification. The baseline
   requests a discoverable credential and uses no identifying attestation
   policy. Hardware allowlists may be added only for a separate documented need.
6. The provider stores public credential material only. Private keys and local
   biometric/PIN data remain with the authenticator or credential provider.
7. Browser login creates a revocable server-side session represented by a
   secure cookie. It does not expose a long-lived account API bearer credential
   to browser JavaScript.
8. Native clients and `hailp` authenticate in the system browser and receive a
   one-use authorization code bound with PKCE. Direct authenticator access is
   deferred.
9. Adding or removing a passkey requires a trusted existing account path and
   recent user verification. Registration is never authorized by supplying an
   address, DID or account ID alone.
10. Hail authority remains custody-specific. A passkey-authenticated session can
    request allowed account operations, but it cannot substitute for an owner
    signature, top recovery authority, custody transition or transfer approval.

## Authority Boundaries

| Mechanism | Scope |
| --- | --- |
| Passkey | Provider-local account authentication |
| Server session | Temporary account API authorization at one provider |
| API credential | Provider-local non-browser access, including `hailp` |
| `#hail-identity` | Hail identity objects such as Grants and Address Bindings |
| Top PLC recovery key | Reviewed onboarding, recovery, custody and transfer operations |
| Provider messaging/rotation keys | Provider operations allowed by the selected custody profile |

For an owner-controlled account, a logged-in session still cannot manufacture
an owner identity signature. For a managed account, an authorized session may
request the provider-held identity signer under the account's policy. Neither
case lets the session replace owner recovery authority.

## Platform Strategy

WebAuthn is available in current major browsers and operating systems. Passkey
synchronization is credential-provider-specific, so Hail must not promise that
one passkey automatically appears on every platform.

| Platform | Baseline path | Optional native path |
| --- | --- | --- |
| Web/PWA | Browser WebAuthn | Not applicable |
| Android | System browser | Android Credential Manager; requires Digital Asset Links |
| iOS/iPadOS | System browser | AuthenticationServices; requires an associated `webcredentials` domain |
| macOS | System browser | AuthenticationServices, Touch ID, iCloud Keychain or security keys |
| Windows | System browser | Win32 WebAuthn, Windows Hello or security keys |
| Linux | Browser with a credential manager, phone or security key | `libfido2` hardware-key support only if later justified |
| `hailp` | System browser plus loopback callback and PKCE | Direct CTAP/libfido2 access deferred |

A first-party application can be associated with one provider domain. A generic
Hail application cannot assume every independent provider has published Apple
and Android association records for it. The system browser is therefore the
portable default: browsers are already authorized to perform WebAuthn for the
provider being visited.

The login UI must provide an explicit **Sign in with a passkey** action. It may
also use conditional mediation when feature detection confirms support, but
autofill-only login would exclude otherwise valid clients.

Platform references:

- [MDN Web Authentication API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API)
- [Android passkeys and Credential Manager](https://developer.android.com/identity/passkeys)
- [Apple passkey support](https://developer.apple.com/documentation/authenticationservices/supporting-passkeys)
- [Microsoft Windows passkeys](https://learn.microsoft.com/en-us/windows/security/identity-protection/passkeys/)
- [FIDO passkeys](https://fidoalliance.org/passkeys/)
- [`libfido2`](https://developers.yubico.com/libfido2/)

## Account Identification

The provider maps the opaque WebAuthn user handle to its existing account ID,
DID, current address and serving generation. Suggested credential metadata:

- credential ID and COSE public key;
- provider-local account ID and serving generation;
- signature counter, treated as a security signal rather than an unconditional
  failure because synced authenticators do not always expose monotonic counters;
- authenticator transports as hints, not authority;
- backup eligibility/state when supplied by the client;
- user-selected label, creation time, last-used time and revocation time.

The passkey's displayed account name may use the current Hail address. Address
changes update provider records and, where supported, credential-provider
metadata; they never change the opaque `user.id` or credential ownership.

## Trusted Enrollment Paths

Passkey registration attaches a new login authority to an account. The provider
must first establish that the requester controls that account.

### New account

The owner-authorized onboarding ceremony creates and activates the account.
When requested after activation, the provider issues a short-lived, single-use passkey
enrollment capability bound to the exact account and serving generation.
`hailp account create --passkey-enrollment new-account.passkey.json` generates
an independent token, sends it only to the selected provider and stores the
returned enrollment URL in that private file. Open the URL within ten minutes;
the browser receives the enrollment capability, never the signup API credential
or Hail private keys.

### Existing account

An existing account may start enrollment after one of:

- a current appropriately scoped API credential;
- an authenticated session followed by fresh passkey user verification;
- the existing account-access recovery ceremony.

Adding or removing a credential is a step-up operation. A stale session alone
is insufficient.

### Lost account access

The existing Hail owner-proof recovery paths bootstrap a new passkey:

- owner-controlled account: current `#hail-identity` proof or an explicitly
  selected top-recovery proof;
- managed account: owner top-recovery proof, never the provider-held identity
  key standing in for the owner.

Successful recovery returns a single-use enrollment capability. It does not
rotate Hail keys, alter custody or publish a PLC operation.

The reference CLI creates the capability without exposing owner keys or a
long-lived API credential to the browser:

```console
hailp account passkey-recover \
  --provider https://provider.example \
  --did did:plc:... \
  --signer owner-recovery \
  --vault owner.vault.json \
  --state passkey-recovery.state.json \
  --output passkey-enrollment.json
jq -r .url passkey-enrollment.json
```

Open the resulting URL within ten minutes. The URL is stored in a private file
because it is a bearer enrollment capability; normal CLI output redacts it.
Owner-controlled accounts may explicitly select their current identity signer.
Managed accounts must use independent owner recovery. Delete the state and
enrollment files after the replacement passkey has been tested.

If one passkey still works, sign in, verify again on the security page, add a
replacement, test it after signing out, then revoke the lost credential. If no
passkey works, use the owner-proof command above, enroll and test the replacement,
then use **Sign out everywhere** and revoke the lost credential. Never send the
enrollment file or URL to another person: until it expires or is used, it grants
one passkey registration. Losing both all passkeys and the independent owner
vault/recovery material has no provider bypass. Provider transfer likewise needs
new passkeys at the destination; source passkeys do not move.

### Provider transfer

The source passkeys remain source-provider credentials and become unusable with
the retired account generation. After destination activation, the user performs
destination owner-proof login and registers a new destination passkey. The
destination does not import source credential IDs, public keys, sessions or API
tokens.

## Registration Ceremony

1. Verify the trusted enrollment path and exact active account generation.
2. Create a cryptographically random, purpose-bound, short-lived challenge.
3. Return WebAuthn creation options with the provider RP ID, opaque user handle,
   `residentKey: "required"` and `userVerification: "required"`.
4. The browser or native platform creates the credential after local user
   verification.
5. Verify the exact challenge, expected origin, RP ID hash, ceremony type,
   user-verification flag, public-key algorithm and response structure.
6. Reject reused challenges, duplicate credential IDs, changed account
   generations and malformed or oversized responses.
7. Store the credential public material atomically with challenge consumption.
8. Return a generic success response without exposing other account credentials.

Use a maintained WebAuthn verification library rather than implementing CBOR,
authenticator-data or attestation parsing in application code. The selected
library must run under Bun and expose the exact verification inputs above.

## Authentication And Session Ceremony

1. Create a short-lived one-use authentication challenge without requiring an
   address or username.
2. Omit `allowCredentials` so the authenticator can discover matching accounts.
3. Require user verification and verify challenge, origin, RP ID hash, ceremony
   type, credential signature and active account/generation.
4. Consume the challenge once and update credential security metadata.
5. Create a random server-side session. Store only a hash of its bearer token.
6. Send the token in an `HttpOnly`, `Secure`, appropriately `SameSite` cookie.
7. Rotate the session identifier at authentication and privilege changes.
8. Apply idle and absolute expiration, explicit logout and account-wide session
   revocation.

Mutation requests additionally require expected-origin checks and CSRF
protection appropriate to the final deployment origins. Authentication failures
must not reveal whether a DID, address, account or credential exists.

## GUI Integration

The GUI uses per-user provider sessions:

```text
browser -> provider passkey ceremony -> secure session cookie
        -> account-scoped GUI requests -> existing account services
```

Routine account pages receive neither Hail private keys nor long-lived API
credentials. Server-rendered routes resolve the authenticated account from the
session. Signup has a separate, transient owner-key boundary documented in
[public authentication](public-authentication.md); there is no fixed shared GUI credential.

## `hailp` And Native Application Login

The baseline command behaves like:

```console
hailp account browser-login \
  --provider https://provider.example \
  --state browser-login.state.json \
  --credentials account.credential.json
```

1. `hailp` generates state, a PKCE verifier/challenge and a loopback callback.
2. It opens the provider's authorization URL in the system browser.
3. The provider performs normal passkey authentication.
4. The browser redirects a short-lived one-use code to the loopback callback.
5. `hailp` checks state and exchanges the code, verifier and exact redirect URI.
6. The provider issues an appropriately scoped provider-local API credential.
7. `hailp` stores it using the existing private credential-file rules.

The initial browser-issued CLI scope set is `account:read`, `grants:read`,
`messages:read` and `messages:write`. Callers may request a narrower subset;
browser login cannot mint credential-management or account-write authority.

Authorization codes are bound to the provider, client, redirect URI, account,
serving generation and PKCE challenge. They are never bearer credentials and
cannot be replayed after exchange.

Mobile and desktop apps use the same authorization-code design with claimed
HTTPS or private app callbacks and PKCE. Native passkey APIs can later replace
the browser presentation while preserving the server ceremonies.

A headless device-code flow is deferred until required. It needs explicit
anti-phishing UX, short expiry, clear provider/account/client presentation and
one-use polling semantics. Direct CTAP support in `hailp` is also deferred
because it adds native dependencies while covering fewer synced passkeys than
the browser.

## Credential Management And Recovery Policy

- Let users list, label, add and revoke their own passkeys.
- Never return stored public-key bytes unless a diagnostic need is reviewed.
- Require recent user verification before adding or revoking a passkey.
- Do not allow removal of the last passkey unless owner-proof recovery remains
  verified and available.
- Encourage a second passkey, hardware key or independent owner-recovery path
  before retiring the bootstrap API credential.
- Revocation invalidates that credential immediately and may optionally revoke
  sessions authenticated by it.
- Account retirement or serving-generation advancement invalidates every old
  passkey session and authorization code.
- Synced-passkey backup flags inform UX and risk signals but do not prove that a
  user has a provider-independent Hail recovery backup.

## Security Requirements

- HTTPS is mandatory outside loopback development callbacks.
- Configure an exact RP ID and explicit origin allowlist; never infer either
  from an untrusted request header.
- Challenges use cryptographically secure randomness, short expiration,
  purpose separation and atomic one-time consumption.
- Require user verification; user presence alone is insufficient.
- Prefer the interoperable ES256 algorithm initially and add algorithms only
  with platform tests and server-library support.
- Use no attestation or identifying hardware policy by default.
- Bound all WebAuthn, callback and credential-management request sizes.
- Rate-limit registration, authentication, recovery and code exchange without
  creating an account-enumeration oracle.
- Do not log challenges, session tokens, authorization codes, API credentials,
  complete credential IDs or Hail private artifacts.
- Emit one bounded structured authentication event containing only the fixed
  operation name, accepted/refused/failed outcome and HTTP status.
- Treat signature-counter regression as a risk event requiring policy review,
  not an automatic lockout for every synced passkey.
- Bind sessions and passkeys to active account and serving generations so stale
  provider workers, transfers and restored credentials cannot regain access.
- Keep owner-signature and recovery checks at their existing trust boundaries;
  passkey login must not introduce a managed fallback.

## Remaining validation and options

- Record supported browser/platform minimums; deployed algorithms are ES256 and RS256.
- Optional conditional mediation needs feature detection.
- Complete the real-device matrix across Android, iOS, macOS, Windows and Linux.
- Exercise synced passkeys, hardware keys and phone-based cross-device authentication.
- Verify `hailp` system-browser login on each supported desktop platform.

Virtual-authenticator tests and mobile viewport emulation do not establish those
platform guarantees. Authentication, session and recovery requirements below remain
ongoing acceptance criteria.

## Acceptance Conditions

The first slice is complete when:

- a user can open the GUI and sign in without an address, username, password,
  SMS or TOTP;
- the browser receives only a secure session cookie and no Hail private key or
  long-lived API credential;
- changing the account address does not break login;
- multiple passkeys can be managed with recent user verification;
- `hailp` can obtain a scoped provider credential through browser login and
  PKCE on Linux, macOS and Windows;
- owner-proof recovery can enroll a replacement passkey without changing Hail
  custody or PLC state;
- a transferred account requires a fresh destination-provider passkey and old
  provider credentials remain terminal;
- replay, wrong-origin, stale-generation, cross-account and lost-response tests
  pass; and
- private GUI routes resolve an authenticated account without a fixed shared credential.

## Deferred Options

- Native Android Credential Manager and Apple AuthenticationServices UX.
- Windows native WebAuthn integration.
- Direct hardware-key support in `hailp` through `libfido2`.
- Headless device authorization.
- OIDC/social login, email links or one-time recovery codes.
- Hardware attestation policy.
- Cross-provider client-auth API standardization.

Add these only when a concrete platform or recovery requirement justifies the
extra trust dependency and implementation surface.
