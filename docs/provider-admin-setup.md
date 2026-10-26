# First provider administrator: vault to dashboard

This is the **one-time bootstrap**, in execution order. After it, sign in at
`https://haili.app/auth/login` and use `https://haili.app/admin` to create or email
invitations without visiting a VPS. Use `admin@haili.app` for this Hail account;
keep `ops@haili.app` for operational email. A Hail address does not create a
conventional email mailbox or change Cloudflare Email Routing.

No administrator account is created merely by deploying the dashboard. An
account called `admin` has no privileges until explicitly granted them.

## Before starting

You need the updated repository, Bun and `jq` on your own computer, plus:

- the deployed provider/GUI and updated signup email Worker;
- public CLI onboarding enabled on the provider;
- a provider console operator for steps 2 and 6;
- a monitor operator for step 4.

Haili's restricted SSH operations wrappers permit deployment but **do not**
permit reserved-role assignment, monitor enrollment/attestation or operator
permission grants. Those steps require the existing privileged VPS consoles;
`sudo hail-provider-ops` cannot execute arbitrary `bun` commands. Do not start
account publication unless the monitor operator is available to finish it.

The normal browser signup wizard deliberately refuses reserved names, including
`admin`. This recipe uses the existing CLI onboarding ceremony. The monitor
checkpoint is real; this is not a claim that the five-minute browser wizard can
already bootstrap an administrator. An already-enrolled local account can skip
to step 6 if you prefer to grant it operator access instead.

## 1. On your computer: generate and back up the recovery vault

Run from the repository root. These commands use this checkout's CLI, so an
older installed `hailp` binary cannot change the instructions:

```bash
admin_dir="$HOME/.local/share/hailproto/admin-haili"
install -d -m 700 "$admin_dir"
bun apps/cli/src/cli/hailp.ts vault create \
  --vault "$admin_dir/vault.json" \
  --recovery-file "$admin_dir/recovery-secret.txt"
bun apps/cli/src/cli/hailp.ts vault verify \
  --vault "$admin_dir/vault.json" --expected-did unbound \
  < "$admin_dir/recovery-secret.txt"
```

The CLI creates both files privately and refuses to overwrite them. Keep the
recovery secret in your password manager or other protected separate storage,
and back up the encrypted vault independently. Verify that you can recover the
backup before proceeding. Do not upload either file to the provider, monitor or
chat. Do not put the recovery secret in a shell argument.

Print **only the public recovery key**:

```bash
jq -r '.recovery.publicDidKey' "$admin_dir/vault.json"
```

This output begins `did:key:z…`. It is the value required by
`account:role-authorize`: copy the complete value, not the example ellipsis.
It is safe to give the provider operator. It is **not** the separate recovery
secret, the vault's identity key, or the future account DID (`did:plc:…`). You
do not invent it, get it from the VPS, or need an existing account to obtain it.

## 2. Provider console: reserve admin for that public key

On Haili's privileged provider console, using the public value from step 1:

```bash
docker exec hail-public-provider-provider-1 \
  bun src/cli/authorize-provider-role.ts admin@haili.app 'did:key:zREPLACE_WITH_PUBLIC_RECOVERY_KEY'
```

The running container already has the correct provider environment. For another
installation, from `apps/server` with its environment loaded, the equivalent is
`bun run account:role-authorize -- admin@your-domain <public-recovery-key>`.

This binds the reserved name to your recovery key. It does **not** create the
account, register a passkey, or grant administrative privileges. If the name is
already assigned to another key, stop and resolve ownership; do not replace it.

## 3. On your computer: start monitored account creation

Haili's monitor identity is `https://plcmonitor.us`. Obtain its current **public**
key from the monitor operator (`sudo hail-monitor-ops status` prints it); do not
substitute an enrollment API token or private signing key. The value below was
checked against Haili's monitor on October 26, 2026. If the operator has rotated
it, use the newly verified public value. Keep this shell open:

