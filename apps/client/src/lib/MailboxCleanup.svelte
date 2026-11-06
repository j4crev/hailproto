<script lang="ts">
  import Toast from "$lib/Toast.svelte";
  import {onMount,tick} from 'svelte';
  import {goto} from '$app/navigation';
  import Icon from '$lib/Icon.svelte';
  import {mailboxRequest} from '$lib/mailbox.js';
  let {folder,trashEnabled=true,empty=false}: {folder:'Sent'|'Trash';trashEnabled?:boolean;empty?:boolean}=$props();
  let ready=$state(false),confirming=$state(false),busy=$state(false),error=$state('');
  let menu=$state<HTMLDetailsElement>(),confirmation=$state<HTMLElement>();
  onMount(()=>{ready=true;});
  const permanent=$derived(folder==='Trash'||!trashEnabled);
  const label=$derived(folder==='Trash'?'Empty Trash':trashEnabled?'Move all to Trash':'Delete all');
  const icon=$derived(permanent?'trash-delete':'trash-down');
  async function review(){if(menu)menu.open=false;error='';confirming=true;await tick();confirmation?.focus();}
  async function clear(){
    busy=true;error='';
    try{
      await mailboxRequest(folder==='Trash'?'trash/empty':'sent/clear',folder==='Trash'?{}:{trashEnabled});
      confirming=false;
      await goto(folder==='Trash'?'/trash':'/sent',{invalidateAll:true});
    }catch(e){error=e instanceof Error?e.message:'Unable to clear messages. Refresh and try again.';}
    finally{busy=false;}
  }
</script>
<header class="page-heading">
  <div class="heading-actions flex items-center gap-[8px]">
    <h1 class="hail-title">{folder}</h1>
    <details class="cleanup-menu" bind:this={menu}>
      <summary class="hail-icon-button compact" aria-label={`${folder} actions`} title={`${folder} actions`}><Icon name="ellipsis" /></summary>
      <div class="menu-items"><button class="menu-item" disabled={!ready||busy||empty} onclick={review}><Icon name={icon}/><span>{label}</span></button></div>
    </details>
  </div>
  {#if folder==='Trash'}<p>{trashEnabled?'Messages are permanently deleted 30 days after they enter Trash.':'Trash disabled. Deleting messages is permanent.'}</p>{/if}
</header>
<button class="mobile-cleanup" aria-label={label} title={label} disabled={!ready||busy||empty} onclick={review}><Icon name={icon} size={24}/></button>
{#if confirming}
  <section class="cleanup-confirmation" bind:this={confirmation} tabindex="-1" class:permanent aria-labelledby="cleanup-title">
    <p class="m-0 text-sm">{folder==='Trash'?'Permanently delete everything in Trash? This cannot be undone.':trashEnabled?'Move all sent messages to Trash? You can restore them for 30 days. Active sends stay in Sent.':'Permanently delete all sent messages? This cannot be undone. Active sends stay in Sent.'}</p>
    {#if folder==='Sent'}<p class="m-0 text-sm text-muted">Recipients keep their copies.</p>{/if}
    <div class="confirmation-actions"><button class="hail-button-secondary" disabled={busy} onclick={()=>confirming=false}>Cancel</button><button class="hail-button-secondary" disabled={busy} onclick={clear}>Confirm</button></div>
  </section>
{/if}
{#if error}<Toast message={error} error />{/if}
<style lang="postcss">
  @reference "../app.css";

  .cleanup-menu { @apply relative; }
  summary { @apply [list-style:none]; }
  summary::-webkit-details-marker { @apply hidden; }
  .menu-items {
    @apply absolute left-0 top-[100%] z-[12] p-[6px] min-w-[200px] [background:var(--color-surface)]
      [border:1px_solid_var(--color-line)] rounded-[12px] [box-shadow:0_4px_12px_#0002];
  }
  .menu-item {
    @apply flex items-center gap-[10px] w-full [padding:10px_12px] [border:0] rounded-[6px] [background:transparent]
      text-ink text-left text-[14px] whitespace-nowrap;
  }
  .menu-item:hover { @apply [background:var(--color-brand-soft)]; }
  .mobile-cleanup { @apply hidden; }
  .cleanup-confirmation { @apply grid gap-[12px] p-[16px] mb-[24px] [border:1px_solid_var(--color-line)] rounded-[12px] [background:var(--color-surface)]; }
  .cleanup-confirmation.permanent { @apply [border-color:var(--color-danger)] [background:var(--color-danger-soft)]; }
  .confirmation-actions { @apply flex justify-end gap-[8px]; }
  .confirmation-actions button { @apply min-h-[44px]; }
  .permanent .confirmation-actions button:last-child { @apply text-danger [border-color:var(--color-danger)]; }
  @media (max-width:900px) {
    .cleanup-menu { @apply hidden; }
    .mobile-cleanup {
      @apply fixed z-[11] left-[50%] [transform:translateX(-50%)] bottom-[calc(40px_+_env(safe-area-inset-bottom))] grid
        place-items-center w-[56px] h-[56px] [border:0] rounded-[18px] [background:var(--color-brand)] text-on-brand
        [box-shadow:0_4px_16px_#0003];
    }
    .mobile-cleanup:hover { @apply [background:var(--color-brand-strong)]; }
    .mobile-cleanup:disabled { @apply opacity-[.5] cursor-default; }
    .confirmation-actions { @apply grid grid-cols-[repeat(2,minmax(0,1fr))]; }
  }
</style>
