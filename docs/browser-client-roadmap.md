# Browser Client And Product Roadmap

Status: Product direction and planning record, October 24, 2026. This document
does not amend protocol specifications, approve gated security work, or authorize
production changes. Proposed mechanisms below require separate design and review.

## Implementation Checkpoint — Messaging Screens And Consistent Sign-In

The next local slice extends the teal design to Compose, received/sent readers,
Sent, Allowed Senders and Security. Shared controls and semantic status colors
replace their old green styles; optional composer image fields are grouped, and
technical message IDs are available without dominating the reader. Security
distinguishes passkeys from owner recovery and retains fresh-verification and
current/last-passkey safeguards.

Signed-out behavior is now deliberate:

- The public homepage shows a focused welcome/sign-in experience, not private
  folders or a compose action. Authentication and signup also use the focused shell.
- All private screen links lead to the same passkey sign-in, then return to the
  requested screen and query. This includes client-side data loads and sessions
  that have expired, rather than mixing placeholders, inline login and redirects.
- Return paths are restricted to local inbox screens, excluding external URLs,
  authentication/enrollment routes and signup. No form action is replayed by login.
- Sender QR address/DID fragments survive document redirects and login, remaining
  browser-local. Public-shell and displayed sender-QR links use document navigation;
  opening or signing in through a QR still does not review or approve permission.
- Navigation visibility uses only a session-presence hint; account loaders still
  validate the provider session and clear expired cookies. Rendered pages are
  non-cacheable. Messaging pages retain a same-origin referrer policy so native
  POSTs continue to satisfy the framework's CSRF protection; sensitive pages retain
  their stricter policies.

Local verification: production build, Svelte typecheck, 25 unit tests, desktop and
mobile-width Chromium flows through the real GUI proxy, plus screenshot review.
The browser checks include anonymous document/data redirects for all private route
families, actual passkey login/return, expired-session QR continuity, native replies,
permission approval/revocation, composer formatting and security verification.
These remain local fixtures, not production or real-device validation.

Signup/recovery presentation and final brand artwork remain future work. No new
component dependency, relationship/reply protocol change or deployment was added.

## Earlier Checkpoint — Shell And Feed

The first local implementation slice evolves `apps/gui-poc` in place:

- Responsive Haili navigation, active-route indication, keyboard skip link and a
  focused shell for authentication/signup, retaining the existing CSP reload boundary.
- Teal semantic color tokens, shared native control/button styles, reduced-motion
  support and a provisional lettermark/favicon (not final logo designs).
- Redesigned signed-out, empty and populated feeds; technical account details are
  collapsed, while passkey settings, sender review and pagination remain accessible.
- Bundled images and the browser-local header preference are preserved. Preference
  controls wait for initialization and remain usable when storage is blocked.

Local verification: production build, Svelte typecheck (no errors/warnings), 23 unit
tests and Chromium browser checks at desktop and mobile viewport sizes. Browser
checks exercise signup, native one-time replies, sender approval/revocation,
navigation, keyboard skip, bundled feed headers, preference persistence and paging.
These are local API fixtures, not production federation or real-phone validation.

The subsequent messaging-screen slice above covers composing, reading, Sent,
sender permissions and security. No shadcn dependency or Preflight reset was
needed for this first slice. No relationship/reply protocol changes, package
renames, infrastructure changes or production deployment were performed.

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
updates. Preserve existing subscriptions when introducing connections.

### Connect: People

A connection must be an explicit relationship, not something inferred from the
existence of two directional Grants. Two people can subscribe to one another
without being connected; subscriptions and connections must be able to coexist.
Creating or removing a connection must not silently create, broaden or remove
subscription consent.

