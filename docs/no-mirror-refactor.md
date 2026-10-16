# No-mirror PLC refactor

Hail uses `https://plc.directory` directly unless an operator explicitly adds
read-replica fallbacks. This avoids a mandatory 300–400 GB replica while keeping
local validation and retained-history regression checks.

## Implementation

- [x] Default strict provider reads to canonical `plc.directory`.
- [x] Resolve from one bounded `/log/audit` response and replay it locally.
- [x] Keep explicit ordered replica declarations as an optional rollback/fallback path.
- [x] Poll only enrolled monitor DIDs and retain each complete audit.
- [x] Version monitor attestations so per-DID coverage makes no global-export claim.
- [x] Add reversible schema expansion and refuse rollback after new evidence exists.
- [x] Run focused provider and monitor PostgreSQL integration suites.
- [ ] Deploy the monitor after its hostname, TLS and alert webhook are ready.
- [ ] Create and enroll the disposable public Hail canary DID.

No deployed replica or global PLC export bootstrap is required.
