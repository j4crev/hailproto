<script lang="ts">
  import {page} from "$app/state";
  import {invalidateAll} from "$app/navigation";
  import {connectionRequest} from "$lib/connections.js";
  import {mailboxRequest} from "$lib/mailbox.js";
  let {data}=$props();
  let conversationSaving=$state(false),conversationError=$state("");
  async function saveConversations(allowIntroductions:boolean){
    conversationSaving=true;conversationError="";
    try{await connectionRequest("conversation-preferences",{allowIntroductions});await invalidateAll();}
    catch(e){conversationError=e instanceof Error?e.message:"Unable to save shared conversation preference.";}
    finally{conversationSaving=false;}
  }
  let confirmDisable=$state(false),saving=$state(false),trashError=$state("");
  async function saveTrash(enabled:boolean){
    saving=true;trashError="";
    try{await mailboxRequest("message-preferences",{trashEnabled:enabled});confirmDisable=false;await invalidateAll();}
    catch(e){trashError=e instanceof Error?e.message:"Unable to save Trash preference.";}finally{saving=false;}
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
</script>
<svelte:head><title>Settings · {page.data.branding?.name ?? "Hail"}</title></svelte:head>
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
    <div class="border-0 border-t border-solid border-line pt-6">
      <label class="flex cursor-pointer items-center justify-between gap-6" for="shared-conversations"><span class="grid gap-2"><strong class="text-sm">Shared conversations</strong><span class="text-sm text-muted">Connections can add me to conversations with people I'm not connected with.</span></span><input id="shared-conversations" class="preference-switch" type="checkbox" role="switch" checked={data.allowIntroductions} disabled={conversationSaving||!ready} onchange={event=>{const allowed=event.currentTarget.checked;event.currentTarget.checked=data.allowIntroductions;void saveConversations(allowed);}} /></label>
      {#if conversationError}<p role="alert" class="mt-3 text-sm">{conversationError}</p>{/if}
    </div>
    {#if displayError}<p role="alert" class="m-0 text-sm">{displayError}</p>{/if}
    {#if confirmDisable}
      <section class="trash-confirmation" aria-labelledby="disable-trash-title">
        <h2 id="disable-trash-title" class="m-0 text-sm font-semibold">Disable Trash?</h2>
        <p class="m-0 text-sm">Disabling Trash immediately and permanently deletes everything already in Trash. Future deletions cannot be restored.</p>
        <div class="confirmation-actions">
          <button class="hail-button-secondary" disabled={saving||!ready} onclick={()=>confirmDisable=false}>Cancel</button>
          <button class="hail-button-secondary confirm-delete" disabled={saving||!ready} onclick={()=>saveTrash(false)}>Confirm</button>
        </div>
      </section>
    {/if}
    {#if trashError}<p role="alert" class="m-0 text-sm">{trashError}</p>{/if}
  </section>
</div>
<style>
  .trash-confirmation { display:grid; gap:12px; padding:16px; border:1px solid var(--color-danger); border-radius:12px; background:var(--color-danger-soft); }
  .confirmation-actions { display:flex; justify-content:flex-end; gap:8px; }
  .confirmation-actions button { min-height:44px; }
  .confirm-delete { color:var(--color-danger); border-color:var(--color-danger); }
  @media(max-width:640px) { .confirmation-actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); } }
  .preference-switch { appearance:none; position:relative; flex-shrink:0; width:46px; height:28px; margin:0; border:1px solid var(--color-muted); border-radius:20px; background:var(--color-line); cursor:pointer; transition:background .15s; }
  .preference-switch::before { content:''; position:absolute; width:20px; height:20px; top:3px; left:3px; border-radius:50%; background:var(--color-surface); box-shadow:0 1px 3px #172b2d30; transition:transform .15s; }
  .preference-switch:checked { background:var(--color-brand); border-color:var(--color-brand); }
  .preference-switch:checked::before { transform:translateX(18px); }
  .preference-switch:disabled { opacity:.5; }
</style>
