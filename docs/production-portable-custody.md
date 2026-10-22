# Production Portable Custody And Provider Cutover

Status: Architecture, trust model and private-POC boundary guide.
Use [`../apps/cli/docs/custody-transitions.md`](../apps/cli/docs/custody-transitions.md)
for current production gates. The protocol specifications in `../spec` remain
authoritative; a rule proposed here is not a federation requirement until its
corresponding specification is updated and reviewed.

## Authority And Key Custody

For the owner-controlled portable profile, the client generates and retains
the top PLC recovery key and `#hail-identity` signing key. The provider never
receives their private bytes, even encrypted under a provider-controlled key.
The user's independent encrypted backup and recovery-material check must
succeed before public activation. The source and destination providers each generate their **own**
lower-priority PLC rotation and `#hail-messaging` keys; neither provider
receives the other's private operational keys. The source's operational keys
are historical evidence, not usable destination signing keys.

An out-of-provider PLC monitor maintains a durable cursor, validates the full
log and aliases, detects an unexpected operation or coverage loss within 24
hours, and alerts the user out of band. A database field claiming that the
monitor or backup was confirmed is not independent proof: production
activation needs authenticated monitor evidence and a verified user recovery
check. The client-to-provider API and encrypted vault representation remain
local implementation details, but these outcomes are mandatory under
`spec/account-onboarding.md`.

The current owner-controlled TypeScript/Bun client is a **reference
implementation and test driver**, not a platform requirement. Mobile and other
clients may use their own OS-backed keys and recovery user experience while
producing the same signed objects under the selected custody profile's
authority and satisfying its provider-independent backup/recovery outcomes.
The approved managed-profile direction below intentionally assigns identity
signing to the provider while keeping top recovery authority with the owner;
it must not be described as the same consent-custody guarantee.

## Key Custody In Plain Language

Custody means **who can produce a signature**, not merely where a key file is
stored. With user-held keys, a user-controlled signer authorizes an exact
object and the provider verifies, stores, enforces and publishes it. With
provider custody, the provider holds signing authority and signs on the user's
behalf after authenticating an account request. AT Protocol's custody choices
do not require Hail to adopt provider custody for its consent-signing role.

| Key | Purpose | Owner-controlled portable profile | Preferred managed profile | Fully custodial POC |
| --- | --- | --- | --- | --- |
| `#hail-identity` | Grants, revocations and Address Bindings | Owner controls signing | Provider controls signing | Provider controls signing |
| Top PLC recovery key | DID recovery and reviewed sensitive identity changes | Owner controls signing | Owner controls signing | Provider controls signing |
| `#hail-messaging` | Envelopes, Sender Profiles and delivery statuses | Provider controls signing | Provider controls signing | Provider controls signing |
| Lower-priority PLC rotation key | Provider operational DID updates | Provider controls signing | Provider controls signing | Provider controls signing |

The portable model is therefore **split custody**, not a requirement for the
user device to perform every server operation. Original Alice/Bob POC accounts
are custodial; newer user-key-held POC identities exercise the split model.

| Consideration | User-held identity key | Provider-held identity key |
| --- | --- | --- |
| Convenience | A user-controlled signer must be available for fresh consent/identity signatures | Provider can sign while user devices are offline |
| Recovery | Requires usable independent backup and recovery | Provider can offer account-recovery processes, subject to its own security and availability |
| Provider compromise | Does not directly expose the user's identity key | May expose the key or let an attacker invoke its signer |
| Consent evidence | A signature requires the user-controlled signing authority | A valid signature could have been produced by the provider without the user's request |
| Portability | User retains signing/recovery authority outside the provider | Depends more heavily on provider cooperation |

Encryption at rest alone does not establish user custody:

- Provider-held ciphertext plus a provider-controlled decryption key is still
  provider custody.
- A provider-hosted encrypted backup can preserve user custody if only the
  user can decrypt it and an independently retained recoverable copy exists.
- A non-exportable key in a provider-operated hardware security module is
  still provider-controlled signing authority if the provider can invoke it.

Keeping `#hail-identity` out of the provider protects consent and identity
control; it does **not** provide message-content confidentiality. The POC is
not end-to-end encrypted, and providers see stored bodies and Grant
relationships. They can also refuse service. The provider's lower-priority
PLC key can make harmful DID updates, including key replacement, so independent
monitoring and timely recovery remain necessary for production protection
against provider impersonation. User-held identity keys alone do not remove
that PLC authority.

