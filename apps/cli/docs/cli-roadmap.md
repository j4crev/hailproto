# `hailp` roadmap

This page summarizes capability status. It is not a command guide; use
[CLI workflows](cli-workflows.md) for implemented commands and
`hailp <command> --help` for exact options.

## Goal

Provide a practical HTTPS account client for people, developers, and agents
without provider SSH or database access. Support explicit owner-controlled and
managed identity custody without silently changing custody when a signer is
unavailable.

The reference account API is currently an implementation interface. Hail
federation and the specifications in the repository root remain the interoperable
protocol boundary.

## Implemented

- JSON CLI with strict command-specific options, explicit credential/account
  selection, bounded pagination and status waiting.
- Vault creation, verification, backup, import, and resumable account signup.
- Owner-controlled and managed account profiles with owner-held top PLC
  recovery authority.
- Credential inventory, narrower issuance, rotation, revocation, and explicit
  owner-proof login after bearer expiry.
- Grant creation, inspection, update, submission, and signed revocation.
- Text send, invited reply, inbox reads, resubmission, and retained status.
- Address Binding renewal.
- Authenticated Sender Profile creation, inspection and optimistic-revision update.
- Owner-controlled provider transfer, cancellation before fencing, exact
  cutover signing, completion, and forward return to a former provider.
- Managed-profile and strict-public onboarding/authority conformance slices
  verified locally through provider migration 44.
- Versioned transfer snapshots carry source-attributed strict-public authority
  history; retained v2 snapshots remain compatible for exact retries.
- Same-provider owner-controlled → managed custody rotates to a fresh
  provider-held identity with owner-signed PLC/transition approval, acknowledged
  Grant successors, exact retry state, one atomic custody/generation cutover,
  and terminal old credentials/leases.
- The reverse managed → owner-controlled path generates a fresh client-held
  identity, preserves the owner recovery and monitored history, and uses the same
  acknowledged-Grant, exact-retry and atomic generation guarantees.
- Native managed A → B migration now has local-only proof through owner-signed
  cutover approval, configured-registry submission/observation and atomic
  destination materialization. It validates exact snapshot-v4 history, installs
  only fresh B-held keys, preserves accepted work, advances the generation and
  creates Grant successors, then retires A using B's exact signed activation
  receipt. Disposable PostgreSQL proof and a reviewed public permanent-canary
  ceremony now complete A → B → A with fresh roles, monotonic generations and
  immutable history. Public provider runtimes remain disabled after the ceremony.
- Strict-public owner-controlled onboarding is deployed at `haili.app`,
  `hailproto.app` and `hailproto.dev`. Their three backed-up public canaries have
  published Sender Profiles and reciprocal Grants while enrolled in the separately
  hosted public monitor; messages between `haili.app` and each disposable provider
  reached terminal `delivered` state in both directions.

The permanent Haili provider has closed its operational launch gates. The two
disposable providers still share one VPS, public managed migration remains
disabled. Guarded live and private-clone drills now prove reader disagreement,
audit-gap refusal, dead-man alerting, stale-attestation refusal, outage recovery,
cross-host restoration and managed-transfer throttle/size boundaries.

## Remaining production gates

1. Extend Haili's key, access, backup, abuse, audit and external overload-alert
   controls to every provider proposed for public managed transfer.
2. Keep `PUBLIC_MANAGED_TRANSFER=false` for that provider until those controls
   pass. The disposable shared-host providers are not production candidates.

## Current constraints

- Self-service private-PLC features are provider opt-ins.
- The v1 vault uses one encryption secret for both encrypted key records, even
  though routine operations load only the identity key.
- API credentials are provider-local and expire; rotate them while valid or use
  explicit owner-proof login.
- Owner-controlled and managed provider transfer are public two-phase CLI
  workflows; automated post-export rollback remains operator-driven.
- The reference CLI has no finished consumer review UI or automatic provider
  discovery.

## Supporting records

- [`haili.app` launch milestone](../../../docs/haili-launch.md)
- [Custody-transition design](custody-transitions.md)
- [Device-keystore decision](device-keystore.md)
- [Documentation index](README.md)
