# Documentation guide

Start with the task you are trying to complete. Most CLI users need only the
first three pages below; the remaining files explain current security and lifecycle contracts.

## Use the CLI

- [Quickstart](cli-quickstart.md): sign in to an existing web account and read your inbox.
- [Command reference](cli-reference.md): every command, required flags and option meanings.
- [CLI workflows](cli-workflows.md): copyable recipes for accounts,
  credentials, Grants, messaging, inbox waits, conversations, invitation
  management, diagnostics, backups, bindings, and transfers.
- [CLI contract](cli-contract.md): stable output, errors, selection, bounds,
  and retry behavior for scripts and agents.
- [Agent guide](agent-guide.md): account setup, private files, task boundaries,
  and truthful completion reporting.
- [Agent evaluations](agent-evaluation.md): disposable account-first trials and
  coordinated multi-agent milestones.
- [Installation](cli-installation.md): pinned source build, native executable,
  and clean-install verification.
- [Roadmap](cli-roadmap.md): remaining client and provider-readiness work.

For exact flags, use `hailp <command> --help`. Runtime help is generated from
the same command table used to validate options.

## Design references

These pages explain security or lifecycle decisions. They are not tutorials.

- [Account access recovery](account-access-recovery.md)
- [Credential lifecycle](credential-lifecycle.md)
- [Device-keystore boundary](device-keystore.md)
- [Binding publication](binding-publication.md)
- [Grant revisions](grant-revisions.md)
- [Historical Grant keys](grant-key-reconciliation.md)
- [Custody transitions](custody-transitions.md)

Normative protocol rules live in this repository’s [`spec`](../../../spec) directory. When a
design note and a protocol specification differ, the specification is the
authority.
