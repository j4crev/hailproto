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
  import Icon from "$lib/Icon.svelte";
  import {showInboxHeaders, loadHeaderPreference, saveHeaderPreference} from "$lib/preferences.js";
  let ready = $state(false), status = $state("");
  onMount(() => {loadHeaderPreference(); ready = true;});
  function change(event: Event) {
    status = saveHeaderPreference((event.currentTarget as HTMLInputElement).checked)
      ? "Saved on this browser." : "Applied for this visit. Browser storage is unavailable.";
  }
</script>
<svelte:head><title>Settings · Haili</title></svelte:head>
<div class="mx-auto max-w-[860px]">
  <header class="page-heading"><h1 class="hail-title">Settings</h1><p>A calmer inbox, your way.</p></header>
  <section class="hail-card p-6 sm:p-8" aria-labelledby="reading-title">
    <div class="mb-7 flex items-center gap-3"><span class="setting-icon"><Icon name="feed" /></span><h2 id="reading-title" class="m-0 text-lg">Reading</h2></div>
    <label class="flex cursor-pointer items-center justify-between gap-6" for="show-headers"><span class="grid gap-2"><strong class="text-sm">Show header images</strong><span class="text-sm text-muted">Display bundled images in your feed and conversations.</span></span><input id="show-headers" class="preference-switch" type="checkbox" role="switch" checked={$showInboxHeaders} onchange={change} disabled={!ready} /></label>
    <p class="m-0 mt-6 border-0 border-t border-solid border-line pt-4 text-xs text-muted">Preferences are saved in this browser.</p>
    <p class="m-0 mt-3 min-h-5 text-xs text-brand-strong" role="status">{status}</p>
  </section>
  <section class="hail-card mt-6 grid gap-4 p-6 sm:p-8" aria-labelledby="trash-title">
    <h2 id="trash-title" class="m-0 text-lg">Trash</h2>
    <p class="m-0 text-sm text-muted">Keep deleted messages for 30 days so you can restore them. This preference is saved to your account.</p>
    <label class="flex items-center justify-between gap-6"><strong class="text-sm">Use Trash</strong><input id="use-trash" class="preference-switch" type="checkbox" role="switch" checked={data.trashEnabled} disabled={saving||!ready} onchange={event=>{const enabled=event.currentTarget.checked;event.currentTarget.checked=data.trashEnabled;if(enabled)void saveTrash(true);else confirmDisable=true;}} /></label>
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
