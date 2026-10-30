#!/usr/bin/env python3
"""Render command inventory/required options from the Rust parser; --check for CI."""
import argparse
import json
from pathlib import Path
import re

crate = Path(__file__).resolve().parents[1]
source = (crate / 'src/cli.rs').read_text()
# Intentionally narrow: fail if the command-table representation changes.
table = source.split('const COMMANDS:', 1)[1].split('= &[', 1)[1].split('\n];', 1)[0]
string = r'"(?:[^"\\]|\\.)*"'
pattern = re.compile(r'\(\s*(' + string + r')\s*,\s*(' + string + r')\s*,\s*(' + string + r')\s*,\s*(' + string + r')\s*,?\s*\)\s*,?')
commands = [tuple(json.loads(s) for s in match.groups()) for match in pattern.finditer(table)]
if not commands or pattern.sub('', table).strip():
    raise SystemExit('Command table changed: update the reference generator')
required_source = source.split('let required = match command.as_str() {', 1)[1].split('\n        };', 1)[0]
required_pattern = re.compile(r'("[^"]+"(?:\s*\|\s*"[^"]+")*|_)\s*=>\s*(?:\{\s*)?"([^"]*)"(?:\s*\})?\s*,?')
required = {}
for names, flags in required_pattern.findall(required_source):
    for name in re.findall(r'"([^"]+)"', names):
        required[name] = flags.split()
if required_pattern.sub('', required_source).strip() or not required or not set(required).issubset({c[0] for c in commands}):
    raise SystemExit('Required-option match changed: update the reference generator')
boolean_source = source.split('let value: String = match name {', 1)[1].split('if inline.is_none()', 1)[0]
boolean = set(re.findall(r'"([a-z-]+)"', boolean_source)) - {'help', 'version'}
options = {
    'credentials': 'Private API credential file. Reads select this before `HAILP_CREDENTIAL_FILE`; signup/login write a new credential here.',
    'provider': 'Canonical HTTPS provider origin. Required for signup/login and offline connection signing; on authenticated commands this asserts the credential origin, never redirects it.',
    'account-id': 'Account UUID assertion checked against the selected credential.',
    'state': 'Private ceremony/retry-state path. Keep the same path, arguments and artifacts when resuming; do not delete it to retry an ambiguous write.',
    'vault': 'Private encrypted vault path. Existing vault for signing/verification; new destination for create/import. Recovery secret is read through hidden input, not a command-line flag.',
    'output': 'Private output path for the artifact named by the command (credential, signed object, backup, invitation, export or enrollment). Unrelated existing files are refused.',
    'file': 'Input path: UTF-8 message text for send/reply, JSON definition for profile, private invitation for connection accept, or private backup/recovery package for vault import.',
    'recovery-file': 'New private file for the vault recovery secret. Store separately from the encrypted vault.',
    'expected-did': 'Expected `did:plc:…` binding for verification/import or expected peer for connection accept. Vault verification also supports `unbound`.',
    'did': 'Account `did:plc:…` whose access is being recovered.',
    'signer': 'Explicit signing role: `identity` or `owner-recovery`. Choose according to custody and the recovery procedure.',
    'scope': 'Repeat for individual credential scopes. Owner-proof login requires explicit scopes; browser login defaults to `account:read`, `grants:read`, `messages:read`, `messages:write` and accepts only subsets of those. Credential creation inherits current scopes when omitted. Doctor checks requested scopes without issuing credentials.',
    'action': 'Doctor prerequisite check, e.g. `--action "account browser-login"`; does not perform the action.',
    'address': 'Full Hail signup address, such as `alice@provider.example`.',
    'custody': 'Required signup choice: `owner-controlled` or `managed`.',
    'backup-verified': 'Explicit assertion that you saved and verified an independent recovery backup. No value; do not pass before doing the verification.',
    'invitation': 'Signed signup admission token from the URL-decoded `#invitation=` fragment, not the entire link. Required by invite-mode providers; retained in setup state.',
    'monitor-origin': 'HTTPS monitor origin for strict-public onboarding; supply together with `--monitor-key`.',
    'monitor-key': 'Pinned monitor public key; supply together with `--monitor-origin`.',
    'monitor-attestation': 'Path to retained signed monitor attestation JSON; needed when the onboarding/transfer authority profile requires it.',
    'passkey-enrollment': 'Private output path for short-lived browser passkey enrollment during signup.',
    'destination': 'Destination provider HTTPS origin for a transfer offer.',
    'username': 'Requested local username at the transfer destination.',
    'snapshot': 'Private exact transfer snapshot JSON path. Preserve the exported bytes.',
    'operation': 'Private owner-signed PLC operation output path for offline cutover.',
    'consent': 'Private signed transfer consent output path for owner-controlled cutover.',
    'approval': 'Private signed owner approval output path for managed cutover.',
    'binding': 'Private signed destination address-binding output path for owner-controlled cutover.',
    'grant': 'Grant UUID authorizing the message.',
    'category': 'Repeat for selected Grant category IDs; a send selects exactly one nonempty category. Wildcards and duplicate Grant category IDs are rejected.',
    'sender': 'Sender address used to refresh verified consent when revising a Grant.',
    'expires-at': 'Absolute Unix timestamp in seconds, not milliseconds or an ISO date. Grant creation defaults to seven days when neither expiry flag is given; revisions preserve existing expiry when omitted. Grant creation/reply deadlines must be in the future; operation-specific limits also apply.',
    'no-expiry': 'Explicit non-expiring Grant choice; mutually exclusive with `--expires-at`.',
    'refresh-consent': 'Refresh verified sender consent for a Grant revision that expands permission. No value.',
    'reply-until': 'Optional future Unix timestamp in seconds setting the reply deadline.',
    'label': 'Human-readable connection invitation label.',
    'after': 'Opaque cursor from the same operation/account/provider. Inbox-wait cursors also require the same sender filter and are incompatible with inbox-list cursors.',
    'pages': 'Maximum pages to retrieve: integer 1–100, default 1. Applies only to commands listing this option.',
    'trash': 'List recoverable trashed conversations instead of the normal conversation list. No value.',
    'from': 'Filter inbox wait by a sender `did:plc:…`.',
    'timeout': 'Inbox-wait deadline in seconds: integer 1–300, default 60.',
    'wait': 'Message-status polling deadline in seconds: integer 1–300. Omit for one status read.',
    'interval': 'Polling interval in seconds: integer 1–30, default 2. Message status requires `--wait` when specifying this.',
}
used = {flag for _, _, flags, _ in commands for flag in flags.split()}
if used - options.keys():
    raise SystemExit(f'Undocumented options: {sorted(used - options.keys())}')
