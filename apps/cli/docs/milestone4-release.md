# Milestone 4 release — October 10, 2026 (UTC)

Both private-POC providers are healthy at migration **35**. Provider-domain
Address Binding renewal and stable-key Grant revisions passed real HTTPS checks
for both custody profiles on both origins, including cross-provider publication.
Historical-key reconciliation is defined but remains disabled.

## Release identity

| Component | Identity |
| --- | --- |
| Provider | `deea8417cf837d37182f0070fcbb546154c3837c` (runtime `2549d7c`) |
| Client | `b0058d9234e83a7f7b2dd13df0bbf9d8280b7a75` (runtime `e689b34`) |
| Protocol | `4c8af6d9d3435c15859a05b684f6f6ed562c523f` |
| PLC library | `996e23b5ced9c15b32bcc612dd304880342ca4ab` |
| Running image | `hail-server-ts:poc-milestone4-20261010` |
| Image ID | `sha256:5040dcda53cde8bc6bb0aac992d9ef6874540fad99667c6185e6e71ad20a07cc` |

Clean Git archives were built in `/opt/hail-milestone4-release-20261010/` on the
VPS, preserving the sibling layout. The current `compose.cli-release.yaml`
overlay pins the image, uses that build context, and retains explicit private-PLC
signup/access gates. Include the overlay for live stack operations:

```bash
docker compose --env-file .env -f compose.yaml -f compose.cli-release.yaml ps
```

The previous migration-34 image is retained as
`hail-server-ts:pre-milestone4-rollout-20261010`, ID
`sha256:9c6e8997c48349b2dc6d9c742ce0af67abb1858c9b9305ee124d4f450ca83d84`.
Image rollback is not a data rollback; older clients may reject new seven-scope
credentials. Use the updated CLI before requesting `account:write` or new APIs.

## Rehearsal and rollout

- Authorization/publication review is retained on the VPS as
  `milestone4-review.md`: explicit write scopes, current authority/custody,
  immutable hosting before CAS selection, exact evidence/consent, source fences,
  ordered history/publication and historical-key holds were reviewed.
- Fresh copies of both live migration-34 databases were fully restored into
  separate disposable PostgreSQL `14.4-alpine` containers. Candidate startup
  applied 35, passed readiness and repeat migration. The migration-34 image also
  passed schema/readiness startup against each migrated copy.
- Sorted row hashes/counts for every pre-existing public table matched exactly
  before/after, excluding only the migration ledger. Existing credential scope,
  expiry, custody, Grant/message/history data were unchanged.
- The first harness attempt hit a disposable database initialization race before
  dev restore. Readiness was corrected to require successful TCP SQL against the
  intended database; the full rehearsal reran successfully with fresh backups.
  Live schemas/images remained unchanged throughout rehearsal. Temporary
  containers/volumes and clone environment files were removed.
- Fresh pre-rollout backups/configuration were taken before replacing either
  provider. App was rolled with `--no-deps --wait --no-build`, followed by HTTPS
  readiness and migration-35 checks, then dev was rolled the same way.
- Both providers use the same image and report healthy; no worker errors appeared
  during acceptance checks. Database, PLC, Caddy and monitor containers were not
  recreated and remain healthy.

Successful rehearsal backups/evidence:
`/var/backups/hail-poc/pre-milestone4-rehearsal-20261010-pass2/`.
Failed-attempt backups/log are separately retained. Fresh rollout backups/evidence:
`/var/backups/hail-poc/pre-milestone4-rollout-20261010/`.
Directories are mode `0700`; dumps and secret configuration are mode `0600`.
Nonempty custom-format provider/PLC dumps passed `pg_restore --list`; SHA-256
checksums, old overlay and prior image were retained. Keep them through recovery
review. Sequential same-VPS dumps are not coordinated post-cutover/off-host proof.

Executed VPS scripts/logs: `rehearse-milestone4.sh`, `rehearsal-pass2.log`,
`roll-milestone4.sh`, `rollout.log`, beneath the release source directory.

## Real HTTPS acceptance

The four disposable accounts from the prior CLI/lifecycle releases were used:

| Origin | Custody | DID |
| --- | --- | --- |
| `https://hailproto.app` | owner-controlled | `did:plc:6zexa3fpfmfpcwlsrtp6cqu2` |
| `https://hailproto.app` | managed | `did:plc:evaewtveayxkk4ltjbmuxc5z` |
| `https://hailproto.dev` | owner-controlled | `did:plc:ossu6qqku7zztx3avw5uea3p` |
| `https://hailproto.dev` | managed | `did:plc:wzjke6mnxrvyu63yycckkj5k` |

Every case passed with TLS verification enabled and user signing material local:

1. Existing migration-34 manager credentials still lacked `account:write`. Owner
   login deliberately requested it alongside account/Grant read/write authority;
   custody, identity and owner recovery public keys were unchanged.
2. `binding renew` extended expiry within 90 days, retained identical bytes/digest/
   ID on retry, selected the matching WebFinger URL and returned exactly the saved
   signed representation from that public URL. The original binding URL remained
   retrievable. A 91-day request failed.
3. Operator tooling published legitimate Sender Profiles only for those exact
   disposable accounts; no user private key entered provider profile tooling.
4. Each recipient created one multi-category Grant to a sender on the other
   provider. A later signed Sender Profile withdrew all offered choices.
   Restriction to an already permitted category still succeeded, preserving old
   consent; expansion against the withdrawn choices failed.
5. Restoring offered choices allowed explicit category expansion/expiry renewal.
   Consent refresh appended a new revision. Exact and superseded retries returned
   retained state without replacing the latest revision.
6. Signed terminal revocation prevented further updates. All **five publication
   revisions** (creation, restriction, expansion/renewal, refresh, revocation)
   became acknowledged in order. The other provider retained revision 5 as the
   grantee's revoked Grant copy.
7. State/signature/credential files were private mode `0600`; secrets were absent
   from CLI stdout/stderr. All four PLC logs still contained exactly their original
   signed genesis—no DID/key/custody/transfer operation was published.

Local execution: `/tmp/opencode/verify-milestone4-live.ts`; private disposable
artifacts and public summary: `/tmp/opencode/milestone4-live-20261010/`.
Existing local PLC comparison script also passed. A script-only typo/container
name error was corrected; retained binding artifacts resumed without re-signing
or generating a different renewal. Only public summaries/scripts and this record
were copied into VPS evidence storage, not user vaults, recovery secrets or
credential/login/request files.

The withdrawn-choice test is not a claim of a VPS sender outage: local integration
tests separately prove offline restrictions, stale evidence, response-loss/fork
handling, expired credentials/signers and all relevant fence states. Scope/lifetime
and ordered cross-provider publication were verified on the real hosts. The POC
remains private-PLC/same-VPS; custom domains, historical-key execution, independent
monitoring and managed transfer are not relabeled as production guarantees.
