<script lang="ts">
  import {draftTitle,draftText} from '@racrproto/client-support/drafts';
  import type {Draft} from '@racrproto/client-support/drafts';
  import {invalidateAll,afterNavigate} from '$app/navigation';
  import {onMount} from 'svelte';
  import {mailboxRequest} from '$lib/mailbox.js';
  import MessageListRow from '$lib/MessageListRow.svelte';
  import SelectionAvatar from '$lib/SelectionAvatar.svelte';
  import SelectionActions from '$lib/SelectionActions.svelte';
  import Icon from '$lib/Icon.svelte';
  let {drafts,trash=false,trashEnabled=true,address}:{drafts:Draft[];trash?:boolean;trashEnabled?:boolean;address:string}=$props();
  let selected=$state<string[]>([]),busy=$state(false),status=$state(''),ready=$state(false);
  onMount(()=>{ready=true;});afterNavigate(()=>selected=[]);
  const name=(draft:Draft)=>draft.content.audience==='category'?draft.content.category||'Subscribers':draft.content.connections.length?`${draft.content.connections.length} connection(s)`:'No recipients yet';
  async function act(){
    busy=true;status='';
    try{if(!trash){const settings=await mailboxRequest('message-preferences');trashEnabled=settings.trashEnabled!==false;if(!trashEnabled&&!confirm('Permanently delete the selected drafts? Trash is disabled.'))return;}
      for(const id of selected)await mailboxRequest(`drafts/${id}/${trash?'restore':'delete'}`,{});selected=[];await invalidateAll();status=trash?'Restored to Drafts.':trashEnabled?'Moved to Trash.':'Drafts deleted.';}
    catch(e){status=e instanceof Error?e.message:'Unable to update drafts.';}finally{busy=false;}
  }
</script>
{#if status}<p role="status">{status}</p>{/if}
{#if selected.length}
  <SelectionActions label="Draft actions" count={selected.length} locked={busy} {busy} onclear={()=>selected=[]} onselectall={selected.length<drafts.length?()=>selected=drafts.map(d=>d.id):undefined}>
    {#snippet actions()}<button class="hail-icon-button" type="button" aria-label={trash?'Restore selected drafts':'Delete selected drafts'} title={trash?'Restore to Drafts':trashEnabled?'Move to Trash':'Delete permanently'} disabled={busy||!ready} onclick={act}><Icon name={trash?'restore':'trash'}/></button>{/snippet}
  </SelectionActions>
{/if}
<section class="compact-list" aria-label={trash?'Trashed drafts':'Draft messages'}>
  {#each drafts as draft (draft.id)}
    <MessageListRow inline isRead muted={trash} href={trash?undefined:`/compose?draft=${draft.id}`} timestamp={draft.updatedAt} title={draftTitle(draft.content)|| (draft.content.forward?'Forwarded message':'Untitled draft')} preview={draftText(draft.content)} selected={selected.includes(draft.id)}>
      {#snippet leading()}<SelectionAvatar name={address} selected={selected.includes(draft.id)} disabled={busy||!ready} label={`Select draft ${draftTitle(draft.content)||'Untitled draft'}`} ontoggle={()=>selected=selected.includes(draft.id)?selected.filter(id=>id!==draft.id):[...selected,draft.id]}/>{/snippet}
      {#snippet sender()}{name(draft)}{/snippet}
      {#snippet details()}{trash?'Restore to continue editing':'Draft'}{/snippet}
    </MessageListRow>
  {/each}
</section>
