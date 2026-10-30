# Use hailp with your existing web account

[Install hailp](cli-installation.md) first. This guide assumes an existing Hail
account with a working browser passkey and a provider that enables CLI browser
authorization. It does not create another identity or change custody.

## Sign in with read-only access

On supported Linux desktops, `hailp` opens your default browser through `xdg-open`.
Run it on the same desktop as the browser so the local callback can complete.
Replace the provider origin below with your account's provider.

```bash
install -d -m 700 "$HOME/.local/share/hailp"
hailp account browser-login \
  --provider https://haili.app \
  --state "$HOME/.local/share/hailp/browser-login.json" \
  --credentials "$HOME/.local/share/hailp/read-only.credential.json" \
  --scope account:read \
  --scope messages:read
```

Authenticate with your passkey and review the requested permissions in the browser.
The resulting credential stays in the private local file. Keep the state file
private too; if interrupted, retain the original paths and arguments for the
retry. This is a desktop flow, not headless-device authorization.

## Read your account and inbox

```bash
export HAILP_CREDENTIAL_FILE="$HOME/.local/share/hailp/read-only.credential.json"
hailp account show
hailp doctor --scope account:read --scope messages:read
hailp inbox list --pages 1
hailp inbox wait --timeout 60
```

Output is JSON. A successful wait can time out without a message; inspect the
returned result rather than treating exit 0 as proof of delivery. Read a message
using the `sender` and `messageId` from the inbox result:

```bash
hailp inbox show 'did:plc:REPLACE_WITH_SENDER' 'REPLACE_WITH_MESSAGE_ID'
```

This credential deliberately cannot send messages or administer your account.
For those tasks, authorize the needed scopes into a separate credential file and
follow the [workflow guide](cli-workflows.md). Never paste credential files,
vault secrets or recovery packages into support requests.

## Troubleshooting and next steps

- `hailp doctor --provider https://haili.app --action 'account browser-login'`
  checks public workflow prerequisites without changing an account.
- If a credential expires or is revoked, repeat browser login with **new** state
  and credential paths. An interrupted login should retain its original paths.
- If the browser cannot open, check your desktop's `xdg-open` installation and
  default browser. SSH/headless hosts are not covered by this quickstart.
- Lost passkeys require the [account recovery procedure](account-access-recovery.md),
  not a new account. Keep your original recovery package and secret.

See the [command reference](cli-reference.md) for options, the
[workflow guide](cli-workflows.md) for complete task recipes, and the
[CLI contract](cli-contract.md) for output, scope and retry semantics.