## Managed Profiles And People Or Agents

**Approved product direction:** offer both owner-controlled and opt-in managed
identity custody to **people and agents**. The preferred managed compromise
keeps the top PLC recovery key outside the Hail provider's control, while the
provider generates and protects the account's `#hail-identity`, messaging and
lower-priority rotation keys. Agent use does not force provider custody, and
human use does not prohibit it. No global default custody choice is established
by choosing an API-first server architecture.

An agent's owner/controller may be a person or organization. Owner-controlled
signing can be performed by that controller's continuously available service,
not necessarily by a human approving every signature. Each account still needs
an accountable control/recovery arrangement; an ephemeral model process is not
the only durable copy of its identity. Custody describes who controls the
signer, not whether the caller is a person using software or an automated agent.

Managed identity enables provider-side Grant authoring, signed revocation and
Address Binding renewal while the owner's signer is unavailable, subject to
authenticated requests or an explicitly approved account automation policy.
It does not by itself authorize scope expansion or arbitrary new account
actions. The owner must understand that the provider can produce valid consent
signatures without a fresh owner-held identity signature. Owner-held recovery
does not remove that power or provide message confidentiality.

The provider never requests/imports the owner's top recovery private key. The
owner signs reviewed full PLC onboarding and recovery/custody-change operations
with that authority, retains independent recovery material, and monitors PLC
outside the provider's administrative control before production activation.
An accepted lower-priority provider change can still become current and must
be detected/recovered within PLC's recovery window. Managed custody is not
threshold control, nor proof that every provider update needs owner approval.

Record/disclose identity and recovery custody separately in the account's
onboarding record and client presentation. A mode label is a declaration, not
cryptographic proof of physical key custody; providers must not relabel managed
identity as owner-controlled merely because the owner holds a recovery key.
Fully provider-held recovery remains the existing custodial POC profile, not
the preferred managed compromise selected here.

Both profiles use the same identity-signed Grant and Address Binding formats.
Managed revocation authenticates an account action and produces the terminal
identity-signed revision at the provider; owner-controlled revocation imports
the owner's signed revision. Neither is the rejected unsigned local-blocking
convenience. Revocation remains a signed terminal state transition in both.

Custody changes and managed-account moves must remove an old provider's current
signing authority through rotation while preserving predecessor Grants, bindings
and historical-key evidence. They cannot be implemented by changing a custody
flag or importing old provider private keys. The reviewed transition lifecycle,
return and abandonment rules live in
[`custody-transitions.md`](../apps/cli/docs/custody-transitions.md); the managed
profile and conformance requirements live in
[`managed-custody.md`](../spec/managed-custody.md).

## API-First Provider And CLI Clients

**Approved architecture:** the reference provider is API-driven by default.
Human applications, agent runtimes, provider-native CLIs and Hail-provided CLIs
interact directly with its authenticated account-management API. A normal
account operation must not require SSH access, a provider-local administrator
CLI, database credentials or direct database writes.

**CLI name:** `hailp` is the Hail-provided reference account CLI (`p` for
Protocol), avoiding the existing unrelated `hail` agent calling/text/email tool.

```text
human app / agent / native CLI / hailp
    -> authenticated account API
    -> account-bound authorization and custody-specific signing
    -> shared provider services, transactions and durable jobs
    -> existing Hail federation API
```

The account API authenticates the caller, binds actions to the correct account
and authorizes their permitted operations. Owner-controlled operations still
require the relevant signed user object; an API token does not replace an
identity signature. Managed operations may invoke only that account's
provider-held signer after authorization. Account authentication must not
silently change custody, replace top recovery authority or give one account
access to another account's signer/data. Neither profile exposes raw private
keys through ordinary management APIs.

Agents should request structured, policy-checked actions through their tools,
not receive raw private keys in model context. An owner-controlled agent's
trusted signer can validate its configured permissions before signing; a
managed agent's provider checks its account API permissions before signing.
Human and agent callers exercise the same account ownership and authorization
rules. A provider-native CLI and `hailp` are alternative API clients, not
distinct signing authorities or bypasses around server validation.

