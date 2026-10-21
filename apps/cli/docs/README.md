# Documentation guide

Start with the task you are trying to complete. Most CLI users need only the
first three pages below; the remaining files record design decisions and test
evidence for maintainers.

## Use the CLI

- [CLI workflows](cli-workflows.md): copyable recipes for accounts,
  credentials, Grants, messaging, backups, bindings, and transfers.
- [CLI contract](cli-contract.md): stable output, errors, selection, bounds,
  and retry behavior for scripts and agents.
- [Installation](cli-installation.md): pinned source build, native executable,
  and clean-install verification.
- [Roadmap](cli-roadmap.md): implemented scope and remaining production work.

For exact flags, use `hailp <command> --help`. Runtime help is generated from
the same command table used to validate options.

## Design references

These pages explain security or lifecycle decisions. They are not tutorials.

- [Account access recovery](account-access-recovery.md)
- [Credential lifecycle](credential-lifecycle.md)
- [Vault restoration](vault-restoration.md)
- [Device-keystore boundary](device-keystore.md)
- [Binding renewal](binding-renewal.md)
- [Grant revisions](grant-revisions.md)
- [Historical Grant keys](grant-key-reconciliation.md)
- [Custody transitions](custody-transitions.md)
- [Lifecycle history](lifecycle-history-migration.md)
- [Generation-bound return](generation-bound-return.md)
- [Post-export recovery](post-export-recovery.md)

Normative protocol rules live in the sibling `hailproto` repository. When a
design note and a protocol specification differ, the specification is the
authority.

## Verification and release records

The following dated pages preserve what was tested or deployed at a milestone.
They are historical evidence, not setup instructions:

- [Initial CLI rehearsal](cli-release-rehearsal.md)
- [Initial provider rollout](cli-release-rollout.md)
- [Account-access verification](account-access-verification.md)
- [Credential/account lifecycle release](lifecycle-release.md)
- [Milestone 4 release](milestone4-release.md)
- [Milestone 5 release](milestone5-release.md)
- [Milestone 6 verification](milestone6-verification.md)
- [Milestone 7 production gates](milestone7-production-gate.md)

