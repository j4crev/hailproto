# Connection and conversation HTTPS wire binding

Status: Current alpha extension. Lifecycle semantics are in
[connection-federation.md](connection-federation.md); shared permission semantics
are in [shared-conversations.md](shared-conversations.md).

## Transport and primitives

All operations below use POST to `connections/{operation}` relative to the current
PLC-authenticated Hail service base. Requests and successful responses use exactly
`application/json` in the current binding. They MUST NOT use content coding,
redirects, cookies, Origin or HTTP Authorization. Authority comes from the embedded
proofs and current PLC state, not from an account credential. Apply the existing
public-DNS-pinned HTTPS/SSRF rules. The reference sender uses a 10-second deadline.

JSON is UTF-8, duplicate keys are rejected, and request objects have exactly the
fields specified below. Maximum request and response size is 131072 bytes, except
invitation review requests are limited to 2048 bytes. Limits apply before decoding.
A successful response is HTTP 200; another status is not a successful exchange.
Responses have `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

`C` below is canonical unpadded base64url of a complete tagged COSE_Sign1 control
object, decoded size at most 16384 bytes. `B` is canonical unpadded base64url of a
proof bundle, decoded size at most 100000 bytes (the outer JSON limit also applies).
`T` is the invitation's 32-byte random bearer token, encoded as unpadded base64url.
Object fields and operation names are case sensitive.

## Invitation review

Request: `{"id": UUIDv7, "did": DID, "token": T}`.
Response: `{"type":"hail.connection-review","version":1,"invitation":I,"binding":A,"federation":1}`,
where `I` and `A` are base64url signed invitation and Address Binding bytes, each
at most 16384 decoded bytes. The invitation ID, signer DID, token hash and current
binding MUST match the request and current authority. Review creates no permission.
A response without `federation:1` does not establish lifecycle support.

## Proof bundle and hash domains

A bundle is one deterministic CBOR map with exactly five byte-string fields:

```text
{
  invitation: <complete signed invitation>,
  confirmation: <complete signed confirmation>,
  inviterBinding: <complete signed inviter Address Binding>,
  scannerBinding: <complete signed scanner Address Binding>,
  snapshot: <complete signed reviewed coordinator snapshot>
}
```

Each embedded representation is at most 16384 bytes. The invitation and
confirmation use their parties' identity keys; the snapshot uses the coordinator's
messaging key. Confirmation binds the invitation's complete signed digest and the
inviter DID. Bindings identify the corresponding parties. The snapshot request ID
matches `confirmation_id`, its parties are the sorted pair, and its proof hash is
SHA-256 of the empty byte string. Verify all signatures and cross-object linkage.

The control's proof digest for offer/connect/admission/activation is SHA-256 of
these exact bundle CBOR bytes, not its base64url text or JSON wrapper. `ack` hashes
the complete received control COSE bytes. An unqualified state probe uses SHA-256
of the empty byte string. A disconnect command uses SHA-256 of the deterministic
CBOR map `{connection_id: <target ID>}` and has `state:"active"`. All hashes use the normal `{algorithm:"sha-256",value}`
CBOR digest shape in signed controls.

## Lifecycle messages

| Operation | Exact request fields | Required control operation | Successful response |
| --- | --- | --- | --- |
| `state` | `{control:C}` | `probe` | `{control:C}` with `snapshot` |
| `admit` | `{control:C,bundle:B,token:T}` | `offer` | `{control:C}` with `admission` |
| `commit` | `{control:C,bundle:B,admission:C}` | `connect` | `{control:C,current:C}`: historical result snapshot and separate current snapshot |
| `disconnect` | `{control:C}` | `disconnect` | `{control:C,current:C}`: historical result snapshot and separate current snapshot |
| `sync` active | `{control:C,bundle:B,admission:C}` | `snapshot` | `{control:C}` with `ack` |
| `sync` disconnected | `{control:C}` | `snapshot` | `{control:C}` with `ack` |

`state`, `commit` and `disconnect` target the lexicographically smaller DID's
provider. `admit` targets the inviter; `sync` targets the larger DID's provider.
A probe has `state:"empty"`, `connection_id:null`, `epoch:0` and empty-byte proof
digest. Responses bind the request ID and the exact pair. A historical success
MUST NOT override a newer current snapshot or a terminal connection ID. First
adoption of an active sync requires retained local consent and a current
coordinator probe. The handshake and epoch constraints in the federation spec
remain mandatory even when every signature is valid.

## Conversation revival

POST `connections/conversation-revival` has exactly:

```text
{"connectionId": UUIDv7, "cose": base64url(signed revival), "epoch": positive integer}
```

The signed revival is at most 16384 decoded bytes. Its `to` DID routes the request;
its `from` is the original creator. The connection fields identify the exact current
creator-to-recipient permission used for readmission. The receiver verifies current
creator/service authority and coordinator state, historical descriptor linkage,
recipient policy, freshness and replay state before changing a lease.

Success is `{"requestId": UUIDv7, "outcome": O}`, where O is `renewed`, `active`,
`left` or `denied`. The request ID MUST equal the signed request's `request_id`.
The response is authenticated by the resolved HTTPS destination; it is not a new
signed delivery capability. Only `renewed` extends a lease. Exact retries reuse
the retained outcome; conflicting signed bytes under the same creator/request ID
fail. Unknown or cleaned-up conversations cannot be recreated by revival.

The reference outbox retries failed exchanges with bounded exponential backoff
until the signed request's expiry, then records local `expired`. `expired` is not
a receiver success outcome. Receiver clock tolerance is 300 seconds; it does not
require the sender to continue retries beyond its own deadline.

## Errors and disclosure

These endpoints use a generic JSON error rather than the envelope-submission
problem/status protocol. Lifecycle and revival errors contain
`{"error":"Connection exchange not accepted"}`; review errors contain
`{"error":"Connection invitation unavailable"}`. HTTP statuses are:

| Status | Meaning |
| --- | --- |
| 400 | Malformed request, invalid proof or inconsistent fields |
| 403 | Forbidden transport credentials or authority |
| 404 | Unknown operation, unavailable invitation/account/conversation |
| 409 | Conflicting intent, stale epoch or state preventing the operation |
| 410 | Expired or invalid admission/revival time window |
| 413 | Request exceeds byte limit |
| 415 | Unsupported media type or content coding |
| 429 | Rate limit |
| 503 | Temporary/unclassified exchange failure |

A failure MUST NOT be treated as admission or delivery. Retry an ambiguous exchange
with the same immutable operation/proof; never invent a fresh operation to bypass
replay protection. Durable disconnect work survives temporary failures. Rate-limit
thresholds and worker scheduling are local policy. Do not infer a 500-ms protected
envelope response schedule for these separately specified extension endpoints.

## Handover

`handover`, `handover-freeze`, `handover-abort`, `handover-commit` and
`handover-complete` use this same transport but detached signed transfer records,
not connection-control COSE objects. Their field shapes and signing domains are
specified in [transfer-formats.md](transfer-formats.md#connection-handover-records);
their state transitions are in [connection-portability.md](connection-portability.md).
