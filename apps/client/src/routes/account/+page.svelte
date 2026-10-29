<script lang="ts">
  import {onMount, untrack} from "svelte";
  import {startAuthentication} from "@simplewebauthn/browser";
  import {avatarDefinition, avatarSource, prepareAvatar} from "$lib/avatar.js";
  let {data} = $props();
  let copied = $state(false), copyError = $state("");
  let avatar = $state<string | null>(untrack(() => data.definition.avatar ?? null));
  let ready = $state(false), busy = $state(false), processing = $state(false), message = $state(""), conflict = $state(false);
  const changed = $derived(avatar !== (data.definition.avatar ?? null));
  const source = $derived(avatarSource(avatar));
  onMount(() => {ready = true;});
  async function choose(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    processing = true; message = "";
    try {avatar = await prepareAvatar(file);}
    catch (error) {message = error instanceof Error ? error.message : "Couldn’t prepare this photo.";}
    finally {processing = false; input.value = "";}
  }
  async function json(response: Response) {
    if (!response.ok) throw new Error("Passkey verification failed. Please try again.");
    return response.json();
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy || processing || !changed || conflict) return;
    busy = true; message = "";
    try {
      const start = await json(await fetch("/api/v1/auth/passkeys/authentication/options", {method: "POST"}));
      const response = await startAuthentication({optionsJSON: start.options});
      await json(await fetch("/api/v1/auth/passkeys/authentication", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({challengeId: start.challengeId, response})}));
      const account = await json(await fetch("/api/v1/account", {cache: "no-store"}));
      if (account.did !== data.account.did) throw new Error("You verified a different account. Sign in to the original account before saving this photo.");
      const saved = await fetch("/api/v1/account/profile", {method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({definition: avatarDefinition(data.definition, avatar), expectedRevision: data.revision})});
      if (!saved.ok) {
        conflict = saved.status === 409;
        throw new Error(conflict ? "Your profile changed or your account is moving. Reload before editing again."
          : saved.status === 403 ? "Photo updates aren’t available for this session. Sign in again and retry."
          : saved.status === 400 ? "The provider rejected this photo. Choose another image."
          : "Saving wasn’t confirmed. Your preview is still here; please retry.");
      }
      location.reload();
    } catch (error) {message = error instanceof Error ? error.message : "Couldn’t save your photo. Please try again."; busy = false;}
  }
  async function copyAddress() {
    try { await navigator.clipboard.writeText(data.account.address); copied = true; copyError = ""; }
    catch { copyError = "Couldn’t copy. Select and copy your address below."; }
  }
</script>
<svelte:head><title>Account · Haili</title></svelte:head>
<div class="mx-auto max-w-[860px]">
  <header class="page-heading"><h1 class="hail-title">Account</h1></header>
  <section class="hail-card overflow-hidden" aria-label="Account details">
    <div class="account-banner"><span class="account-avatar">{#if source}<img src={source} alt="Your avatar preview" />{:else}{data.account.address.split('@')[0].slice(0,2).toUpperCase()}{/if}</span><span class="text-xs font-semibold text-brand-strong">Your Hail identity</span></div>
    <div class="grid gap-7 p-6 sm:p-8">
      <div class="flex flex-wrap items-center justify-between gap-4"><div class="min-w-0"><p class="hail-eyebrow mb-2">Hail address</p><h2 class="m-0 text-xl tracking-tight [overflow-wrap:anywhere]">{data.account.address}</h2></div><button class="hail-button-secondary" onclick={copyAddress}>{copied ? 'Copied' : 'Copy address'}</button><span class="sr-only" role="status">{copied ? 'Address copied to clipboard.' : ''}</span></div>
      {#if copyError}<p class="hail-error" role="status">{copyError}</p>{/if}
      <form onsubmit={save} aria-label="Profile photo">
        <fieldset class="m-0 grid min-w-0 gap-4 border-0 p-0" disabled={!ready || busy || processing || conflict || !!data.account.migrationState}>
          <legend class="mb-2 text-sm font-semibold">Profile photo</legend>
          <p class="m-0 text-sm text-muted">Your photo is public and appears with your sender profile. Photos are cropped to a square; only the resized photo is saved.</p>
          <label class="hail-field">{avatar ? 'Replace photo' : 'Upload photo'}<input class="max-w-full" type="file" accept="image/jpeg,image/png,image/webp" onchange={choose} aria-describedby="photo-help" /></label>
          <p id="photo-help" class="m-0 text-xs text-muted">JPEG, PNG, or WebP, up to 10 MB.</p>
          <div class="flex flex-wrap gap-3">
            {#if avatar}<button class="hail-button-secondary" type="button" onclick={() => {avatar = null; message = "";}}>Remove photo</button>{/if}
            {#if changed}<button class="hail-button" type="submit">{busy ? 'Saving…' : 'Save photo with passkey'}</button><button class="hail-button-secondary" type="button" onclick={() => {avatar = data.definition.avatar ?? null; message = "";}}>Cancel</button>{/if}
          </div>
        </fieldset>
        <p class="m-0 mt-3 text-sm text-muted" role="status">{processing ? 'Preparing photo…' : busy ? 'Verifying and saving…' : changed ? 'Preview only. Save to apply your change.' : ''}</p>
        {#if data.account.migrationState}<p class="hail-error">Photo editing is paused while your account moves.</p>{/if}
        {#if message}<p class="hail-error" role="alert">{message}</p>{/if}
        {#if conflict}<button class="hail-button-secondary" type="button" onclick={() => {if (confirm("Discard your preview and reload the latest profile?")) location.reload();}}>Reload latest profile</button>{/if}
      </form>
      <dl class="m-0 grid gap-6 border-0 border-t border-solid border-line pt-6"><div><dt class="text-sm font-semibold">Identity</dt><dd class="m-0 mt-2 font-mono text-xs text-muted [overflow-wrap:anywhere]">{data.account.did}</dd></div><div><dt class="text-sm font-semibold">Key custody</dt><dd class="m-0 mt-2 text-sm text-muted">{data.account.custodyProfile === 'managed' ? 'Provider managed' : data.account.custodyProfile === 'owner-controlled' ? 'Owner controlled' : data.account.custodyProfile}</dd></div></dl>
    </div>
  </section>
</div>
<style>
  .account-banner { height:140px; padding:24px 32px; display:flex; align-items:center; justify-content:space-between; gap:16px; background:var(--color-brand-soft); background-image:radial-gradient(circle at 85% 140%, transparent 80px, #0f766e0b 81px, #0f766e0b 120px, transparent 121px); }
  .account-avatar img { width:100%; height:100%; object-fit:cover; border-radius:50%; }
  .account-avatar { overflow:hidden; display:grid; place-items:center; width:72px; height:72px; flex-shrink:0; border:5px solid var(--color-surface); border-radius:50%; background:var(--color-brand); color:var(--color-on-brand); font-size:24px; font-weight:650; }
</style>
