# Device-keystore protection decision

This defines milestone 2's device protection path; OS-keystore integration is
not implemented yet. The current v1 vault remains a portable encrypted backup,
unlocked with its separately retained random secret. Routine Grant actions use
identity-only decryption, but storing that shared secret in a device keystore
would also make recovery decryptable on that device. Do not do that.

## Selected boundary

- Enroll a separate **identity-only device record** after explicit full-vault
  verification/import. Preserve its DID and identity public-key fingerprint;
  include no PLC recovery ciphertext, recovery key or backup encryption secret.
- Encrypt the Ed25519 identity private key with an independently generated
  256-bit device wrapping key using AES-GCM. Authenticate record version, DID,
  signing role and public-key fingerprint; use a fresh nonce for each encryption.
- Store only that device wrapping key in the OS keystore. For the Linux baseline,
  use the user's Secret Service collection and native unlock prompt. Do not run
  an additional Hail key service or assume Secret Service is hardware-backed.
- Scope the keystore entry to this application, device record and identity.
  Explicit enrollment/unlock authorizes local use; bearer API credentials and
  untrusted message text never enroll or unlock a signer.
- Routine signing retrieves the wrapping key, decrypts/imports only Ed25519,
  verifies the public/private match and checks the reviewed account/Grant as it
  does today. Keep raw private bytes transient, clear mutable buffers, and
  never emit secrets in JSON, errors, logs, command arguments or environment.
  OS user/session compromise can still expose unlocked identity authority.

## User and lifecycle behavior

Enrollment is deliberate, per installation, and only available after an
independent vault/secret backup has been verified. Keep recovery backup material
offline/separately controlled; the device record is not the only backup.
Managed accounts do not enroll the unused local identity as their active signer.

Locked/unavailable keystore access returns an actionable error. Noninteractive
operation requires an explicitly authorized unlocked keystore session; it never
falls back to the portable vault, PLC recovery key or managed provider custody.
An explicit existing portable-vault workflow remains available separately.

Removing a device record/keystore entry removes that installation's convenience
access, not the DID, independent backup or authority of an already copied key.
An untrusted/lost device needs reviewed identity rotation to revoke its copied
signing authority; local deletion alone cannot accomplish that. Restoration on
another installation imports the independently verified backup and explicitly
enrolls a new device wrapping key; it does not copy the old keystore entry.

## Passkeys and compatibility

A passkey may authenticate a user or gate keystore access. A normal WebAuthn
assertion signs authenticator/client data; it is not Hail's raw Ed25519 signing
operation and is not a PLC recovery signature. Passkeys neither replace these
keys nor change custody. A future PRF-based wrapping scheme would require its
own platform support and recovery proof before adoption.

This device record is distinct from the v1 backup, so adding it must preserve
v1 import and exact public-key/DID fingerprints. No provider API or protocol
format change is required. Before implementation is called complete, prove
enrollment, locked/unavailable behavior, identity-only signing, deletion,
second-installation recovery and absence of recovery material in the device
record/keystore. The roadmap's definition item does not claim those OS tests pass.
