# Browser Allowed Senders

Managed accounts can use `/permissions` to review and approve who may send to
them. The recipient is the Grant's grantor; the potential sender is its grantee.
This is one-way permission, not reciprocal contact access or permission to send
as the recipient. Existing delivered messages are not removed by revocation.

Signed-out and expired-session visits now use the same passkey sign-in screen as
Sent, Compose and Security, then return to permission review. Sender QR address/DID
fragments remain in the browser through document redirects and login; displayed
QR links explicitly use document navigation. Signing in does not review, prepare
or approve the sender. The public homepage does not expose private folder navigation.

## Two Entry Paths, One Review

- Enter the sender's Hail address, then choose **Review sender**.
- Scan their sender QR using the phone's normal camera. It opens the same page
  with a public address and DID pin. Opening/scanning it does not issue a Grant,
  trigger a passkey prompt or accept an offered category.

The page resolves the address and signed Sender Profile through the existing
provider verifiers. The sender must have a current published profile. It shows
the address, DID, sender-chosen display name and offered categories. A profile
name is not proof of real-world identity. A QR whose DID no longer matches the
address is refused, rather than silently redirecting permission to its new owner.

The recipient selects offered categories, including **General** when available,
and a bounded expiry, then reviews the exact permission and confirms
with a passkey. The provider signs/publishes the managed Grant using the existing
service and durable publication queue. **Saved/durable** is not proof of delivery
to the sender. Allowed senders are listed with scopes, expiry and a revocation
review. Revocation needs its own exact-action passkey approval.

The QR contains `https://<this-provider>/permissions#sender=...&did=...`, with
public data only. This first UI uses its own provider's permission-review page;
it is not a provider-directory/deep-link standard. Typed addresses can resolve
other supported public providers. Camera capture inside the browser, existing-DID
signers, general-purpose permission expansion/editing are not part of this approval flow.
Profile photos and publishing categories have separate account editing surfaces.
Owner-controlled accounts retain their existing signer workflow.

## General Subscriptions

General is the ordinary category `general`, with label General in a publisher's
signed profile. It uses the existing review/approve flow—no special migration
command, conversion button or new session scope. New uncategorized permissions
are rejected by the browser approval API and shared Grant service, including
direct API authoring. Historical permissions remain readable and revocable.
See [the implementation and inventory boundary](subscriptions-and-connections.md).

## Authority And Retry Boundary

Normal passkey sessions still contain only `account:read`, `grants:read`,
`messages:read` and `messages:write`. Neither ordinary login nor this approval
issues a general `grants:write` capability, API token or replacement session.
Owner recovery material is never used by this feature.

`POST /api/v1/account/permissions/review` verifies public sender metadata.
`POST .../prepare` retains a five-minute intent bound to the current account,
serving generation and session. Immutable intent includes exact unsigned Grant
bytes, signing key, consent hashes, categories/expiry or the reviewed revocation
revision. The separate random WebAuthn challenge maps only to that intent.
`POST .../commit` requires a user-verified assertion from a current passkey of
that account. Normal login assertions and another approval's assertions cannot
be substituted. There is no caller-selected destination or scope at commit.

Current account, session, key, generation and migration-fence checks run again
on approval/commit. Existing Grant signing checks fresh PLC authority and consent.
Changed sender bindings/profiles or Grant revisions require review again; old
approvals cannot follow a reassigned address or revoke a newly edited revision.
Approval does not refresh login's credential-management freshness.

Retries use the same request ID and frozen payload. A provider-wide advisory lock
serializes this small pilot's approvals without starving the SQL pool during
network/signing work; higher volume needs a bounded worker pool. A retained result
is idempotent. After an ambiguous write,
the original active Grant or revocation is reconciled instead of allocating a
new Grant or revoking a later revision. Completed results can be read under the
same live session after expiry; unfinished approvals cannot be renewed. The tab
stores only the request ID in session storage, not an additional bearer secret.
**Check original approval status** can reconcile a lost response. If an approval
expires, inspect current permissions before beginning another review.

## Migration And Rollback

Migration 59 adds only provider-local `account_grant_approvals` and its immutable
intent/terminal-proof trigger. It does not rewrite old accounts, keys, Grants,
sessions or signup records. These local authentication/audit records are not
portable identity authority; serving-generation changes invalidate their use.
Existing full-database encrypted backups include the new table.

Older compatible code can run with the added table retained. Schema rollback
59 is allowed only while the table is empty and no later migration exists. Once
any approval is retained, use code rollback with the table intact; do not delete
consent records to force a destructive schema downgrade. No pruning is implemented
for this small pilot; a reviewed retention policy is needed before large volume.

## Unsubscribe from an Inbox message

Managed accounts can unsubscribe inside an opened subscription message. The
reader resolves the current active subscription by verified sender DID, including
later pages of the account's Grants, rather than using the message's display
address or assuming its historical authorization is still current. Connection
messages do not offer this action. Owner-controlled accounts retain their signer
workflow.

Unsubscribe opens an explicit review of the sender and all categories covered by
that subscription. The existing exact-action passkey approval and durable revoke
operation perform the change; opening or cancelling the review does not do so.
Retries and status checks retain the original request ID. A failed subscription
lookup leaves the message readable and reports that subscription status is
unavailable rather than claiming the user is unsubscribed.

The UI calls this **Unsubscribe** and **Unsubscribed**; wire actions/status remain
`revoke`/`revoked`. Delivered messages remain readable, and connections are
unchanged. Message deletion uses the separate
[Trash/deletion flow](../apps/client/README.md#trash-and-deletion). Multi-subscription
unsubscribe is available on the permissions screen; bulk Inbox unsubscribe remains
unimplemented.
