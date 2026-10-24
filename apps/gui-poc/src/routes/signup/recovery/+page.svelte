<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { createSignupBackup, encodeBase64Url, verifySignupBackup, type UserVaultFile } from "$lib/signup-recovery.js";

  let vault = $state<UserVaultFile | null>(null), secret = $state("");
  let file = $state<File | null>(null), enteredSecret = $state("");
  let consent = $state(false), busy = $state(false), verified = $state(false), message = $state("");
  let backupSaved = $state(false), secretSaved = $state(false);
  let backupUrl = $state("");
  let operation = 0;

  function clear() {
    operation += 1;
    if (backupUrl) URL.revokeObjectURL(backupUrl);
    backupUrl = ""; vault = null; secret = ""; enteredSecret = ""; file = null;
    verified = false; backupSaved = false; secretSaved = false;
  }
  onDestroy(clear);
  onMount(() => {
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  });

  async function generate() {
    if (!consent || busy || vault) return;
    const current = operation;
    busy = true; message = "";
    try {
      const generated = await createSignupBackup();
      try {
        if (current !== operation) return;
        vault = generated.vault; secret = encodeBase64Url(generated.recoverySecret);
      }
      finally { generated.recoverySecret.fill(0); }
      backupUrl = URL.createObjectURL(new Blob([JSON.stringify(vault, null, 2)], { type: "application/json" }));
    } catch { clear(); message = "This browser could not create the recovery kit. Nothing was registered. Try an updated browser."; }
    finally { busy = false; }
  }
  async function verify() {
    if (!vault || !file || busy || !backupSaved || !secretSaved) return;
    const current = operation;
    busy = true; message = "";
    try {
      if (file.size > 16_384) throw new Error("Backup too large");
      await verifySignupBackup(await file.text(), enteredSecret.trim(), vault);
      if (current !== operation) return;
      clear(); verified = true;
      message = "Your saved backup and recovery secret work. Recovery material has been released from this page; close this tab when finished.";
    } catch { message = "Verification failed. Choose this signup's saved backup and enter its separate recovery secret."; }
    finally { enteredSecret = ""; busy = false; }
  }
</script>

<svelte:head><title>Hail recovery setup preview</title><meta name="robots" content="noindex, nofollow" /></svelte:head>

<section class="hail-card flex flex-col gap-4 p-7 [&_h1]:m-0 [&_h2]:m-0 [&_h2]:text-[18px] [&_p]:m-0 [&_p]:leading-[1.6] [&_label]:block [&_label]:leading-[1.6] [&_label>input:not([type=checkbox])]:mt-1.5 [&_label>input:not([type=checkbox])]:block [&_label>input:not([type=checkbox])]:max-w-full [&_input[type=password]]:w-full [&_input[type=password]]:p-2.5 [&_input[type=password]]:[font:inherit] [&_button]:self-start [&_button]:px-4 [&_button]:py-2.5 [&_button]:[font:inherit] [&_button]:cursor-pointer [&_button:disabled]:cursor-not-allowed [&_button:disabled]:opacity-60">
  <h1>Recovery setup preview</h1>
  <p><strong>This preview does not create an account or publish an identity.</strong>
    It tests saving and reopening an encrypted recovery kit locally in your browser.</p>
  <p>Managed Hail accounts let the provider sign everyday permissions. You keep separate
    recovery authority. A passkey signs you in; it does not replace this backup.</p>
  {#if !vault && !verified}
    <label><input type="checkbox" bind:checked={consent} disabled={busy} />
      I understand that this page temporarily handles recovery keys. Compromised page code
      or my device could steal them. I will keep the backup and secret separately.</label>
    <button onclick={generate} disabled={!consent || busy}>{busy ? "Creating…" : "Create recovery kit"}</button>
  {:else if vault}
    <h2>1. Save your encrypted backup</h2>
    <a href={backupUrl} download="hail-signup.vault.json" onclick={() => { backupSaved = true; }}>Save encrypted backup</a>
    <h2>2. Store your secret separately</h2>
    <p>Save this secret in a password manager or write it down somewhere safe. Do not store
      it beside the backup. Anyone with both can unlock your recovery keys.</p>
    <code class="[overflow-wrap:anywhere] select-all bg-[#f4f6f3] p-3.5">{secret}</code>
    <label><input type="checkbox" bind:checked={secretSaved} disabled={busy} /> I stored the secret separately.</label>
    <h2>3. Reopen what you saved</h2>
    <label>Saved encrypted backup
      <input type="file" accept=".json,application/json" disabled={busy}
        onchange={(event) => { file = event.currentTarget.files?.[0] ?? null; }} /></label>
    <label>Recovery secret from your separate copy
      <input type="password" bind:value={enteredSecret} autocomplete="off" spellcheck="false" maxlength="43" disabled={busy} /></label>
    <button onclick={verify} disabled={busy || !file || !backupSaved || !secretSaved || !enteredSecret}>
      {busy ? "Verifying…" : "Verify saved recovery kit"}</button>
    <button onclick={() => { clear(); message = "Preview cleared. No account was created."; }} disabled={busy}>Cancel and clear</button>
  {/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if verified}<p>Preview complete. Automatic monitored account creation is not enabled here yet.
    This unbound kit alone is not an active Hail account.</p>{/if}
</section>