The reference account surface covers signup and onboarding, account/custody
status, credentials, Grants, messaging, delivery status, binding renewal and
transfer ceremonies. Endpoint paths and credential/session details are local
implementation choices. Business rules belong in shared provider services,
not duplicated in HTTP handlers or CLI commands; narrow operator tools remain
distinct from normal account clients.

This architecture does not force every Hail provider to implement identical
client API paths. Federation remains the interoperable protocol boundary;
the reference provider should expose a coherent documented client API, with
its CLIs as first-party examples. Cross-provider management-API standardization
is a separate decision, not implied by API-first operation.

Current commands and capability status belong in the
[`hailp` workflow guide](../apps/cli/docs/cli-workflows.md) and
[`hailp` roadmap](../apps/cli/docs/cli-roadmap.md), not in this architecture
document. API credentials remain provider-local and never enter portable
snapshots.

## Signed Revocation And Custody

```text
Custodial:
user request -> provider authenticates account -> provider signs revocation
             -> provider commits enforcement and queues sender notification

User-held:
user device signs exact revocation -> provider verifies user signature
             -> provider commits enforcement and queues sender notification
```

For owner-controlled accounts, the current implementation is **user-device-signed
revocation**, using the existing Grant representation and revision chain. The
old custodial authoring command is not a requirement to give a portable
account's identity key to a provider.
The client verifies the prior signed Grant and the reviewed relationship,
increments its revision, binds the exact predecessor digest, preserves its
parties/scope/expiration/consent and signs `status: revoked`. The current
provider verifies current identity authority and commits the terminal revision
with its publication job atomically. New acceptance stops at that commit;
previously accepted messages retain their delivery responsibility.

