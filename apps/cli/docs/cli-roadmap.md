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
federation and the specifications in `../hailproto` remain the interoperable
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
  receipt. Disposable PostgreSQL proof now completes A → B → A with fresh roles,
  monotonic generations and immutable history. Public CLI completion remains
  disabled.
- Strict-public owner-controlled onboarding is deployed at `hailproto.app` and
  `hailproto.dev`. Two backed-up public canaries have published Sender Profiles,
  reciprocal Grants and terminally delivered messages in both directions while
  enrolled in the separately hosted public monitor.

This public-alpha proof does not establish production readiness: both providers
share one VPS, public managed migration remains disabled, and restoration/load
and monitor-outage exercises remain open.

## Remaining production gates

1. Add external dead-man supervision for the monitor and exercise disagreement,
   gaps, outages and recovery inside the PLC recovery window.
2. Prove cross-host provider/monitor restoration from latest accepted state and
   independently stored keys/backups.
3. Use a dedicated public canary for the managed provider A → B → A ceremony
   only after its remaining operational controls pass.
4. Keep the completed private-PLC managed-migration path behind its explicit POC
   gate; production remains subject to the required controls in
   [custody transitions](custody-transitions.md#production-enablement-required-versus-deferrable).
5. Complete historical-state handling, abandonment recovery, abuse controls and
   documented load limits on private clones.
6. Integrate device-keystore or hardware protection and verify cross-platform
   binary distribution.

## Current constraints

- Self-service private-PLC features are provider opt-ins.
- The v1 vault uses one encryption secret for both encrypted key records, even
  though routine operations load only the identity key.
- API credentials are provider-local and expire; rotate them while valid or use
  explicit owner-proof login.
- Managed provider transfer and automated post-export rollback are not public
  CLI workflows.
- The reference CLI has no finished consumer review UI or automatic provider
  discovery.

## Supporting records

- [Production gate details](milestone7-production-gate.md)
- [Custody-transition design](custody-transitions.md)
- [Device-keystore decision](device-keystore.md)
- [Milestone 6 CLI verification](milestone6-verification.md)
- [Documentation index](README.md)
