# Browser product roadmap

Current client behavior is documented in the [client README](../apps/client/README.md).
This page tracks unresolved product decisions; it does not change protocol requirements.

## Product Direction

Hail is primarily a B2C subscription feed: consumers explicitly subscribe to
business updates such as retail sales, alerts and marketing. It should also
support C2C and B2B correspondence without becoming an unrestricted email inbox.

The intended use cases are:

1. Consumers subscribe to businesses and selected message categories.
2. Consumers forward subscription messages or share subscription recommendations
   with friends and family, subject to recipient permission.
3. Organizations establish relationships permitting communication between their
   members, with explicit administrative authority and membership rules.
4. Consumers explicitly connect for correspondence, independently of subscriptions.

Corporate subscription senders do not require organization-to-organization trust.
Recruiting business publishers should not wait for the full B2B correspondence
model. Organization features can follow the initial browser milestone, but remain
important to adoption rather than an indefinite deferral.

## Relationship Concepts And Open Design

### Subscribe

A subscription is directional, normally category-oriented consent to receive
updates. Connections and subscriptions coexist independently.

### Connect: People

Explicit QR/link connections, owner-controlled signing, federation, messaging and
supported history transfers are implemented. Subscriptions remain independent.
Persistent block/unblock controls and interoperability with unrelated operators
remain follow-up work. See [connection messaging](connection-messaging.md).

### Connect: Organizations

"Connect" is a candidate user-facing term for both personal and organizational
relationships; it does not require identical underlying authorization mechanisms.

Intended organizational behavior and considerations:

- The organization creator automatically receives an organization admin role.
- Organization admins can establish organizational connections.
- Prospective organizations should likely prove control of a custom domain using
  a DNS TXT challenge. The verification procedure is not yet specified.
- Domain control proves control of that domain, not real-world legitimacy or
  authority over arbitrary member identities.
- Membership, delegation, departures, compromised admins and domain-control loss
  require explicit authorization and revocation rules.
- Decide whether organization-wide permission can be restricted or overridden by
  individual members, including blocking and abuse handling.
- Organization-to-person connections remain open: a consultant may need to
  correspond with multiple members without belonging to another organization.

The current spec anticipates organization DIDs and separately verifiable delegation,
not authorization based merely on an address suffix. No domain-wide trust mechanism
is implemented or approved by this roadmap.

A business may run a provider serving only its organizational domain. The reference
provider already supports invitation-only or public registration on its served domain.
Organization membership and custom-domain policies remain separate design decisions.
Organization admin authority and provider operator authority are distinct roles.

### Reply

A reply is permission to continue a particular conversation, not a subscription
or standing connection.

Replace the one-message product limitation with support for multiple replies
within an explicitly authorized time window. A consumer should be able to send
forgotten information without waiting for a business to respond first.

Proposed properties for review:

- Bind permission to the participants and conversation.
- Keep a fixed expiry unless the recipient explicitly authorizes an extension.
- Retain recipient abuse controls and rate/size limits; multiple replies does not
  mean unlimited throughput or storage.
- Preserve distinct message IDs and idempotent retries.
- Define blocking/revocation, delivery-state and provider-transfer behavior.
- Specify version/capability negotiation rather than silently changing old semantics.

The existing [envelope specification](../spec/envelopes.md#reply-permission) has
single-use claims tied to acceptance and terminal delivery state. This change
requires protocol and server work, not just removal of a browser restriction.

### Forward And Share

Distinguish two actions:

- **Share this subscription:** recommend a publisher/profile and categories; the
  recipient separately chooses whether to subscribe.
- **Forward this message:** send a copy of content under appropriate permission
  to contact the recipient.

Being connected must not automatically authorize subscription recommendations.
The recipient should explicitly opt in to receiving those recommendations from
connections. The scope of that opt-in, defaults and enforcement remain to be
designed; recommendations must not become a new spam channel.

Neither action transfers Grants or subscribes someone without consent. Forwarded
content must distinguish the forwarder from the original publisher, must not
inherit reply capabilities, and must not falsely imply verified publisher authorship.
Forwarding received messages to selected connections is implemented with literal
attribution and normal message limits. Subscription recommendations and their
recipient opt-in remain unimplemented. Threaded replies are implemented; allowing
multiple replies under one subscription capability remains a separate protocol change.

## Visual Identity

Preferred direction: calm, private correspondence with a distinctive **teal**
accent, warm neutral surfaces, deep ink text and comfortable reading typography.
The client uses teal semantic tokens; final related Hail and Haili branding remains open.

Keep final brand artwork separate from implemented color tokens and controls.

Use semantic tokens instead of repeated hard-coded colors. Validate contrast,
focus states and mobile layouts on real feed, compose and permission screens.
Delivery, warning and security states need labels/icons as well as distinct colors.

Create related but distinguishable Hail (protocol) and Haili (service) identities.
Start with usable wordmarks and favicons; elaborate logo work need not block the
client milestone.

## Backlog And Suggested Sequence

Separate operational/safety gates, everyday browser needs and later capabilities.
Existing operational and security gates retain their priority; this sequence is
not permission to bypass them.

| Work | Suggested timing and boundary |
| --- | --- |
| Ops and abuse identities | Verify reserved Hail identities and ownership now. Existing external email routing is not equivalent to Hail accounts. Preserve an external reporting channel accessible without a Hail Grant. |
| Monitor protection | Audit deployed access controls now before adding new controls. Protect enrollment/admin operations with approved provider credentials, quotas and revocation; distinguish those operations from any intentionally public evidence/read endpoints. |
| Hail and Haili logos | Establish the related identity system alongside the redesign. |
| Subscription recommendations | Define recipient opt-in and anti-spam rules; message forwarding already exists. |
| Multiple time-bound replies | Early protocol improvement, separately specified and verified from the visual redesign. |
| More Safe Portable Text | Select concrete publisher needs; retain safe rendering and accessibility rather than adding formatting indiscriminately. |
| File attachments | Follow content work, or prioritize for a committed pilot. Specify integrity binding, authorized retrieval, limits, retention and safe download behavior; never render arbitrary uploads in the trusted application origin. |
| Organization connections | Follow with a business pilot; design delegated authority and membership lifecycle first. Not a prerequisite for corporate subscriptions. |
| Provider administration | Invitation, registration and statistics dashboards exist. Add further account-management operations only for recurring operator needs. |
| Search and discovery | Low priority. Search existing subscriptions/connections first; opt-in public discovery later, with visibility, enumeration, impersonation and moderation rules. Do not expose private relationship graphs. |
| CLI/server npm publication | Revisit when ready to publish. Moving TypeScript apps into `packages/` is optional, not an npm requirement. Decide packaging and repository layout together only when needed. |
| API subdomain | Keep `/api` absent a concrete reason to change. A separate browser API origin adds cookie/CORS/deployment considerations. If separation becomes useful, prefer descriptive `api.` over `svr.`. |

## Remaining validation

- Broader real-browser/mobile passkey and signup validation, including recovery.
- Email bounce/complaint handling and deliverability monitoring.
- Independent-provider interoperability and explicit supported-history cleanup instructions.
- Backup incident ownership, provider recovery drills and operational controls for each deployment.

See [public authentication](public-authentication.md), [passkeys](passkey-authentication.md)
and [provider operations](haili-operations.md) for the current boundaries.
