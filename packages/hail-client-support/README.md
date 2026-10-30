# Shared web client support

Browser-safe encrypted vaults, managed-genesis review and recovery packages, plus
server-side account API transport used by the web app. These modules were extracted
from the retired TypeScript CLI so browser signup, recovery and account access do
not depend on the Rust executable. There is no CLI entry point here.

Browser code may import `vault-crypto`, `managed-genesis` and `recovery-package`.
`account-api` and `private-files` use Node APIs and belong on the server only.
Provider integration-test signing/workflow helpers live under
`apps/server/test/client-support`; they are not shipped in provider images.
