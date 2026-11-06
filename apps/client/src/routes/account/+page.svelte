<script lang="ts">
  import Toast from "$lib/Toast.svelte";
  import {page} from "$app/state";
  import CopyButton from "$lib/CopyButton.svelte";
  import AccountSecurity from "$lib/AccountSecurity.svelte";
  import {onMount, untrack} from "svelte";
  import {startAuthentication} from "@simplewebauthn/browser";
  import {avatarDefinition, avatarSource, prepareAvatar} from "$lib/avatar.js";
  let {data} = $props();
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

  let deletionAddress=$state(""),deleting=$state(false),deletionError=$state("");
  async function deleteAccount(){
    deleting=true;deletionError="";
    try{
      const response=await fetch("/api/v1/account/delete",{method:"POST",credentials:"same-origin",cache:"no-store",redirect:"error",
        headers:{"Content-Type":"application/json"},body:JSON.stringify({address:deletionAddress,eraseInbox:true})});
      if(!response.ok){const result=await response.json();throw new Error(result.error??"Unable to delete account.");}
      location.assign("/");
    }catch(error){deletionError=error instanceof Error?error.message:"Unable to delete account.";deleting=false;}
  }
</script>
<svelte:head><title>Account · {page.data.branding?.name ?? "Hail"}</title></svelte:head>
<div class="min-w-0">
  <header class="page-heading"><h1 class="hail-title">Account</h1></header>
  <section class="hail-card overflow-hidden" aria-label="Account details">
    <div class="account-banner"><span class="account-avatar">{#if source}<img src={source} alt="Your avatar preview" />{:else}{data.account.address.split('@')[0].slice(0,2).toUpperCase()}{/if}</span><span class="text-xs font-semibold text-brand-strong">Your Hail identity</span></div>
    <div class="grid gap-7 p-6 sm:p-8">
      <div class="min-w-0"><p class="hail-eyebrow mb-2">Hail address</p><div class="flex items-center gap-1"><h2 class="m-0 min-w-0 text-xl tracking-tight [overflow-wrap:anywhere]">{data.account.address}</h2><CopyButton value={data.account.address} label="Copy address" /></div></div>
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
        {#if message}<Toast message={message} error />{/if}
        {#if conflict}<button class="hail-button-secondary" type="button" onclick={() => {if (confirm("Discard your preview and reload the latest profile?")) location.reload();}}>Reload latest profile</button>{/if}
      </form>
      <dl class="m-0 grid gap-6 border-0 border-t border-solid border-line pt-6"><div><dt class="text-sm font-semibold">Identity</dt><dd class="m-0 mt-2 font-mono text-xs text-muted [overflow-wrap:anywhere]">{data.account.did}</dd></div><div><dt class="text-sm font-semibold">Key custody</dt><dd class="m-0 mt-2 text-sm text-muted">{data.account.custodyProfile === 'managed' ? 'Provider managed' : data.account.custodyProfile === 'owner-controlled' ? 'Owner controlled' : data.account.custodyProfile}</dd></div></dl>
    </div>
  </section>
  <section id="security" aria-labelledby="security-title" class="mt-10 scroll-mt-24">
    <AccountSecurity data={data.security} />
  </section>
  <section class="hail-card mt-6 grid gap-4 p-6 sm:p-8" aria-label="Delete account">
    <h2 class="m-0 text-lg">Delete account</h2>
    <p class="m-0 text-sm text-muted">First, remove any custom domains you administer.</p>
    <p class="m-0">This action removes your account and revokes its passkeys and credentials. Other people’s copies and private protocol audit records are retained. The Hail address can be reused after a one-hour delay.</p>
    <form class="grid gap-3" onsubmit={event=>{event.preventDefault();void deleteAccount();}}>
      <label class="hail-field"><span>Type {data.account.address} to confirm deletion</span><input bind:value={deletionAddress} disabled={deleting} autocomplete="off" /></label>
      <button class="hail-button-secondary" disabled={deleting||deletionAddress!==data.account.address}>Delete account</button>
    </form>
    {#if deletionError}<Toast message={deletionError} error />{/if}
  </section>
</div>
<style lang="postcss">
  @reference "../../app.css";

  .account-banner {
    @apply h-[140px] [padding:24px_32px] flex items-center justify-between gap-[16px]
      [background:var(--color-brand-soft)];
    @apply
      [background-image:radial-gradient(circle_at_85%_140%,_transparent_80px,_#0f766e0b_81px,_#0f766e0b_120px,_transparent_121px)];
  }
  .account-avatar img { @apply w-full h-full object-cover rounded-[50%]; }
  .account-avatar {
    @apply overflow-hidden grid place-items-center w-[72px] h-[72px] shrink-0 [border:5px_solid_var(--color-surface)]
      rounded-[50%] [background:var(--color-brand)] text-on-brand text-[24px] font-[650];
  }
</style>
