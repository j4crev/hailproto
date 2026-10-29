# CLI remaining work

Implemented commands and capabilities live in the [CLI README](../README.md),
[workflow guide](cli-workflows.md) and [command contract](cli-contract.md).

- Device-keystore integration must keep routine signing separate from recovery authority.
- Broader platform distribution and system-browser login need explicit validation.
- Automatic provider discovery and a consumer review UI remain separate product work.
- Automated public post-export recovery remains outside the integration-only private coordinator.
- General historical-key reconciliation remains blocked for unacknowledged/conflicting predecessors.
- Each public transfer operator needs its own key/access/backup/abuse/audit and overload-alert controls.

See [custody and recovery](custody-transitions.md), [device-keystore boundary](device-keystore.md)
and [historical Grant keys](grant-key-reconciliation.md). Private-provider opt-ins
and public runtime gates remain distinct. API credentials expire and remain provider-local.
