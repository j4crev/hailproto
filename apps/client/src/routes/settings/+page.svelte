<script lang="ts">
  import {invalidateAll} from "$app/navigation";
  import {mailboxRequest} from "$lib/mailbox.js";
  let {data}=$props();
  let confirmDisable=$state(false),saving=$state(false),trashStatus=$state("");
  async function saveTrash(enabled:boolean){
    saving=true;trashStatus="";
    try{await mailboxRequest("message-preferences",{trashEnabled:enabled});confirmDisable=false;await invalidateAll();trashStatus=enabled?"Trash enabled.":"Trash disabled. All messages in Trash were permanently deleted.";}
    catch(e){trashStatus=e instanceof Error?e.message:"Unable to save Trash preference.";}finally{saving=false;}
  }
  import {onMount} from "svelte";
  import {showInboxHeaders, themePreference, syncAccountPreferences, saveAccountPreferences, type ThemePreference} from "$lib/preferences.js";
  let ready = $state(false), displaySaving = $state(false), displayError = $state("");
  onMount(() => {
    void syncAccountPreferences(data.account.did).catch(e => {displayError = e.message;}).finally(() => {ready = true;});
  });
  async function saveDisplay(patch: {theme?: ThemePreference; showHeaderImages?: boolean}) {
    displaySaving = true; displayError = "";
    try { await saveAccountPreferences(patch); }
    catch(e) { displayError = e instanceof Error ? e.message : "Unable to save preferences. Try again."; }
    finally { displaySaving = false; }
  }
  function changeTheme(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    const theme = select.value as ThemePreference;
    select.value = $themePreference;
    void saveDisplay({theme});
  }
  function change(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const showHeaderImages = input.checked;
    input.checked = $showInboxHeaders;
    void saveDisplay({showHeaderImages});
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
<svelte:head><title>Settings · Haili</title></svelte:head>
<div class="mx-auto max-w-[860px]">
  <header class="page-heading"><h1 class="hail-title">Settings</h1></header>
  <p><a href="/settings/domains">Manage custom domains</a></p>
  <section class="hail-card grid gap-6 p-6 sm:p-8" aria-label="Preferences">
    <div class="grid gap-3">
      <label class="hail-field" for="theme"><span>Appearance</span>
        <select id="theme" value={$themePreference} onchange={changeTheme} disabled={!ready||displaySaving}>
          <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
        </select>
      </label>
      <p class="m-0 text-sm text-muted">System follows your device’s appearance.</p>
    </div>
    <div class="border-0 border-t border-solid border-line pt-6">
      <label class="flex cursor-pointer items-center justify-between gap-6" for="show-headers"><span class="grid gap-2"><strong class="text-sm">Show header images</strong><span class="text-sm text-muted">Display bundled images in your feed and conversations.</span></span><input id="show-headers" class="preference-switch" type="checkbox" role="switch" checked={$showInboxHeaders} onchange={change} disabled={!ready||displaySaving} /></label>
    </div>
    <div class="border-0 border-t border-solid border-line pt-6">
      <label class="flex cursor-pointer items-center justify-between gap-6" for="use-trash"><span class="grid gap-2"><strong class="text-sm">Use Trash</strong><span class="text-sm text-muted">Keep deleted messages for 30 days so you can restore them.</span></span><input id="use-trash" class="preference-switch" type="checkbox" role="switch" checked={data.trashEnabled} disabled={saving||!ready} onchange={event=>{const enabled=event.currentTarget.checked;event.currentTarget.checked=data.trashEnabled;if(enabled)void saveTrash(true);else confirmDisable=true;}} /></label>
    </div>
    {#if displayError}<p role="alert" class="m-0 text-sm">{displayError}</p>{/if}
    {#if confirmDisable}<p class="m-0 text-sm">Disabling Trash immediately and permanently deletes everything already in Trash. Future deletions cannot be restored.</p><div class="flex flex-wrap gap-2"><button class="hail-button-secondary" disabled={saving||!ready} onclick={()=>saveTrash(false)}>Disable Trash and delete contents</button><button class="hail-button-secondary" disabled={saving||!ready} onclick={()=>confirmDisable=false}>Cancel</button></div>{/if}
    {#if trashStatus}<p role="status" class="m-0 text-sm">{trashStatus}</p>{/if}
  </section>
  <section class="hail-card mt-6 grid gap-4 p-6 sm:p-8" aria-label="Delete account">
    <h2 class="m-0 text-lg">Delete account</h2>
    <p class="m-0">Permanently erase this account’s provider inbox, including Trash, and revoke its passkeys and credentials. Its address can be reused after a one-hour delay. Other people’s copies and private protocol audit records are retained.</p>
    <p class="m-0 text-sm text-muted">Withdraw any domains you administer first. Sign in with your passkey within the last five minutes. Deletion cannot be undone.</p>
    <form class="grid gap-3" onsubmit={event=>{event.preventDefault();void deleteAccount();}}>
      <label class="hail-field"><span>Type {data.account.address} to confirm deletion</span><input bind:value={deletionAddress} disabled={deleting} autocomplete="off" /></label>
      <button class="hail-button-secondary" disabled={deleting||deletionAddress!==data.account.address}>Delete account and erase inbox</button>
    </form>
    {#if deletionError}<p role="alert" class="m-0">{deletionError}</p>{/if}
  </section>
</div>
<style>
  .preference-switch { appearance:none; position:relative; flex-shrink:0; width:46px; height:28px; margin:0; border:1px solid var(--color-muted); border-radius:20px; background:var(--color-line); cursor:pointer; transition:background .15s; }
  .preference-switch::before { content:''; position:absolute; width:20px; height:20px; top:3px; left:3px; border-radius:50%; background:var(--color-surface); box-shadow:0 1px 3px #172b2d30; transition:transform .15s; }
  .preference-switch:checked { background:var(--color-brand); border-color:var(--color-brand); }
  .preference-switch:checked::before { transform:translateX(18px); }
  .preference-switch:disabled { opacity:.5; }
</style>
