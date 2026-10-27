# Contact identity notices

The browser client keeps addresses separate from stable Hail DIDs. It never
changes message routing, grants, or connection membership based on an address
notice.

## Automatic connection address changes

A successful provider move already uses authenticated connection handover to
update each peer's address. At that existing commit we retain the previous and
new address as recipient-local presentation state. The seven-day notice starts
only when the handover completes with its verified activation receipt. Exact
retries do not restart the notice. Failed or unfinished moves do not show it;
disconnected/replaced connections do not inherit it. Moving without changing the
address does not produce a notice.

Inbox, Messages, sent/received message details and Connections use the shared
contact-label component. The popup text is exactly:

> Their address changed from X to Y

Hover, keyboard focus or tap opens it; Escape or moving focus dismisses it.
Address/DID conflict warnings take precedence. Browsing older messages or seeing
another alias never generates an address-change notice. Publishers receive no
new address-update messages; a subscription alone does not qualify for a notice.

There is no Settings page, CLI sharing command, notification opt-in, additional
federation protocol, queue or migration snapshot version. The browser reads only
its authenticated account's existing connections through
`GET /api/v1/account/connection-addresses/:did` (`messages:read`). This is not a
public address directory. Failed reads preserve the current display.

Migration 0077 adds a small `connection_address_notices` table. It contains only
presentation metadata, with the existing account write/migration guard and a
serving-generation binding. It is deliberately excluded from portable history:
if the observer moves providers, this temporary notice may disappear. Loss of
this state cannot affect permissions, identity verification or replay protection.
The authoritative handover and connection history remain in their existing
snapshot format.

Browser local storage retains bounded DID/address observations solely to help
identify conflicting identities. This is a presentation hint, not cryptographic
identity evidence. Clearing storage resets those browser observations; server
consent and connection history still participate in approval checks.

## Approval safeguards

Subscription reviews and final subscription/connection confirmations compare
addresses against the account's saved grant consent, established federated
connection pairs, and completed handover destinations. Revoked subscriptions and
disconnected pairs count; unrelated accounts, incoming grants, and empty pairs
never establish familiarity. This lookup is independent of UI pagination.
Browser observations supplement that evidence, including addresses previously
seen in messages. Historical aliases absent from both sources cannot be detected.

A conflicting DID produces a prominent explanation and an explicit acknowledgment
before the passkey prompt. The acknowledgment is tied to the request ID, address,
new DID, and previous DID set. Resumed approvals show the warning again; the UI
refreshes the approval before requesting a passkey, and new conflict evidence
requires another acknowledgment. Already authorized actions retain their existing
recovery behavior. Fresh address/profile digest checks and DID-bound permission
checks remain the provider's responsibility.

This is a user-facing safeguard, not an additional protocol authorization factor.
A modified client can bypass its own warning. Same-DID address changes do not
require new consent, and this feature does not claim to detect compromised DID
keys or a malicious account provider.
