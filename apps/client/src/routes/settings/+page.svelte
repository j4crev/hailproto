<script lang="ts">
  import Icon from "$lib/Icon.svelte";
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
  import {showInboxHeaders, themePreference, startScreenPreference, type StartScreen, syncAccountPreferences, saveAccountPreferences, type ThemePreference} from "$lib/preferences.js";
  let ready = $state(false), displaySaving = $state(false), displayError = $state("");
  onMount(() => {
    void syncAccountPreferences(data.account.did).catch(e => {displayError = e.message;}).finally(() => {ready = true;});
  });
  async function saveDisplay(patch: {startScreen?: StartScreen; theme?: ThemePreference; showHeaderImages?: boolean}) {
    displaySaving = true; displayError = "";
    try { await saveAccountPreferences(patch); }
    catch(e) { displayError = e instanceof Error ? e.message : "Unable to save preferences. Try again."; }
    finally { displaySaving = false; }
  }
  function changeStartScreen(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    const startScreen = select.value as StartScreen;
    select.value = $startScreenPreference;
    void saveDisplay({startScreen});
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
        <span class="settings-select">
          <select id="theme" value={$themePreference} onchange={changeTheme} disabled={!ready||displaySaving}>
            <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
          </select>
          <span class="select-arrow absolute [inset-inline-end:14px] top-[50%] flex [transform:translateY(-50%)_rotate(90deg)] pointer-events-none"><Icon name="chevron" size={16} /></span>
        </span>
      </label>
      <p class="m-0 text-sm text-muted">System follows your device’s appearance.</p>
    </div>
    <div class="grid gap-3 border-0 border-t border-solid border-line pt-6">
      <label class="hail-field" for="start-screen"><span>Start screen</span>
        <span class="settings-select">
          <select id="start-screen" value={$startScreenPreference} onchange={changeStartScreen} disabled={!ready||displaySaving} aria-describedby="start-screen-description">
            <option value="feed">Feed</option><option value="inbox">Inbox</option>
          </select>
          <span class="select-arrow absolute [inset-inline-end:14px] top-[50%] flex [transform:translateY(-50%)_rotate(90deg)] pointer-events-none"><Icon name="chevron" size={16} /></span>
        </span>
      </label>
      <p id="start-screen-description" class="m-0 text-sm text-muted">Choose where you land when you open {page.data.branding?.name ?? "Hail"}.</p>
    </div>
    <div class="border-0 border-t border-solid border-line pt-6">
      <label class="flex cursor-pointer items-center justify-between gap-6" for="show-headers"><span class="grid gap-2"><strong class="text-sm">Header images</strong><span class="text-sm text-muted">Show header images in Feed.</span></span><input id="show-headers" class="preference-switch" type="checkbox" role="switch" checked={$showInboxHeaders} onchange={change} disabled={!ready||displaySaving} /></label>
    </div>
    <div class="border-0 border-t border-solid border-line pt-6">
      <label class="flex cursor-pointer items-center justify-between gap-6" for="use-trash"><span class="grid gap-2"><strong class="text-sm">Trash</strong><span class="text-sm text-muted">Keep deleted messages for 30 days so you can restore them.</span></span><input id="use-trash" class="preference-switch" type="checkbox" role="switch" checked={data.trashEnabled} disabled={saving||!ready} onchange={event=>{const enabled=event.currentTarget.checked;event.currentTarget.checked=data.trashEnabled;if(enabled)void saveTrash(true);else confirmDisable=true;}} /></label>
    </div>
    <div class="border-0 border-t border-solid border-line pt-6">
      <label class="flex cursor-pointer items-center justify-between gap-6" for="shared-conversations"><span class="grid gap-2"><strong class="text-sm">Shared conversations</strong><span class="text-sm text-muted">Connections can add me to conversations with people I'm not connected with.</span></span><input id="shared-conversations" class="preference-switch" type="checkbox" role="switch" checked={data.allowIntroductions} disabled={conversationSaving||!ready} onchange={event=>{const allowed=event.currentTarget.checked;event.currentTarget.checked=data.allowIntroductions;void saveConversations(allowed);}} /></label>
      {#if conversationError}<p role="alert" class="mt-3 text-sm">{conversationError}</p>{/if}
    </div>
    {#if displayError}<p role="alert" class="m-0 text-sm">{displayError}</p>{/if}
    {#if confirmDisable}
      <section class="trash-confirmation grid gap-[12px] p-[16px] [border:1px_solid_var(--color-danger)] rounded-[12px] [background:var(--color-danger-soft)]" aria-labelledby="disable-trash-title">
        <h2 id="disable-trash-title" class="m-0 text-sm font-semibold">Disable Trash?</h2>
        <p class="m-0 text-sm">Disabling Trash immediately and permanently deletes everything already in Trash. Future deletions cannot be restored.</p>
        <div class="confirmation-actions">
          <button class="hail-button-secondary" disabled={saving||!ready} onclick={()=>confirmDisable=false}>Cancel</button>
          <button class="hail-button-secondary confirm-delete text-danger [border-color:var(--color-danger)]" disabled={saving||!ready} onclick={()=>saveTrash(false)}>Confirm</button>
        </div>
      </section>
    {/if}
    {#if trashError}<p role="alert" class="m-0 text-sm">{trashError}</p>{/if}
  </section>
</div>
<style lang="postcss">
  @reference "../../app.css";

  .settings-select { @apply relative block; }
  .settings-select select { @apply appearance-none [padding-inline-end:44px]; }
  .confirmation-actions { @apply flex justify-end gap-[8px]; }
  .confirmation-actions button { @apply min-h-[44px]; }
  @media (max-width:640px) {
    .confirmation-actions { @apply grid grid-cols-[repeat(2,minmax(0,1fr))]; }
  }
  .preference-switch {
    @apply appearance-none relative shrink-0 w-[46px] h-[28px] m-0 [border:1px_solid_var(--color-muted)] rounded-[20px]
      [background:var(--color-line)] cursor-pointer;
    transition: background .15s;
  }
  .preference-switch::before {
    content: '';
    @apply absolute w-[20px] h-[20px] top-[3px] left-[3px] rounded-[50%] [background:var(--color-surface)]
      [box-shadow:0_1px_3px_#172b2d30];
    transition: transform .15s;
  }
  .preference-switch:checked { @apply [background:var(--color-brand)] [border-color:var(--color-brand)]; }
  .preference-switch:checked::before { @apply [transform:translateX(18px)]; }
  .preference-switch:disabled { @apply opacity-[.5]; }
</style>