The protocol representation is undecided. In particular, reusing two ordinary
Grants is not an agreed design. The current specification permits direct personal
Grants using `uncategorized` scope, but that is not a definition of connection
state. See [Grant scope boundaries](../spec/grants.md#scope-boundaries).

One possibility to discuss is requiring categorized subscriptions between
non-organizations and reserving uncategorized authorization for connections.
This is a proposal, not a new restriction on existing Grants. Evaluate compatibility,
relationship lifecycle, consent and independent revocation before choosing it.

Connection invitations must not become an unsolicited-message bypass. Invitation
delivery, acceptance, blocking, withdrawal and disconnection semantics need design.

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

A business may run a provider serving only its organizational domain. A general
provider such as Haili may eventually support open signup. These may be the same
server with different domain and enrollment policies: invite-only membership versus
public registration. Decide later; do not assume separate server implementations.
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
Detailed forwarding policy, including whether it needs additional recipient opt-in,
remains open.

## Browser Client Milestone

Evolve `apps/gui-poc` into the maintained browser client rather than rewriting
working authentication, signup, recovery-kit verification or messaging flows.
Avoid maintaining parallel old/new clients. Preserve server actions, protocol
handling and existing tests where possible; do not combine the visual migration
with an authentication redesign.

Initial acceptance target:

> An invited user can join, approve a sender, exchange messages, understand
> delivery outcomes and find account-safety guidance comfortably on desktop and
> mobile, with no regression in existing functionality or security boundaries.

Design for these candidate views together:

- **Feed:** subscription updates, rich cards and category controls.
- **Conversations:** personal correspondence and business reply threads.
- **Subscriptions and connections:** distinct relationship types and actions.

These are product views, not a requirement for separate clients or storage models.
Designing a future connection screen does not authorize implementing unresolved
connection semantics during the visual migration.

Use shadcn-svelte selectively for controls the actual screens need. Svelte 5 and
Tailwind 4 are already present. The current app intentionally omits Tailwind
Preflight, so introducing a new styling baseline requires checking existing forms,
rich text and security-sensitive routes, not simply adding components.

Preserve safe rich-message rendering, bundled-image privacy and document-scoped
signup/recovery CSP behavior. Visual polish does not close broader signup,
recovery, browser-compatibility or operational launch gates.

## Visual Identity

Preferred direction: calm, private correspondence with a distinctive **teal**
accent, warm neutral surfaces, deep ink text and comfortable reading typography.
The current green is not preferred; alternative greens may be evaluated but are
not the default direction.

Starting palette for screen studies, not a contrast-certified final theme:

| Role | Candidate |
| --- | --- |
| Background | Warm porcelain `#F7F8F5` |
| Surface | White `#FFFFFF` |
| Primary text | Deep ink `#172B2D` |
| Primary action | Deep teal `#0F766E` |
| Accent surface | Pale teal `#E6F4F1` |
| Borders | Quiet gray `#DCE5E3` |

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
| Browser redesign | Next focused milestone: shared shell, controls, layout and coherent existing workflows, migrated incrementally. |
| Hail and Haili logos | Establish the related identity system alongside the redesign. |
| Personal connections | First relationship expansion after resolving explicit connection semantics and their independence from subscriptions. |
| Subscription sharing and forwarding | Early growth/correspondence features, but only after recipient-consent and anti-spam rules are settled. |
| Multiple time-bound replies | Early protocol improvement, separately specified and verified from the visual redesign. |
| More Safe Portable Text | Select concrete publisher needs; retain safe rendering and accessibility rather than adding formatting indiscriminately. |
| File attachments | Follow content work, or prioritize for a committed pilot. Specify integrity binding, authorized retrieval, limits, retention and safe download behavior; never render arbitrary uploads in the trusted application origin. |
| Organization connections | Follow with a business pilot; design delegated authority and membership lifecycle first. Not a prerequisite for corporate subscriptions. |
| Provider admin dashboard | Add incrementally for recurring operator tasks. Include user/reserved-account management as needed, with separate audited admin authorization; link existing infrastructure monitoring instead of recreating it. |
| Search and discovery | Low priority. Search existing subscriptions/connections first; opt-in public discovery later, with visibility, enumeration, impersonation and moderation rules. Do not expose private relationship graphs. |
| CLI/server npm publication | Revisit when ready to publish. Moving TypeScript apps into `packages/` is optional, not an npm requirement. Decide packaging and repository layout together only when needed. |
| API subdomain | Keep `/api` absent a concrete reason to change. A separate browser API origin adds cookie/CORS/deployment considerations. If separation becomes useful, prefer descriptive `api.` over `svr.`. |

## Existing Evidence And Follow-Up

- [Browser permissions](browser-permissions.md): current directional consent and
  passkey-confirmed Grant approval.
- [Public authentication](public-authentication.md): browser signup, pilot and
  remaining approval gates.
- [Passkey authentication](passkey-authentication.md): platform and security checks.
- [Haili launch](haili-launch.md): operational evidence, including external email
  forwarding for `ops@haili.app` and `abuse@haili.app`.
- [Haili operations](haili-operations.md): operational responsibility and response.
- [Public monitor deployment](../apps/plc-monitor/deploy/public/README.md): existing
  authenticated enrollment and network-boundary documentation; audit the live state
  before claiming protection is missing or complete.

Next planning step: scope the browser presentation milestone against current
routes and tests. Resolve connection, sharing, organization and multi-reply protocol
questions in dedicated designs before implementing their authorization behavior.
