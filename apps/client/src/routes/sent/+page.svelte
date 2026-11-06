<script lang="ts">
  import Toast from "$lib/Toast.svelte";
  import MailboxCleanup from "$lib/MailboxCleanup.svelte";
  import {page} from "$app/state";
  import {onMount} from "svelte";
  import MailboxEmptyState from "$lib/MailboxEmptyState.svelte";
  import MessageListRow from "$lib/MessageListRow.svelte";
  import {showInboxHeaders, loadHeaderPreference} from "$lib/preferences.js";
  let {data}=$props();
  import {afterNavigate,invalidateAll} from '$app/navigation';
  import {mailboxRequest} from '$lib/mailbox.js';
  import SelectionAvatar from '$lib/SelectionAvatar.svelte';
  import SelectionActions from '$lib/SelectionActions.svelte';
  import Icon from '$lib/Icon.svelte';
  let ready=$state(false),busy=$state(false),confirming=$state(false),status=$state(''),error=$state('');
  let selected=$state<string[]>([]);
  const key=(message:{kind:string;messageId:string})=>message.kind+'/'+message.messageId;
  let selectedMessages=$derived(data.messages.filter(message=>selected.includes(key(message))));
  onMount(()=>{ready=true;loadHeaderPreference();});
  afterNavigate(()=>{selected=[];confirming=false;});
  function toggle(id:string){selected=selected.includes(id)?selected.filter(value=>value!==id):[...selected,id];}
  async function remove(){
    busy=true;error='';status='';
    try{
      const result=await mailboxRequest('sent/clear',{trashEnabled:data.trashEnabled,messages:selectedMessages.map(({kind,messageId})=>({kind,messageId}))});
      confirming=false;
      status=`${result.affected} message(s) ${result.state==='trashed'?'moved to Trash':'deleted'}. Active sends stay in Sent.`;
      await invalidateAll();
      selected=selected.filter(id=>data.messages.some(message=>key(message)===id));
    }catch(e){error=e instanceof Error?e.message:'Unable to delete messages. Refresh and try again.';}
    finally{busy=false;}
  }
  function review(){if(data.trashEnabled)void remove();else confirming=true;}
  const audience = (message: {kind: string; category: string | null}) => message.kind === 'category'
    ? message.category === 'general' ? 'General' : message.category ?? 'Message'
    : message.kind === 'connections' ? 'Connections' : 'Message';
</script>

<svelte:head><title>Sent · {page.data.branding?.name ?? "Hail"}</title></svelte:head>
<div class="sent-list min-w-0 pb-28 min-[901px]:pb-0">
  <MailboxCleanup folder="Sent" trashEnabled={data.trashEnabled} empty={!data.messages.length&&!data.paged} />
  {#if status}<Toast message={status} />{/if}
  {#if error}<Toast message={error} error />{/if}
  {#if selectedMessages.length}
    <SelectionActions label="Sent actions" count={selectedMessages.length} locked={busy||confirming} {busy} onclear={()=>selected=[]} onselectall={selectedMessages.length<data.messages.length?()=>selected=data.messages.map(key):undefined}>
      {#snippet actions()}{#if !confirming}<button class="hail-icon-button" type="button" aria-label="Delete selected messages" title={data.trashEnabled?'Move to Trash':'Delete permanently'} disabled={busy||!ready} onclick={review}><Icon name="trash" /></button>{/if}{/snippet}
      {#if confirming}
        <div class="grid gap-3" role="group" aria-label="Confirm deletion">
          <p class="m-0 text-sm">Trash is disabled. Permanently delete {selectedMessages.length} selected message(s)? This cannot be undone. Active sends stay in Sent.</p>
          <div class="flex flex-wrap gap-2"><button class="hail-button-secondary" disabled={busy} onclick={remove}>Delete permanently</button><button class="hail-button-secondary" disabled={busy} onclick={()=>confirming=false}>Cancel</button></div>
        </div>
      {/if}
    </SelectionActions>
  {/if}
  {#if data.messages.length}
    <section class="compact-list" aria-label="Sent messages">
      {#each data.messages as message (key(message))}
        <MessageListRow inline muted selected={selected.includes(key(message))} timestamp={message.createdAt} title={message.title} preview={message.preview} header={$showInboxHeaders ? message.header : null}
          href={`/sent/send/${message.kind}/${message.messageId}`}>
          {#snippet leading()}<SelectionAvatar name={Array.from(data.account.address)[0]??''} selected={selected.includes(key(message))} disabled={!ready||busy||confirming} label={`Select sent message: ${message.title}`} ontoggle={()=>toggle(key(message))} />{/snippet}
          {#snippet sender()}{#if message.kind === 'category'}<span class="[overflow-wrap:anywhere]">{audience(message)}</span>{:else if message.recipientSummary}<span class="[overflow-wrap:anywhere]">{message.recipientSummary.count > 1 ? 'Multiple recipients' : message.recipientSummary.address ?? message.recipientSummary.did}</span>{/if}{/snippet}
        </MessageListRow>
      {/each}
    </section>
    {#if data.paged||data.next}<nav aria-label="Sent pages" class="mt-6 flex flex-wrap justify-center gap-3">{#if data.paged}<a class="hail-button-secondary" href="/sent">← Newest messages</a>{/if}{#if data.next}<a class="hail-button-secondary" href={`/sent?after=${encodeURIComponent(data.next)}`}>Older messages →</a>{/if}</nav>{/if}
  {:else}<MailboxEmptyState icon="sent" title="Message in a bottle?" />{/if}
</div>

<style lang="postcss">
  @reference "../../app.css";
  .sent-list:has(:global(.selection-actions)) :global(.cleanup-menu) { @apply hidden; }
  @media (max-width:900px) {
    .sent-list:has(:global(.selection-actions)) :global(.mobile-cleanup) { @apply hidden; }
    .sent-list:has(:global(.selection-actions)) { @apply pb-[180px]; }
  }
</style>
