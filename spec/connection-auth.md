# QR Connection Consent — Opt-In Provider-Local Preview

Status: Draft wire format and opt-in managed-account preview (`CONNECTION_PREVIEW=true`).
Preview enabled on Haili by explicit operator approval October 25, 2026. The application
default remains off; the public Haili deployment profile opts in. Security supports personal-code creation/replacement,
separate expiring links/QRs and revocation. `/connect` supports authenticated review and
explicit passkey confirmation. Neither these objects nor the preview store authorize
message delivery. A valid signature alone must not make a connection active.

## Approved Experience

- Connections start through a shared QR/link, not unsolicited inbox messages or
  an invitations folder. The link is what the QR encodes; both use one flow.
- Each supported account has a personal QR with no automatic expiration. It is
  displayed on Security initially, with a future move to My Account. It is not
  automatically published or discoverable merely from someone's address/DID.
- Users may create additional expiring sharing codes. Expiry closes admission of
  new connections, not connections that were already established.
- Showing/sharing a valid code is the creator's standing invitation. The scanner
  reviews the identity and explicitly confirms. No second creator approval is
  required. A public code therefore permits authenticated strangers to connect;
  the management screen must say so before sharing.
- Personal codes may be replaced/revoked if unintentionally shared. That stops
  new redemptions of the old code without recalling established connections.
- No QR token is a login, recovery secret, API credential, or subscription Grant.
  A subscription remains independent of connection consent and vice versa.

## Separate Signed Object Families

The existing `hail.grant` remains unchanged for subscription authorization and
historical decoding. Connection intent has distinct protected COSE content types,
not a `general`/`uncategorized` selector or an unsigned database label:

| Type | Protected content type | Signing authority |
| --- | --- | --- |
| `hail.connection-invitation` | `application/hail-connection-invitation+cbor` | Creator's current `#hail-identity` |
| `hail.connection-confirmation` | `application/hail-connection-confirmation+cbor` | Scanner's current `#hail-identity` |
| `hail.connection-grant` | `application/hail-connection-grant+cbor` | Exact recipient/grantor's current `#hail-identity` |

All use deterministic Hail CBOR, COSE_Sign1/Ed25519, version 1, exact closed maps,
canonical UUIDv7/DIDs and at most 16 KiB signed representations. The structural
fields are in `hail.cddl`; both TypeScript and Go implement them. The dedicated
`connections-draft.json` vectors leave every existing v0 vector unchanged.

An invitation names its creator, invitation ID, hash of a fresh 32-byte admission
token, issuance time and nullable expiry. Null means no scheduled expiry, not
irrevocable permission. The raw admission token is never embedded in the signed
object. Redemption must check current issuer-controlled validity and possession
of the token; a copied signed invitation without the token is insufficient.

A confirmation names both parties, a fresh confirmation ID, invitation ID and
SHA-256 of the **complete signed invitation representation**. It has an explicit
validity window of at most five minutes and cannot target its own signer. This
short confirmation window is distinct from the invitation's configurable lifetime.

A connection Grant names an explicit connection ID and exact grantor/grantee;
it has no subscription categories or wildcard scope. Its consent context binds
the peer's verified address binding, invitation and scanner confirmation through
SHA-256 over their complete signed representations. A materialized Grant must be
checked against the actual proof objects and connection epoch. The handshake must
establish both parties' explicit consent; merely collecting two objects is not a
connection. Custody-safe materialization/delegation must be settled before enabling
the service, not guessed from the presence of a provider-side login session.

Grant revisions retain their original identity/issuance fields, carry a predecessor
representation digest, advance timestamps/revisions and support terminal revocation.
The codec checks structure and field semantics, not the current authoritative
revision or retained historical key state. Those remain store/resolver duties.
A standing connection Grant may have null expiry even when its invitation expires.

## Provider-Local Implementation

`/api/v1/account/connections` is browser-session-only, same-origin, no-store and
source/account rate-limited. Bearer credentials cannot use it. `GET` lists owned
live codes and current connections. `POST /review` checks admission-token possession,
identity pin, signed invitation, current managed custody, identity key and service.
`POST /prepare`, `GET /:requestId`, and `POST /commit` implement session-bound exact-action
passkey reviews for `create`, `replace`, `revoke`, `connect` and `disconnect`.

