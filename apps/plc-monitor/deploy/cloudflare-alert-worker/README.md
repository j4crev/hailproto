# Cloudflare email alert receiver

This Worker receives signed monitor alerts at
`https://alerts.plcmonitor.us/hail`, verifies the pinned monitor Ed25519 key and
signature, and sends them from `security@notify.haili.app`. Bound consumer
identities go to their verified security email destination; unmapped existing
canaries continue going to the operator at `the@j4w8n.com`. Its
minute cron also checks `haili.app` and alerts when authenticated monitor-host
heartbeats are more than six minutes old. Outage and recovery mail is sent only
when state changes.

## Cloudflare Email Sending

Use Workers Paid and onboard `notify.haili.app` as a sending domain with its
required DNS authentication. The structured `EMAIL.send()` binding supports
arbitrary recipients; no Cloudflare Email API key is needed in the monitor VPS
or provider. Operator alerts and user security alerts use
`security@notify.haili.app`; signup verification uses `welcome@notify.haili.app`.
All messages use **Hail** as the sender display name; the underlying email
addresses are unchanged. The verification URL is on its own line so mail clients
do not include sentence punctuation in the link.

The Wrangler binding is `{"name":"EMAIL","remote":true}`. Remote sending during
`wrangler dev` is deliberately enabled: development can send real emails and
consume quota. Put development-only service secrets in the ignored `.dev.vars`
file; use a different shared secret from production. Unit tests mock the binding
and never send email.

Keep **Drop suppressed recipients** disabled in Email Sending. Explicit vendor
rejections, including suppression and quota errors, return a retryable failure
rather than acknowledging an alert as sent. A successful `send()` acknowledges
acceptance by the email service, not inbox delivery or a read receipt. The signup
code proves receipt once; ongoing delivery still needs production observability.
Asynchronous bounce/complaint event ingestion is not implemented in this slice.

After generating the monitor key:

```bash
cd deploy/cloudflare-alert-worker
bunx wrangler login
printf '%s' 'did:key:z...' | bunx wrangler secret put MONITOR_PUBLIC_KEY
printf '%s' 'random secret' | bunx wrangler secret put HEARTBEAT_TOKEN
printf '%s' 'different random secret' | bunx wrangler secret put BACKUP_TOKEN
# Interactive prompt: use the same new 32-byte base64url secret in the provider.
bunx wrangler secret put SIGNUP_EMAIL_TOKEN
bunx wrangler deploy
```

Use `https://alerts.plcmonitor.us/hail` as the monitor enrollment webhook. The
`/hail` handler sends no email and returns a non-2xx status unless the raw request has a
valid, at-most-seven-day-old `hail.plc-monitor-alert.v1` signature from the pinned
key. A Durable Object atomically claims each alert UUID and suppresses completed
replays for 30 days. In-flight duplicates return `503`, not a false successful
acknowledgement. A failed email releases only its own claim for retry. Reusing an
alert UUID with different signed content is refused. Existing deduplication rows
remain readable; no Durable Object migration or data deletion is required.

### Consumer-only monitor endpoints (local implementation)

`POST /hail/signup` verifies the same pinned monitor signature as `/hail`, but
requires an existing verified consumer binding. For enrollment notifications,
the signed `detail.operationCid` must match the bound genesis CID. It never falls
back to the operator. Its deduplication scope is separate, so an earlier operator
acknowledgement cannot certify delivery to the consumer. `/hail` retains legacy
operator fallback for existing canaries.

`POST /hail/signup/binding` is a read-only monitor check. Its exact JSON fields
are `type: "hail.plc-monitor-email-binding"`, `version: 1`, `signupId`,
`signupHash`, `did`, `operationCid` and Unix-second `issuedAt`. The request must
be within five minutes and signed by the pinned monitor key under
`hail.plc-monitor-email-binding.v1\0`, using the existing monitor-key/signature
headers. An alert signature cannot be reused for this purpose. Only an exact
bound context returns `{bound:true,did,operationCid}`; no email address or secret
is returned, and the call grants no new authority or sends email.

