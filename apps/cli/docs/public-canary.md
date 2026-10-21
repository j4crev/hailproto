# Public Hail canary

Use one disposable owner-controlled account to prove public PLC onboarding and
provide `PLC_READER_DIAGNOSTIC_DID`. It is real public identity state, not a
production user.

## Prerequisites

- Direct validated access to `https://plc.directory`
- Public self-service onboarding enabled on the provider
- A monitor with a durable signing key and fresh per-DID audit polling
- A reviewed monitor origin/key and HTTPS alert destination
- A private workstation directory plus independent backup storage

Do not create the canary while reader or monitor health is stale.

## Build or install hailp

```bash
bun run build
bun run smoke -- dist/hailp
install -Dm755 dist/hailp "$HOME/.local/bin/hailp"
```

## Create and publish

```bash
install -d -m 700 /secure/hail-canary
hailp vault create \
  --vault /secure/hail-canary/vault.json \
  --recovery-file /secure/hail-canary/recovery-secret.txt
hailp vault verify --vault /secure/hail-canary/vault.json --expected-did unbound

hailp account create \
  --provider https://provider.example \
  --address canary@provider.example \
  --custody owner-controlled \
  --vault /secure/hail-canary/vault.json \
  --state /secure/hail-canary/signup.json \
  --credentials /secure/hail-canary/api.credential.json \
  --backup-verified \
  --monitor-origin https://monitor.example \
  --monitor-key did:key:...
```

The first call publishes the exact genesis, saves the DID/CID and exits with
`monitorRequired`. Keep every file unchanged. Enroll that DID, reviewed genesis
CID/state and alert destination with the monitor, wait for a fresh audit poll,
then create `/secure/hail-canary/onboarding-attestation.json` with the monitor's
`monitor:attest-onboarding` command.

Repeat the exact `hailp account create` command with:

```text
  --monitor-attestation /secure/hail-canary/onboarding-attestation.json
```

After activation, publish an explicit Sender Profile before testing Grants:

```bash
hailp profile create --file /secure/hail-canary/profile.json \
  --credentials /secure/hail-canary/api.credential.json
```

After activation, verify `hailp account show`, resolve the DID through each
configured reader, and set the same DID as `PLC_READER_DIAGNOSTIC_DID` on the
provider. Preserve the vault, recovery secret, signup state, credential and
attestation; never commit them or store them on the provider/monitor VPS only.