Creation is an explicit standing-consent action, not an automatic login side effect.
There is at most one live personal code. An additional expiring code needs a label
and exact future expiration within one year; it never replaces the personal code.
Limits are 20 live codes, 20 unfinished reviews and 100 current preview connections
per account. Labels are private. QR rendering uses the existing bundled encoder.
Raw admission tokens are encrypted with AES-GCM under the existing provider KEK,
with a distinct domain/account/invitation AAD; only their hashes enter signed objects.
Code URLs carry ID/DID/token in the fragment. The scanner removes the fragment and
retains it in tab storage across login; login `next` contains only `/connect`.

Both accounts must be externally activated managed accounts on this provider.
Current PLC identity/service authority, public evidence freshness and selected signed
address bindings are checked. The creator's exact-action standing invitation plus
the scanner's exact-action confirmation permit the managed provider to sign both
directional connection Grants. Owner-controlled keys are never substituted.

Transactions lock both account rows in canonical account-ID order. A partial unique
index identifies the one current canonical DID pair. Crossed valid reviews reuse
that epoch and its Grant IDs; whichever confirms first atomically stores the signed
consent/Grants. The other confirmation returns that same connection without creating
another. Expiry is rechecked at final activation after signing. Unconfirmed epochs
expire after five minutes and never count as active connections or inbox requests.

Disconnect ends the epoch without changing any subscription. The signed proof objects
remain immutable; authoritative provider-local terminal state supersedes their active
revision. The preview does not publish independently replayable revocation revisions.
Every invitation created before a disconnect is invalid for reconnecting that pair;
a newly created/replaced code is required. Immutable server creation timestamps, not
second-resolution signed timestamps, establish this local ordering. Committed retries
return their original historical result; uncommitted retries of terminal epochs fail.
The browser checks the current connection list before displaying a resumed success.

Migration 62 is additive. Fence/generation checks apply to both participants and all
mutations. Retained preview consent blocks transfer fences, serving-generation advances
and custody-transition preparation **even after codes are revoked or connections end**.
This deliberately fails closed until exports preserve tokens, consent, epochs and
tombstones; the UI warns before confirmation. Empty-schema rollback is supported,
but schema rollback with any retained invitation/approval/epoch refuses to erase it.
Code rollback must retain the tables. Existing subscription schemas and v0 vectors
are unchanged.

## Still Required Before General Availability

1. Owner-controlled signing and cross-provider admission/reconciliation. A passkey
   login does not confer identity-signing authority; no global transaction is assumed.
2. Explicit persistent block/unblock controls in addition to the implemented disconnect
   tombstones; future message/redemption paths must respect blocks independently.
3. Connection-aware envelope acceptance, delivery-time authorization and feed versus
   conversation classification. Neither the ordinary subscription Grant endpoint
   nor the v0 envelope authorization parser accepts these new objects as authority.
4. Portable export/import and preservation proof
   for permanent invitation state, admission records, connections and tombstones.
   Do not reset codes or erase blocking/replay state to get past a provider transfer.

The preview is not a public-ready messaging release and must not be enabled by an
ordinary deployment without accepting its portability restriction. No current
subscription or single-use reply capability changes.

## Verification In This Slice

TypeScript and Go share signed vectors for permanent/expiring invitations, explicit
confirmation, reciprocal connection Grants and revocation. Tests verify identical
encoded/signature bytes, full-representation digest links, identity-key roles,
closed schemas, bounded confirmation lifetimes, self-connection refusal, mutable
payload isolation in Go and rejection by legacy Grant/envelope inspectors. These
are codec checks. The PostgreSQL integration check additionally uses real passkey
assertions and independent account keys to exercise ownership, code management,
crossed admission, expiry/revocation, immutable terminal epochs, replay after disconnect,
reconnect with a fresh code and rollback/cutover guards. Browser checks use local
API fixtures with real Chromium WebAuthn for management, QR rendering and fragment-only
login continuity; they do not claim public-network or cross-provider proof.