These additions need a separately reviewed monitor/receiver rollout. They do not
enable automatic enrollment merely by existing in the source tree. See the
[automatic monitor runbook](../public/README.md#automatic-reduced-assurance-alpha-enrollment).

## Signup Email Verification And Routing

`POST /signup-email`, `/signup-email/verify` and `/signup-email/bind` are private
backend-to-Worker operations. They require `Authorization: Bearer <SIGNUP_EMAIL_TOKEN>`.
Without that configured secret they fail closed. Never put it in browser code,
query strings, logs or the public repository. It is our service authentication
secret, not a Cloudflare Email API key.

The provider enables its same-origin proxy only when both are configured in its
private environment:

```dotenv
SIGNUP_EMAIL_ORIGIN=https://alerts.plcmonitor.us
SIGNUP_EMAIL_TOKEN=<same canonical 32-byte base64url secret as the Worker>
```

Public-provider Compose passes these optional settings only to the provider,
not the GUI. Leaving both empty keeps the new provider endpoints disabled.

### API And Ordering

The browser talks to the provider, not the private Worker endpoints. Each request
uses a client-generated, random `hailp_...` signup capability in its Authorization
header and the expected browser Origin. It is scoped signup state, not an account
API credential or owner recovery key. The provider sends only its hash to the
Worker, alongside a UUID `signupId` retained across retries.

| Provider endpoint | Browser JSON fields | Result |
| --- | --- | --- |
| `POST /api/v1/signup-email/start` | `signupId`, `email`, optional `resend` | Send a fixed verification template; return `verified` and `expiresAt` |
| `POST /api/v1/signup-email/verify` | `signupId`, eight-digit `code` | Verify control of that email destination only |
| `POST /api/v1/signup-email/bind` | `signupId`, `accountId` | Bind the verified destination to the retained alpha signup genesis |

All expiry values are Unix milliseconds. The code expires after ten minutes and
permits five incorrect guesses. A verified but unbound destination expires after
24 hours. Only the code hash is stored, and it is removed after verification.
The Worker never returns the code to the provider/browser; it appears only in
the email. Expired unbound records and sending counters are pruned by a Durable
Object alarm. Bound routing records remain while monitoring needs them.

Exact successful start retries do not send another email. Explicit resends
invalidate the previous code, have a 60-second cooldown, and are capped at five
per mailbox per hour and 100 total per hour. Failed or ambiguous send attempts
also consume the rate budget; retry later and use the latest email. These are
abuse protections even when service quota is ample. The provider additionally
limits requests by its trusted client-IP header.

The same signup capability must authorize the owner-signed alpha onboarding
preparation. The bind endpoint reads the account's registered genesis DID/CID
from retained provider evidence; it never trusts browser-selected identity
data. It refuses other accounts, unregistered identities and independent-profile
accounts. The authenticated Worker bind call receives `signupId`, `signupHash`,
`did` and `operationCid`; callers must perform those ownership/evidence checks.

**Bind before enrolling the DID in the monitor or testing its enrollment alert.**
Otherwise an unmapped alert would fall back to the existing operator destination,
which does not prove that the consumer received it. Exact bind retries succeed;
changing a bound email, DID or genesis CID is refused. Email changes require a
separately authenticated future lifecycle, not a new unauthenticated signup.

Email verification grants no login, account-reset, signing or identity-recovery
authority. The full resumable consumer wizard, automatic monitor enrollment and
its activation checks are still separate work; these endpoints alone do not
enable public alpha signup or replace the CLI owner-proof recovery ceremony.

### Rollout And Rollback

Deploy only after configuring the sending domain, shared service secret and
appropriate recipient/delivery observability. Test with an operator-controlled
mailbox before inviting users. Keep signup admission/invitation controls in the
full signup release plan; rate limits and fixed templates limit abuse but are
not proof that an arbitrary public caller is an invited user. This repository
change does not deploy anything.

To pause new email enrollments, remove both provider signup-email settings. Keep
the Worker and existing recipient records serving signed alerts. Once consumers
are bound, reverting to the old operator-only Worker is not a safe rollback: it
would divert their security alerts. Do not erase routing or deduplication state.

The monitor host posts an empty authenticated `POST /heartbeat` every three
minutes after checking that its monitor container is healthy. Keep the heartbeat
token outside the repository. Unchanged health states are not rewritten to KV;
only heartbeats and state transitions consume writes.

The provider backup job posts to `/backup-heartbeat` only after an encrypted R2
upload is downloaded and its digest matches. Missing backup heartbeats alert
after 26 hours.
