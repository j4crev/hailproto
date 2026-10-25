# Subscriptions, Connections And Publishing

Status: Approved product direction; staged implementation. Stages 1–2 deployed
to `haili.app` on October 25, 2026 UTC; see [deployment evidence](haili-launch.md).
Future connection authorization, reply changes and attachments are not live.

## Agreed Product Model

- **Publish an update:** choose General or a custom category, not individual
  subscribers. Send to all currently authorized subscribers for that category.
- **Send a message:** select one or more explicit connections.
- **General** is the GUI label; `general` is the category ID. It is not a wildcard
  and does not authorize future custom categories.
- Subscriptions and connections coexist independently. Neither implies the other;
  reciprocal subscriptions are not a connection. Unsubscribe and disconnect must
  remain separate, with an explicit block-all action when needed.
- Later campaign groups may narrow an authorized category audience, never grant
  permission. Recipient-specific billing/renewal automation requires separately
  authorized transactional delivery; calling something "system" grants no authority.
- Receivers classify messages from verified authorization, not an unauthenticated
  sender-chosen correspondence label. A receiver cannot prove that every other
  subscriber received a publication or infer the semantic intent of arbitrary text.

## Stage 1 — Named Subscription Categories (Implemented)

The operator chose a simpler controlled-alpha transition: no special migration
command or conversion UI. General is an ordinary offered category:
`{id: "general", label: "General"}`. Publishers use the existing profile create/update
commands. Subscribers choose it in the browser or use `--category general` with
the existing Grant create/update commands.

CLI Grant creation and updates require named categories; `--uncategorized` is
removed. The shared provider Grant service rejects new uncategorized permissions,
including directly signed initial Grants and updates submitted through the API.
The browser does not expose an uncategorized subscription choice. General still
requires a current signed category offer and explicit recipient approval.

Historical wire decoding, exact retained retries and revocation are preserved;
they are not permission to create a new uncategorized subscription. No connection
is inferred from an old uncategorized Grant. This change needs no SQL migration.

### Read-Only Inventory And Cleanup Boundary

The two accessible Haili account inventories contained 13 account-scoped current
Grant records and zero uncategorized records. Other saved credentials returned
401 and were not renewed or escalated. This is not a provider-wide database audit:
the installed restricted operations wrapper does not expose arbitrary SQL.

No database was wiped. New-subscription enforcement does not require destroying
existing signed history, delivery evidence or foreign-key dependencies. A provider
operator can run this aggregate-only audit in an authorized database console:

```sql
BEGIN READ ONLY;
SELECT lineage.local_role, lineage.current_status, count(*) AS grants
FROM grant_lineages lineage
JOIN grant_revisions revision ON revision.grant_id = lineage.grant_id
  AND revision.revision = lineage.current_revision
WHERE (CASE WHEN jsonb_typeof(revision.scope_payload)='string'
  THEN (revision.scope_payload#>>'{}')::jsonb ELSE revision.scope_payload END)->0->>'type' = 'uncategorized'
GROUP BY lineage.local_role, lineage.current_status;
ROLLBACK;
```

If additional legacy Grants exist, inspect their delivery dependencies before any
cleanup; ordinary revocation remains available. Do not truncate unrelated tables
or erase account/recovery state merely to remove a subscription option.

## Stage 2 — Category Publishing (Implemented)

The browser now chooses a category, with General defaulted when available, rather
than subscription recipients. The provider stores an immutable audience snapshot
and stable per-recipient message IDs, resumes partial fan-out, and exposes work
and delivery outcomes separately. New subscribers do not join an exact retry.
Recipient authorization is still checked by normal envelope creation/acceptance.

Migration 61 guards transfer fencing/generation advances while targets are pending;
finish or cancel the work first. Initial limits are 100 subscribers and five open
publications per account. See [the API, worker, proof and rollback boundaries](category-publishing.md).

## Stage 3 — Explicit Connections

Invitation UX is now decided: QR/link sharing only, no unsolicited request folder.
A user has a permanent personal QR with no automatic expiry on Security (eventually
My Account), plus optional expiring sharing codes. The scanner reviews/confirms;
a valid code's creator needs no second approval. Expiry stops new admission, not
established relationships. Sharing a public QR must clearly disclose that any
authenticated holder may connect; replacement/revocation and blocking need controls.

The wire foundation and an opt-in same-provider managed-account preview now implement
code management on Security, identity-pinned scan/confirm, crossed-review convergence
and disconnect tombstones. See [draft connection consent](../spec/connection-auth.md).
Preview enabled on Haili by operator approval: direct delivery, explicit blocking, owner-held
signing, cross-provider admission and portable export remain unfinished. Retained
preview consent blocks provider/custody transitions rather than losing that history.

The current one-active-subscription-Grant-per-directional-pair rule must not be
reused to collapse connection permission into a subscription. The draft separates
connection-specific signed consent and permissions into distinct object families;
the future store must allow independent relationship lifecycles. Do not encode
connection state as a category or infer it from reciprocal subscription Grants.

Crossed invitations for the same DID pair and compatible mutual-consent terms
must converge on one connection. Deduplicate on a canonical pair internally, bind
consent to explicit invitation attempts/terms and expiry, and verify both parties'
authority before showing Connected. No global cross-provider transaction is
assumed. Old/retried invitations cannot reactivate a disconnected or blocked
relationship; reconnecting needs fresh consent. Incompatible terms require review.

Organization creators become admins and may establish organization relationships,
but domain proof, delegated membership, departures and individual blocking need
their own design. Organization-to-person relationships (such as consultants) stay
in scope for design. Corporate subscriptions do not depend on this implementation.

## Later Verified Slices

- Multiple replies within a fixed, explicitly authorized conversation window,
  with distinct IDs, idempotency, abuse controls and version negotiation. Do not
  reinterpret existing single-use capabilities or renew expiry implicitly.
- Attachments: PDF, TXT and LOG initially, download-only and untrusted. Proposed
  baseline: 25 MiB aggregate file content (26,214,400 bytes) per message for
  attachment-capable providers, with advertised higher operator limits and
  recipient/account restrictions. Authorization, digest binding, quotas, retention
  and rejection-before-upload need implementation. DOCX/XLSX follow separately;
  macro-enabled formats are not implicitly included.
- Subscription recommendations require recipient opt-in even between connections.
  Forwarding must retain honest attribution and never transfer Grants or reply
  capabilities. Neither is enabled by the connection handshake alone.
- Publisher pilot: a retailer with receipts/order updates/offers, and an independent
  newsletter or community organization using General. The operator will contribute
  further publisher suggestions. No wider enrollment is implied by this plan.
