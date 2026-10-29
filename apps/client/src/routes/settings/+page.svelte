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
  import {showInboxHeaders, loadHeaderPreference, saveHeaderPreference, themePreference, saveThemePreference, type ThemePreference} from "$lib/preferences.js";
  let themeStatus = $state("");
  function changeTheme(event: Event) {
    themeStatus = saveThemePreference((event.currentTarget as HTMLSelectElement).value as ThemePreference)
      ? "Saved on this browser." : "Applied for this visit. Browser storage is unavailable.";
  }
  let ready = $state(false), status = $state("");
  onMount(() => {loadHeaderPreference(); ready = true;});
  function change(event: Event) {
    status = saveHeaderPreference((event.currentTarget as HTMLInputElement).checked)
      ? "Saved on this browser." : "Applied for this visit. Browser storage is unavailable.";
  }
</script>
<svelte:head><title>Settings · Haili</title></svelte:head>
<div class="mx-auto max-w-[860px]">
  <header class="page-heading"><h1 class="hail-title">Settings</h1></header>
  <section class="hail-card grid gap-6 p-6 sm:p-8" aria-label="Preferences">
    <div class="grid gap-3">
      <label class="hail-field" for="theme"><span>Appearance</span>
        <select id="theme" value={$themePreference} onchange={changeTheme} disabled={!ready}>
          <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
        </select>
      </label>
      <p class="m-0 text-sm text-muted">System follows your device’s appearance. Saved in this browser.</p>
      {#if themeStatus}<p class="m-0 text-xs text-brand-strong" role="status">{themeStatus}</p>{/if}
    </div>
    <div class="border-0 border-t border-solid border-line pt-6">
      <label class="flex cursor-pointer items-center justify-between gap-6" for="show-headers"><span class="grid gap-2"><strong class="text-sm">Show header images</strong><span class="text-sm text-muted">Display bundled images in your feed and conversations.</span><span class="text-xs text-muted">Saved in this browser.</span></span><input id="show-headers" class="preference-switch" type="checkbox" role="switch" checked={$showInboxHeaders} onchange={change} disabled={!ready} /></label>
      {#if status}<p class="m-0 mt-3 text-xs text-brand-strong" role="status">{status}</p>{/if}
    </div>
    <div class="border-0 border-t border-solid border-line pt-6">
      <label class="flex cursor-pointer items-center justify-between gap-6" for="use-trash"><span class="grid gap-2"><strong class="text-sm">Use Trash</strong><span class="text-sm text-muted">Keep deleted messages for 30 days so you can restore them.</span><span class="text-xs text-muted">Saved to your account.</span></span><input id="use-trash" class="preference-switch" type="checkbox" role="switch" checked={data.trashEnabled} disabled={saving||!ready} onchange={event=>{const enabled=event.currentTarget.checked;event.currentTarget.checked=data.trashEnabled;if(enabled)void saveTrash(true);else confirmDisable=true;}} /></label>
    </div>
    {#if confirmDisable}<p class="m-0 text-sm">Disabling Trash immediately and permanently deletes everything already in Trash. Future deletions cannot be restored.</p><div class="flex flex-wrap gap-2"><button class="hail-button-secondary" disabled={saving||!ready} onclick={()=>saveTrash(false)}>Disable Trash and delete contents</button><button class="hail-button-secondary" disabled={saving||!ready} onclick={()=>confirmDisable=false}>Cancel</button></div>{/if}
    {#if trashStatus}<p role="status" class="m-0 text-sm">{trashStatus}</p>{/if}
  </section>
</div>
<style>
  .preference-switch { appearance:none; position:relative; flex-shrink:0; width:46px; height:28px; margin:0; border:1px solid var(--color-muted); border-radius:20px; background:var(--color-line); cursor:pointer; transition:background .15s; }
  .preference-switch::before { content:''; position:absolute; width:20px; height:20px; top:3px; left:3px; border-radius:50%; background:var(--color-surface); box-shadow:0 1px 3px #172b2d30; transition:transform .15s; }
  .preference-switch:checked { background:var(--color-brand); border-color:var(--color-brand); }
  .preference-switch:checked::before { transform:translateX(18px); }
  .preference-switch:disabled { opacity:.5; }
</style>