lines = ['# hailp command reference', '', '<!-- Generated by scripts/generate-reference.py; edit that script and src/cli.rs. -->', '',
    'This reference describes the current source version. Start with the [quickstart](cli-quickstart.md),',
    'use the [workflow recipes](cli-workflows.md) for multi-step operations, and consult the',
    '[output/retry contract](cli-contract.md) when scripting. Your installed version’s `--help`',
    'is authoritative for its accepted command inventory.', '',
    '## Conventions', '',
    '- `<value>` means a value is required; brackets mean the flag is optional at parser level.',
    '- Conditional requirements (custody, provider policy, expiry or monitoring) still apply.',
    '- Positional arguments shown in syntax are required. `--help`/`-h` works offline on every command.',
    '- `hailp --version` works alone and prints the version. Successful operations emit JSON on stdout;',
    '  failures emit JSON on stderr with exit 1. Exit 0 means the operation/report succeeded, not necessarily delivery.',
    '- `doctor` may report `ok: false` with exit 0; inbox/status deadlines can also return successfully without delivery.',
    '- Only `--scope` and `--category` may be repeated. Use `--option=value` for a value beginning with `-`.',
    '- Private files must have no group/other permissions; create parent directories with mode `0700`.',
    '- Read-only signed-object inspection is structural validation, not independent DID-key signature authentication.', '',
    '## Shared credential selection', '',
    'Online authenticated commands accept `--credentials`, `--provider` and `--account-id`.',
    'Vault commands, `connection sign`, and transfer `sign-cutover`/`complete` commands do not',
    'accept shared credential selection. Any explicit `--provider` below still applies.',
    'Credential scopes and provider gates remain mandatory; see the [contract](cli-contract.md)',
    'and run `hailp doctor --action "<command>"` for supported prerequisite checks.', '',
    '## Options', '', '| Option | Meaning |', '| --- | --- |']
for flag, description in sorted(options.items()):
    lines.append(f'| `--{flag}` | {description} |')
lines += ['', '## Commands', '']
for name, positional, flags, description in sorted(commands):
    mandatory = required.get(name, [])
    if not set(mandatory).issubset(flags.split()):
        raise SystemExit(f'Required flags missing from table: {name}')
    syntax = ['hailp', name] + ([positional] if positional else [])
    for flag in flags.split():
        value = f'--{flag}' + ('' if flag in boolean else ' <value>')
        syntax.append(value if flag in mandatory else f'[{value}]')
    lines += [f'### `{name}`', '', description, '', '```text', ' '.join(syntax), '```', '']
    if flags:
        lines += ['Options: ' + ', '.join(f'[`--{f}`](#options)' for f in flags.split()) + '.', '']
lines += ['## Conditional requirements and safety', '',
    '- Owner-controlled Grant signing/revocation requires the identity vault; retain the signed output for retry.',
    '- Signup requires a verified backup. Strict-public onboarding requires the pinned monitor and its attestation; invite-mode admission requires an invitation.',
    '- Credential issuance is constrained by the existing credential and provider. Browser login requires the provider’s browser authorization feature and a working system browser.',
    '- Native connection invitation/acceptance requires owner-controlled signing; a bearer credential cannot authorize managed identity signing.',
    '- Transfer and custody commands are multi-step ceremonies. Follow the [workflow guide](cli-workflows.md) and preserve all state and signed files until completion is confirmed.',
    '- Permanent message deletion is distinct from recoverable conversation trash. Read the [deletion workflow](cli-workflows.md#delete-a-received-message-permanently) before using it.', '']
rendered = '\n'.join(lines)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--check', action='store_true')
args = parser.parse_args()
path = crate / 'docs/cli-reference.md'
if args.check:
    if not path.exists() or path.read_text() != rendered:
        raise SystemExit('CLI reference is stale; run python3 apps/cli/scripts/generate-reference.py')
else:
    path.write_text(rendered)
print(f'CLI reference: {len(commands)} commands, {len(options)} options')