```bash
monitor_key='did:key:z6Mknh84ZKz6BNm2mh4LFGKc1JkW2WN9ZdfCVRbi58s1k4Zr'
create_admin() {
  bun apps/cli/src/cli/hailp.ts account create \
    --provider https://haili.app --address admin@haili.app --custody managed \
    --vault "$admin_dir/vault.json" \
    --state "$admin_dir/signup.json" \
    --credentials "$admin_dir/api.credential.json" \
    --passkey-enrollment "$admin_dir/passkey-enrollment.json" \
    --monitor-origin https://plcmonitor.us --monitor-key "$monitor_key" \
    --backup-verified "$@" < "$admin_dir/recovery-secret.txt"
}
create_admin
```

Use `--backup-verified` only after completing your backup check. This publishes
the owner-signed identity and normally stops with `monitorRequired: true`, the
new account DID and its genesis operation CID. That pause is expected. Preserve
the exact files and command; do not recreate the vault or delete signup state.
No Sender Profile, Grant or message setup is needed for the dashboard.

## 4. Monitor operator: verify and attest that exact identity

On your computer, make the public checkpoint from your saved signup state:

```bash
jq '{did,rotationKeys:.operation.rotationKeys,
  verificationMethods:.operation.verificationMethods,
  alsoKnownAs:.operation.alsoKnownAs,services:.operation.services}' \
  "$admin_dir/signup.json" > "$admin_dir/reviewed-plc-data.json"
chmod 600 "$admin_dir/reviewed-plc-data.json"
```

Give the monitor operator only this checkpoint, the DID and genesis CID from
step 3. They must follow the
[monitor enrollment and attestation procedure](../apps/plc-monitor/deploy/public/README.md#enroll-the-canary)
for **this new admin identity**, not an existing canary: enroll the reviewed
checkpoint, complete healthy catch-up and enrollment-alert delivery, then issue
`onboarding-attestation.json`. For Haili's existing operator alert routing the
webhook is `https://alerts.plcmonitor.us/hail`. No consumer-email verification is
implied by this CLI bootstrap; operational alerts retain their operator route.

Save the returned attestation as
`$admin_dir/onboarding-attestation.json` with mode `0600`. No monitor or provider
private key should leave its host. Then, on your computer, resume:

```bash
create_admin --monitor-attestation "$admin_dir/onboarding-attestation.json"
```

It should finish activation and write `passkey-enrollment.json`. Back up the
updated vault (it is now bound to your account DID) and preserve signup state.

## 5. In your browser: register and test the passkey

On your computer, open the short-lived URL without pasting it into chat:

```bash
xdg-open "$(jq -r '.url' "$admin_dir/passkey-enrollment.json")"
```

Use your browser/platform's passkey prompt and choose a recognizable label.
Then visit `https://haili.app/auth/login` and sign in with that passkey. The
recovery secret is not your login password. The enrollment link expires after
ten minutes and is single-use; do not share it.

If it expires before enrollment, use the documented
[owner-proof passkey recovery command](passkey-authentication.md#lost-account-access)
with this vault and the account DID from `signup.json` to issue a fresh link.
Do not create another account. Until step 6, `/admin` will correctly return 403.

## 6. Provider console: grant operator permission

Only after the account is active and its passkey is enrolled:

```bash
docker exec hail-public-provider-provider-1 \
  bun src/cli/provider-operator.ts grant admin@haili.app
```

For another installation, run `bun src/cli/provider-operator.ts grant <address>`
from `apps/server` with its provider environment. This grant is local to this
provider and serving generation. To remove it, use the same command with
`revoke`; doing so does not revoke already issued invitations.

## 7. Everyday use

Sign in at `https://haili.app/auth/login`, then open
`https://haili.app/admin` or **Provider administration** in the sidebar.
Enter a recipient email and choose **Send invitation**, or leave it blank and
choose **Create invitation link**. Creation requires a passkey login within the
last ten minutes; sign in again when prompted. Invitations last seven days and
can be used once. Anyone holding the link can use it; the email is a delivery
destination, not an enforced identity restriction.

The history distinguishes email-service acceptance from signup started or
completed. An unconfirmed email send is not proof of failure: check with the
recipient before creating another invitation. Routine invitations require no
provider console, recovery key, CLI, or separate monitor-operator handoff.
