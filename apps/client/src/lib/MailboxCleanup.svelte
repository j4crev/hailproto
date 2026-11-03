<script lang="ts">
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
  <div class="heading-actions">
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
    <h2 id="cleanup-title" class="m-0 text-sm font-semibold">{label}?</h2>
    <p class="m-0 text-sm">{folder==='Trash'?'Permanently delete everything in Trash? This cannot be undone.':trashEnabled?'Move all completed sent messages to Trash? You can restore them for 30 days. Active sends stay in Sent.':'Permanently delete all sent messages? This cannot be undone. Active sends stay in Sent.'}</p>
    {#if folder==='Sent'}<p class="m-0 text-sm text-muted">Recipients keep their copies.</p>{/if}
    <div class="confirmation-actions"><button class="hail-button-secondary" disabled={busy} onclick={()=>confirming=false}>Cancel</button><button class="hail-button-secondary" disabled={busy} onclick={clear}>Confirm</button></div>
  </section>
{/if}
{#if error}<p class="hail-error" role="alert">{error}</p>{/if}
<style>
  .heading-actions { display:flex; align-items:center; gap:8px; }
  .cleanup-menu { position:relative; }
  summary { list-style:none; }
  summary::-webkit-details-marker { display:none; }
  .menu-items { position:absolute; left:0; top:100%; z-index:12; padding:6px; min-width:200px; background:var(--color-surface); border:1px solid var(--color-line); border-radius:12px; box-shadow:0 4px 12px #0002; }
  .menu-item { display:flex; align-items:center; gap:10px; width:100%; padding:10px 12px; border:0; border-radius:6px; background:transparent; color:var(--color-ink); text-align:left; font-size:14px; white-space:nowrap; }
  .menu-item:hover { background:var(--color-brand-soft); }
  .mobile-cleanup { display:none; }
  .cleanup-confirmation { display:grid; gap:12px; padding:16px; margin-bottom:24px; border:1px solid var(--color-line); border-radius:12px; background:var(--color-surface); }
  .cleanup-confirmation.permanent { border-color:var(--color-danger); background:var(--color-danger-soft); }
  .confirmation-actions { display:flex; justify-content:flex-end; gap:8px; }
  .confirmation-actions button { min-height:44px; }
  .permanent .confirmation-actions button:last-child { color:var(--color-danger); border-color:var(--color-danger); }
  @media(max-width:900px) {
    .cleanup-menu { display:none; }
    .mobile-cleanup { position:fixed; z-index:11; left:50%; transform:translateX(-50%); bottom:calc(40px + env(safe-area-inset-bottom)); display:grid; place-items:center; width:56px; height:56px; border:0; border-radius:18px; background:var(--color-brand); color:var(--color-on-brand); box-shadow:0 4px 16px #0003; }
    .mobile-cleanup:hover { background:var(--color-brand-strong); }
    .mobile-cleanup:disabled { opacity:.5; cursor:default; }
    .confirmation-actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); }
  }
</style>
