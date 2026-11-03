<script lang="ts">
  import MailboxCleanup from "$lib/MailboxCleanup.svelte";
  import {page} from "$app/state";
  import Icon from "$lib/Icon.svelte";
  import MailboxEmptyState from "$lib/MailboxEmptyState.svelte";
  import MessageListRow from "$lib/MessageListRow.svelte";
  import ContactAddress from "$lib/ContactAddress.svelte";
  import {showInboxHeaders, loadHeaderPreference} from "$lib/preferences.js";
  import DateTime from "$lib/DateTime.svelte";
  import {onMount} from 'svelte';
  let ready=$state(false);onMount(()=>{ready=true;loadHeaderPreference();});
  import {afterNavigate,invalidateAll} from '$app/navigation';
  import {mailboxRequest} from '$lib/mailbox.js';
  import SelectionAvatar from '$lib/SelectionAvatar.svelte';
  import SelectionActions from '$lib/SelectionActions.svelte';
  let {data}=$props();
  let selected=$state<string[]>([]),busy=$state(false),status=$state('');
  const key=(message:{sender:string;messageId:string})=>message.sender+'/'+message.messageId;
  let selectedMessages=$derived(data.messages.filter(message=>selected.includes(key(message))));
  afterNavigate(()=>selected=[]);
  function toggle(id:string){selected=selected.includes(id)?selected.filter(value=>value!==id):[...selected,id];}
  async function restoreSent(kind:string,messageId:string){
    busy=true;status='';
    try{await mailboxRequest('sent/restore',{kind,messageId});await invalidateAll();}
    catch(e){status=e instanceof Error?e.message:'Unable to restore message.';}finally{busy=false;}
  }
  async function restore(){
    busy=true;status='';
    try{const result=await mailboxRequest('trash/restore',{messages:data.messages.filter(m=>selected.includes(key(m))).map(m=>({sender:m.sender,messageId:m.messageId}))});
      selected=[];await invalidateAll();status=`Restored ${result.restored} message(s) to their original Feed or Inbox folder.`;}
    catch(e){status=e instanceof Error?e.message:'Unable to restore messages.';}finally{busy=false;}
  }
</script>
<svelte:head><title>Trash · {page.data.branding?.name ?? "Hail"}</title></svelte:head>
<div class="trash-list min-w-0 pb-28 min-[901px]:pb-0" class:has-selection={selectedMessages.length>0}>
  <MailboxCleanup folder="Trash" trashEnabled={data.trashEnabled} empty={!data.messages.length&&!data.sent.messages.length&&!data.paged&&!data.sentPaged} />
  {#if status}<p role="status">{status}</p>{/if}
  {#if data.messages.length}
    {#if selectedMessages.length}
      <SelectionActions label="Trash actions" count={selectedMessages.length} locked={busy} {busy} onclear={()=>selected=[]} onselectall={selectedMessages.length<data.messages.length?()=>selected=data.messages.map(key):undefined}>
        {#snippet actions()}<button class="hail-icon-button" type="button" aria-label="Restore selected messages" title="Restore selected messages" disabled={busy||!ready} onclick={restore}><Icon name="restore" /></button>{/snippet}
      </SelectionActions>
    {/if}
    <section class="compact-list" aria-label="Trashed messages">
      {#each data.messages as message (key(message))}
        <MessageListRow inline muted href={`/message/${encodeURIComponent(message.sender)}/${encodeURIComponent(message.messageId)}`} timestamp={message.deliveredAt} title={message.title} preview={message.preview} header={$showInboxHeaders ? message.header : null} selected={selected.includes(key(message))}>
          {#snippet leading()}<SelectionAvatar name={message.senderAddress??message.sender} avatar={message.avatar} selected={selected.includes(key(message))} disabled={busy||!ready} label={`Select message from ${message.senderAddress??message.sender}`} ontoggle={()=>toggle(key(message))} />{/snippet}
          {#snippet sender()}<ContactAddress owner={data.account.did} did={message.sender} address={message.senderAddress} />{/snippet}
          {#snippet details()}Trashed <DateTime format="list" value={message.trashedAt} />{/snippet}
        </MessageListRow>
      {/each}
    </section>
  {:else if !data.sent.messages.length}<MailboxEmptyState icon="trash" title="Must be pickup day." />{/if}
  {#if data.sent.messages.length}
    <section aria-label="Trashed sent messages" class="mt-6">
      <h2 class="text-sm text-muted">Sent messages</h2>
      {#each data.sent.messages as message (message.kind+'/'+message.messageId)}
        <div class="trashed-send">
          <MessageListRow inline muted href={`/sent/send/${message.kind}/${message.messageId}?trash=true`} timestamp={message.createdAt} title={message.title} preview={message.preview}>
            {#snippet sender()}{message.recipientSummary?.address??message.recipientSummary?.did??(message.kind==='category'?message.category:'Multiple recipients')}{/snippet}
          </MessageListRow>
          <button class="hail-icon-button" aria-label={'Restore '+message.title+' to Sent'} title="Restore to Sent" disabled={busy||!ready} onclick={()=>restoreSent(message.kind,message.messageId)}><Icon name="restore" /></button>
        </div>
      {/each}
    </section>
  {/if}
  {#if data.sentPaged||data.sent.next}<nav class="mt-6 flex gap-3" aria-label="Trashed sent pages">{#if data.sentPaged}<a href="/trash">Newest sent messages</a>{/if}{#if data.sent.next}<a href={`/trash?sentAfter=${encodeURIComponent(data.sent.next)}`}>Older sent messages</a>{/if}</nav>{/if}
  {#if data.paged||data.next}<nav class="mt-6 flex gap-3" aria-label="Trash pages">{#if data.paged}<a class="hail-button-secondary" href="/trash">Newest messages</a>{/if}{#if data.next}<a class="hail-button-secondary" href={`/trash?after=${encodeURIComponent(data.next)}`}>Older messages</a>{/if}</nav>{/if}
</div>

<style>
  .trashed-send { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; }
  @media(max-width:900px) { .has-selection :global(.mobile-cleanup) { display:none; } .has-selection { padding-bottom:180px; } }
</style>
