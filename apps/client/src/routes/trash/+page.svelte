<script lang="ts">
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
  async function restore(){
    busy=true;status='';
    try{const result=await mailboxRequest('trash/restore',{messages:data.messages.filter(m=>selected.includes(key(m))).map(m=>({sender:m.sender,messageId:m.messageId}))});
      selected=[];await invalidateAll();status=`Restored ${result.restored} message(s) to their original Feed or Inbox folder.`;}
    catch(e){status=e instanceof Error?e.message:'Unable to restore messages.';}finally{busy=false;}
  }
</script>
<svelte:head><title>Trash · Haili</title></svelte:head>
<div class="trash-list min-w-0" class:has-selection={selectedMessages.length>0}>
  <header class="page-heading"><h1 class="hail-title">Trash</h1><p>Messages are permanently deleted 30 days after they enter Trash.</p></header>
  {#if status}<p role="status">{status}</p>{/if}
  {#if data.messages.length}
    {#if selectedMessages.length}
      <SelectionActions label="Trash actions" count={selectedMessages.length} locked={busy} {busy} onclear={()=>selected=[]} onselectall={selectedMessages.length<data.messages.length?()=>selected=data.messages.map(key):undefined}>
        {#snippet actions()}<button class="hail-button-secondary" disabled={busy||!ready} onclick={restore}>Restore</button>{/snippet}
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
  {:else}<p class="hail-card p-6">Trash is empty.</p>{/if}
  {#if data.paged||data.next}<nav class="mt-6 flex gap-3" aria-label="Trash pages">{#if data.paged}<a class="hail-button-secondary" href="/trash">Newest messages</a>{/if}{#if data.next}<a class="hail-button-secondary" href={`/trash?after=${encodeURIComponent(data.next)}`}>Older messages</a>{/if}</nav>{/if}
</div>

<style>
  @media(max-width:900px) { .has-selection { padding-bottom:180px; } }
</style>
