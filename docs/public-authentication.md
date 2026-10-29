# Public authentication and consumer signup

## Current signup flow

The browser supports managed signup under the reduced-assurance alpha profile.
An operator enables the signup service and controls invitation/public registration
through the provider dashboard. An invitation grants admission, never login or recovery.

The wizard checks the address, explains custody/monitoring, generates owner recovery
material locally, verifies a saved recovery package, verifies external email, asks
for explicit publication, waits for monitored activation, and enrolls/tests a passkey.
It creates no full-access signup API credential. The exact resumable flow and expiry
behavior are in the [client guide](../apps/client/README.md#invited-signup); setup
configuration is in the [provider guide](../apps/server/deploy/public/README.md).

One DID-bound recovery package contains a v1 vault, exact signed genesis and encrypted
temporary setup authority. Keep its random secret separately. Verify the actual saved
file before publishing. Browser-local encrypted state is a convenience, not the only
backup. Lost responses and reloads resume the original identity; they never generate
replacement keys or another DID. Fresh passkey sign-in retires setup authority.

Federation activation and completed consumer setup are separate states. A published
PLC identity cannot be erased by cancelling a wizard. Setup capability expiry does
not expire recovery keys. Active-account access uses existing owner-proof tooling;
unregistered/inactive attempts may require provider assistance.

## Browser key boundary

Transient owner-key handling is supported during signup, with explicit consent.
Private keys and recovery secrets are not intentionally uploaded, logged or retained
for routine sessions. Sensitive pages use restricted CSP, no third-party scripts,
no-store responses and encrypted resumable state. Ordinary managed signatures remain
provider-side; passkeys authenticate local accounts and do not sign arbitrary Hail/PLC objects.

Compromised signup JavaScript could still steal unlocked recovery material.
Nonexportable browser keys, a PWA or a separate origin do not remove that threat.
Browser import for recovery of a completed account remains a separately reviewed,
unimplemented product surface. The signup-file resume screen is not that feature.

## Monitoring and alerts

The [alpha profile](../spec/alpha-onboarding.md) explicitly permits same-operator
monitoring with reduced assurance. Separate hosting and signed reports do not prove
administrative independence. Preserve the strict-public independent-monitor profile
and reject attempts to relabel alpha/private evidence as independent authority.

The monitor validates the exact owner-signed genesis, confirms the verified external
email binding through a signed request, retains full per-DID history and requires
successful consumer notification plus a fresh healthy poll before attestation.
The provider verifies the resulting evidence before activation. Operator fallback
mail does not establish delivery to the consumer's destination.

Coverage loss and unexpected operations need actionable alerts and urgent recovery
ownership. Keep an external alert channel: the monitored provider may be unavailable
or compromised. Future Hail alerts require explicit recipient Grants and durable
delivery, and cannot be the sole channel through the same monitored account.

## Remaining work

- Define and verify the supported desktop/mobile browser and passkey matrix.
- Review post-signup browser recovery, device loss and clean-browser restoration.
- Handle asynchronous email bounces/complaints and measure deliverability.
- Confirm incident/support ownership, retention and enrollment operating costs.
- Validate broader unassisted signup, reservation abuse and resource exhaustion.
- Measure completion, abandonment and recovery without collecting secrets or screen contents.

Registration can return to invitation-only while admitted setups resume within their
fixed lifetime. Disabling the signup endpoint itself also affects continuation;
plan recovery for pending ceremonies before doing so. Existing passkey login is a
separate service. See [passkeys](passkey-authentication.md) and
[browser permissions](browser-permissions.md) for ongoing account access and consent.