Revocation requires neither sender cooperation nor live sender address/profile
discovery. It can revoke an expired Grant. Provider availability and current
grantor-authority verification are still required to commit it. Signed retries
reuse exact bytes; stale or conflicting predecessors cannot overwrite the
chain. See [Grant revision and revocation rules](../spec/grants.md#revisions).

Other approaches discussed, but not selected for this implementation:

- A user-chosen external signer can remain available while personal devices
  are offline. It avoids Hail-provider custody but introduces another signing
  service's custody/trust and availability assumptions; it is not automatically
  equivalent to on-device self-custody.
- Pre-signed revocation revisions bind to one predecessor and can become
  unusable after a Grant update or identity-key rotation. They are not the
  default renewal/revocation mechanism.
- Revocation-only delegation could restrict a delegate to stopping permission,
  without creating or expanding it, but would require new protocol and
  verification rules. Current v0 requires the identity signature.

Account-login-only blocking is not Grant revocation. User-facing revocation
remains signature-based in both custody profiles; managed signing is not
unsigned local blocking.

## Offline Operation And Signing Requirements

This table describes **owner-controlled identity custody**. For the preferred
managed profile, the provider can supply identity signatures for authorized
Grant changes and binding renewal while the owner's signer is unavailable;
owner-recovery operations still need owner authority. That convenience comes
with provider-controlled consent signing, not the portable profile's guarantee.

User-held keys do not require a person or browser to remain online for routine
messaging. Providers execute already authorized work with their own operational
keys and retain durable retry responsibility. Fresh consent or identity
decisions require a user-controlled signer. The table assumes **all** such
signers are unavailable; an online independent signer is a separate trust
choice, not permission to fall back to provider custody.

| Operation | Can continue without a user-controlled signer? | Authority / condition |
| --- | --- | --- |
| Receive messages under an existing Grant | Yes | Existing permission remains valid, unexpired and unrevoked |
| Deliver accepted or queued work and report status | Yes | Provider operational keys; existing authorization and signed deadlines still apply |
| Send authorized messages or invited replies | Yes | Provider `#hail-messaging`; account/application authorization and the peer's Grant or reply capability are still required |
| Publish/update a Sender Profile | Yes, cryptographically | Provider messaging signature; new offered categories do not expand anyone's Grants |
| Retry publication of signed Grants/revocations | Yes | Retained exact signed bytes; no fresh consent is manufactured |
| Monitor PLC changes and deliver/queue alerts | Yes | Monitor's own signing key and durable state; alert delivery depends on its receiver/network, and recovery still needs user recovery authority |
| Enforce Grant expiration | Yes | Existing signed constraint; the provider cannot extend it silently |
| Create a Grant, expand scope or renew expiration | No | Fresh user identity-signed revision |
| Create a signed revocation | No | User identity signature; enforcement and notification continue without the signer after commit |
| Renew an Address Binding | No | Fresh identity signature |
| Initiate/approve transfer or identity recovery | No | Reviewed user signatures; backend execution/retries may continue after all required exact artifacts are durably submitted |

This classifies required signing authority, not a claim that every scheduling,
profile-editing or key-management user interface is implemented. Offline
operation never authorizes new arbitrary account actions. Transfer availability
must also be considered before fencing: an initial Transfer Grant does not
replace the later review/signature of the exact snapshot and PLC cutover.

### Convenient signing without provider custody

The day-to-day identity key can be protected by a user-device keystore, with
device unlock or biometric approval rather than repeated raw-key handling.
The PLC recovery key is separate offline authority. A passkey may authenticate
the user or unlock vault material, but a WebAuthn credential must not be assumed
to produce Hail's arbitrary raw Ed25519 signatures. The reference client keeps
routine identity signing separate from full recovery-key unlocking; platform
keystore integration is described in
[`device-keystore.md`](../apps/cli/docs/device-keystore.md).

### Grant lifetime and offline subscriptions

Grant lifetimes are product policy, not a protocol-wide default. Ongoing
subscriptions may use `expires_at: null`, subject to recipient policy, and
continue without periodic signatures until revoked. Transactional permissions can deliberately
expire. An expiring Grant cannot be renewed silently by a user-held-key
provider; a higher signed revision is needed. Product lifetime defaults and
renewal UX must be chosen explicitly. See [Grant expiration](../spec/grants.md#expiration).

## Address Binding Expiration And Renewal

An Address Binding combines two assertions:

1. The address domain selects the address-to-DID mapping through current
   WebFinger publication.
2. The DID owner authorizes that association with an identity signature.

Live domain publication can change, but a signature does not become invalid
merely because the user left a provider. Expiration limits reuse of the
existing signed consent. For example, after moving from
`alice@old-provider.example` to another provider while retaining the same DID
and identity key, an uncooperative old domain could keep publishing the
original signed binding. Its expiration bounds that claim; the old provider
cannot extend the signed date without fresh signing authority. Expiration
does not give the user ownership of the old provider's namespace.

Live WebFinger verification and caching solve a different problem. The
current rules check domain publication and current DID identity authority and
cache successful discovery for at most one hour, further bounded by signature
expiration and HTTP freshness. That handles honest withdrawal/reassignment.
Signature expiration additionally bounds a domain that keeps publishing old,
otherwise-valid signed evidence. It is not a complete defense against an
actively compromised domain or identity key: possession of the private
identity key can permit new signatures until that authority is removed.

**The 90-day maximum is a Hail policy limit, not a cryptographic necessity.**
The POC signs bindings for that maximum lifetime. It balances stale-consent
exposure against renewal friction; the current specification still requires
bounded expiration. This planning discussion does not change that rule.

| Policy considered | Tradeoff | Current decision |
| --- | --- | --- |
| Bounded expiration | Simple verification; periodic user-controlled signing required | Retain the current rule and document renewal as a product requirement |
| Longer lifetime | Less renewal friction; longer reuse of old signed associations | Possible future policy review, not implemented/spec-changed here |
| Explicit revocation/current-consent state instead of expiration | Could avoid periodic renewal, but needs trustworthy discovery even when the old domain is uncooperative | New mechanism is not specified; do not treat live WebFinger alone as its replacement |

A usable production account therefore needs user-signed binding renewal,
advance expiry reminders and safe publication/retry handling. The provider
cannot edit an existing signature's expiration. The reference CLI implements
identity-only same-association renewal; any background signing policy still
needs explicit design and must not silently delegate identity custody to the
Hail provider.

An expired binding makes the **address association unverified**. It does not
expire the DID, revoke existing Grants, delete messages or transfer relationships
to a new address holder. Established delivery is DID-based and does not
re-resolve a human-readable address for every message. Address discovery and
new consent still need valid address evidence. See the
[binding lifetime](../spec/address-binding.md#binding-payload),
[cache](../spec/address-binding.md#caching) and
[delivery](../spec/address-binding.md#grant-and-delivery-behavior) rules.

## Portable Transfer Ceremony

### At A Glance

This diagram depicts the user-initiated portable transfer profile. The
user authorizes one destination before either provider can fence this DID.
"Frozen" applies to this one DID, not every account at either provider.

```mermaid
sequenceDiagram
    actor User as User-controlled client
    participant Old as Old provider
    participant New as New provider
    participant PLC as Public PLC registry
    participant Witnesses as User monitor and independent PLC reads

    User-->>Old: Sign one-time Transfer Grant for destination domain
    Old->>Old: Validate and store user-signed grant
    Old->>New: POST grant + invitation to domain's fixed well-known HTTPS endpoint
    New->>New: Independently validate both signatures
    New-->>Old: Signed inactive Transfer Offer in HTTPS response
    Old->>Old: Persist destination-origin proof of offered key
    User->>New: Direct user-key-signed Address Selection for username@domain
    New->>New: Match grant + Offer; atomically reserve address
    New-->>User: Signed reservation receipt (not yet public)
    New->>Old: Push final signed Transfer Request + user selection + receipt
    Old->>Old: Fence this DID, stop its writers and workers
    Old-->>New: 204 only after exact validation and committed fence
    Old-->>New: Provider-signed state snapshot (no private keys)
    User-->>New: Review snapshot + keys; sign final consent, binding and exact PLC update
    New->>New: Validate and stage import INACTIVE
    New->>PLC: Submit exact user-signed PLC update
    PLC-->>Witnesses: New service and messaging key appear
    Witnesses-->>New: Confirm exact top-user-signed operation is current and non-nullified

    New->>New: Verify user-domain WebFinger and binding, import and activate atomically
    New-->>Old: Signed activation receipt
    Old->>Old: Permanently retired and fenced
```

| Stage for this DID | Old provider | New provider | New messages for this DID |
| --- | --- | --- | --- |
| User grant, Offer, direct address selection | Active | Keys prepared and address reserved, inactive | Normal sending and receiving continue. |
| Final signed push, fence and snapshot | Frozen **only after** request and reservation validation | Verified import staged, inactive | New sends and envelope acceptance pause. Existing accepted work and deadlines remain durable. |
| PLC update and independent verification | Frozen | Inactive until the exact current operation is verified | No new acceptance or signing. Peers may retry an indeterminate submission; `202` is not acceptance. No blanket 72-hour wait for the user's top-key signature. |
| Verified activation | Permanently fenced/retired | Sole active provider | New operations resume at the DID's authenticated new service. Accepted work that expired meanwhile follows terminal failure rules. |

**Does the spec require 72 hours of downtime? No.** The PLC recovery window
protects a higher-priority key from a *lower-priority* key's operation. Here
the user signs the exact cutover with the current **highest-priority** recovery
key. After independent observation of that exact current non-nullified
operation and checks that the snapshot has only one owner, the target can
activate without waiting 72 hours. The DID-specific pause begins when the old
provider fences it and ends on verified activation; delays or conflicting PLC
observations can extend it, but 72 hours is not the target. A lower-priority
provider-signed operation cannot initiate this migration or use this fast
path. This does not prevent a provider key from making an unauthorized PLC
change: the independent monitor still detects such changes so the user can
recover during PLC's 72-hour window.

The initial **Transfer Grant** is a dedicated user-signed transfer
authorization naming only a provider **domain**, not a normal Hail
message-delivery Grant, manually entered URL, or preselected username. The
old provider validates and stores it, then sends a signed invitation with
no account state to the domain's fixed HTTPS endpoint. The new provider
returns an inactive **Transfer Offer**; the old provider records that this
exact offered key was observed at the authenticated destination origin. The
client then talks directly to the new provider, signs an **Address Selection**
for one full address beneath that domain, and receives a signed receipt for
its local reservation. This is the same process whether the domain's Hail
server is self-hosted or operated by a third party. The new provider pushes
the **final Transfer Request** signed by the *same* offered key, binding the
user selection and reservation receipt. Only then does the old provider
consume the user grant and fence. The user later reviews the actual snapshot
and keys and signs final consent and the exact PLC update.
The fixed-path transport and bounded representation are defined by the reference
profile in
[`http-binding.md`](../spec/http-binding.md#provider-transfer-invitation-transport);
the specifications remain authoritative over this explanatory sequence.

1. The user chooses the new provider's canonical DNS domain in their
   client, which derives its service base and signs a short-lived Transfer Grant with their
   `#hail-identity` key, and registers it with the current provider. The
   current provider remains active and may not start a transfer on its own.
2. The source verifies and stores the user grant and signs a Transfer
   Invitation to the destination, containing or referencing that exact grant,
   with no snapshot or other account data. It delivers the invitation and
   grant by fixed-path well-known HTTPS POST to the named new provider, with DNS pinning,
   certificate validation and no redirects. The target independently validates
   both signatures before proceeding.
3. The destination generates and durably encrypts its own provider PLC
   rotation and messaging keys under its own encryption key. It gives the
   public `did:key` values, transfer ID, and final HTTPS Hail service base to
   the user-controlled client. The target proves possession of both private
   operational keys; its import slot cannot serve the DID yet. It returns a
   signed inactive **Offer** in the authenticated HTTPS response, carrying its
   prepared keys, service base, transfer ID and invitation challenge. The
   source persists that Offer's destination-origin proof, but remains active.
4. The client connects directly to the new provider server, signs its exact
   chosen `username@provider-domain` with its current `#hail-identity` key,
   and binds the grant, Offer and transfer ID. The new server checks current
   PLC identity authority and reserves the address in the same local account
   namespace as ordinary onboarding, returning a signed, expiring reservation
   receipt. Unavailable names are not replaced without a fresh user signature;
   an exact retry returns the same receipt. WebFinger is **not** published yet.
5. The destination signs and pushes a final Transfer Request to the old
   provider, binding that same Offer, user selection and reservation receipt.
   The old provider verifies same-key continuity, source challenge, exact
   address domain, current user identity signature, expiry and one-time use.
   Only after the exclusive fence commits does it acknowledge the request;
   exact retries are idempotent, including after an ambiguous response.
6. The source checks the validated current PLC log: the user recovery key is
   first in the ordered rotation keys, the provider key has lower priority,
   the identity key is the user's public key, and the source service and
   messaging key are current. It atomically consumes the verified user
   authorization and commits an exclusive DID fence. Every local
   writer shares the account-row serialization point, including Grants,
   replay, reply claims, deliveries, and status publication. Workers skip
   fenced work rather than taking new leases.
7. The source exports a complete, immutable snapshot of the DID's state. It
   signs a domain-separated digest using its **current provider messaging
   key**, recording validated PLC evidence. The export contains public key
   metadata and the exact signed protocol records, body bytes and
   authorizations needed for continuation. It contains **no private user or
   provider key bytes or provider KEK-wrapped ciphertext**. Transfer occurs
   over an authenticated, private administrative channel.
8. The user-controlled client validates the snapshot digest and destination
   keys/service, then signs domain-separated migration consent with its
   `#hail-identity` key. That consent binds the DID, transfer ID, exact
   snapshot digest, source and destination service bases, user recovery and
   identity public keys, both destination provider public keys, and SHA-256
   of the **exact reviewed signed PLC operation's DAG-CBOR bytes**. The
   consent also binds a user-controlled **destination Hail address**. The
   client signs a fresh Address Binding for that address using its identity
   key, and the address-domain operator publishes the exact binding and
   WebFinger selection independently of the departing provider. The provider
   receives only payload and signature bytes, never a user private key.
   Independently, the user reviews and signs the **exact full-state PLC
   update** with the top recovery key. This unusual use of the offline key is
   a deliberate, high-stakes provider-transfer ceremony, not routine Grant
   signing. The full update preserves all unrelated keys, services, and
   non-Hail aliases in their original order; it changes only the reviewed
   Hail service, messaging key, and provider rotation key.
9. The destination verifies the source's PLC-authorized operational signature,
   the user's current identity signature, the exact manifest digest, complete
   references and signed bytes, and the reviewed PLC operation. It requires
   the operation's predecessor to equal the current valid CID, verifies its
   signature against the user-held top recovery key, and rejects unapproved
   alias, key, or service changes. It durably
   stages the state **inactive** and acknowledges the exact transfer ID and
   digest over the authenticated administrative channel. It also verifies
   the exact user-signed destination Address Binding, but does not infer
   control of a domain solely from a signed DID assertion. The old provider
   remains fenced; it never receives the destination private messaging key.
10. Submit the exact signed PLC update to the canonical public write registry
   and reconcile an ambiguous result by CID and operation bytes. Do not activate
   the destination just because the directory immediately renders a new
   service. Validate the chain and nullification state through independent
   read paths and apply the top-user-signed cutover policy below. Only then materialize the
   imported state in a single transaction, normalize stale leases, re-check
   body/deadline and status responsibilities, publish a current Sender Profile
   signed by the destination messaging key, verify the user-controlled
   address's external WebFinger/Binding selection, and make the destination
   active. It signs an activation receipt under its current messaging key;
   only after verifying that receipt and current PLC state may the old provider
   mark its permanent fence `retired`. It never resumes signing or accepting
   envelopes for the DID.

## Top-User-Signed Cutover Policy

The destination verifies that the exact signed PLC operation was authorized
by the **current index-zero user recovery key** and is the current,
non-nullified operation through two independent validated PLC read paths,
audit data and a healthy user-operated monitor. It confirms the operation
binds the reviewed target and no unexpected intervening operation has
appeared. It can then activate without a fixed 72-hour delay, but any
disagreement, missing evidence or read-path outage fails closed. This is not
a bypass for a lower-priority-signed operation, which requires a separate
recovery procedure rather than normal migration. Continuous monitoring after
activation detects a later unauthorized provider-signed PLC change.

During the fenced interval, accepted envelopes remain durable obligations.
Delivery deadline and body-availability commitments still apply; a message that can no
longer be completed must eventually fail under the existing signed-status
rules. A generic HTTP receipt cannot pretend it was delivered. If the PLC
update is nullified, abort the inactive import. The source may resume only
after validating the restored PLC state and receiving authenticated evidence
that the destination import has been invalidated; otherwise it stays fenced.

This policy trades the DID-specific fence and independent-verification time
for a non-overlapping ownership claim. Normative recovery-window, caching,
deadline and read-evidence requirements live in
[`did-profile.md`](../spec/did-profile.md) and
[`plc-read-evidence.md`](../spec/plc-read-evidence.md).

## Private-PLC POC Rehearsal Profile

The two existing public-HTTPS POC providers may rehearse a **new** portable
DID entirely within their existing `http://plc:2582` registry. The new user
vault holds the first PLC rotation key and `#hail-identity` private key; the
source holds only its own lower-priority PLC rotation and messaging private
keys. The initial user-signed genesis and Address Binding are registered on
the private PLC and externally verified at the POC provider's HTTPS address.
The old custodial demonstration DIDs are not converted.

This profile is restricted to the named POC provider origins and the pinned
internal PLC origin. After a user-signed transfer, one fully validated
private PLC operation log and its canonical audit confirm the exact current
non-nullified cutover. The resulting observation is explicitly labeled
`assessment_profile=private-poc`, while the source custody record says
`monitor_verification_mode=poc-local`. It is **not** two independent mirrors,
an independent monitor, public PLC finality, or public Hail federation.
The normal public cutover path still requires `https://plc.directory`,
independently operated readers and a signed independent-monitor attestation;
it rejects `poc-local` custody.

The destination stages the exact signed user PLC operation, submits it only
to the private registry after the source fence, and reconciles the CID on
ambiguous responses. After the private PLC resolves to the destination, the
target temporarily publishes the selected Address Binding under the reserved
address so external WebFinger verification works **before** target account
activation. Activation atomically replaces that provisional publication
with the imported active account's same signed binding. The source retires
only on the target's signed activation receipt. No separate monitoring VPS or
public PLC mirror is required for this deliberately non-independent POC test.

### Retired private-PLC operator ceremony

The original file-based provider ceremony and its standalone `poc:*` wrappers
were retired after onboarding, Grants and transfer completion moved behind the
account API and `hailp`. The private runtime paths and fixtures remain for
compatibility and regression evidence; Git history preserves the old ceremony.

### Message continuity and collocated Grants

Migration 31 lets one provider host both DIDs of a Grant after a transfer.
There is still one immutable Grant revision chain. Its primary local owner is
the grantor; a second local receiver reference preserves the grantee's ability
to send. Activation merges only matching DID pairs, current revision/status/
digest and exact retained revision bytes; conflicts roll back the import.
Grantee snapshots include their received chain, but publication work stays
with the grantor. Neither local role is discarded to bypass a duplicate key.
