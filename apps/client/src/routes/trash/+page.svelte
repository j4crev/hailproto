<script lang="ts">
  import {onMount} from 'svelte';
  let ready=$state(false);onMount(()=>ready=true);
  import {invalidateAll} from '$app/navigation';
  import {mailboxRequest} from '$lib/mailbox.js';
  let {data}=$props();
  let selected=$state<string[]>([]),busy=$state(false),status=$state('');
  const key=(message:{sender:string;messageId:string})=>message.sender+'/'+message.messageId;
  async function restore(){
    busy=true;status='';
    try{const result=await mailboxRequest('trash/restore',{messages:data.messages.filter(m=>selected.includes(key(m))).map(m=>({sender:m.sender,messageId:m.messageId}))});
      selected=[];await invalidateAll();status=`Restored ${result.restored} message(s) to their original Inbox or Messages folder.`;}
    catch(e){status=e instanceof Error?e.message:'Unable to restore messages.';}finally{busy=false;}
  }
</script>
<svelte:head><title>Trash · Haili</title></svelte:head>
<div class="mx-auto max-w-[860px]">
  <header class="page-heading"><p class="hail-eyebrow">A second chance</p><h1 class="hail-title">Trash</h1><p>Messages are permanently deleted 30 days after they enter Trash.</p></header>
  {#if status}<p role="status">{status}</p>{/if}
  {#if data.messages.length}
    <div class="mb-5 flex flex-wrap items-center gap-4"><label><input type="checkbox" checked={data.messages.every(m=>selected.includes(key(m)))} disabled={busy||!ready} onchange={event=>selected=event.currentTarget.checked?data.messages.map(key):[]} /> Select all on this page</label><button class="hail-button" disabled={busy||!ready||!data.messages.some(m=>selected.includes(key(m)))} onclick={restore}>Restore selected</button></div>
    <section class="grid gap-4" aria-label="Trashed messages">
      {#each data.messages as message (key(message))}<article class="hail-card grid gap-3 p-5"><label class="flex items-start gap-3"><input type="checkbox" value={key(message)} bind:group={selected} disabled={busy||!ready} aria-label={`Select message from ${message.senderAddress??message.sender}`} /><span class="min-w-0 [overflow-wrap:anywhere]"><strong>{message.senderAddress??message.sender}</strong><span class="mt-1 block text-xs text-muted">Restore to {message.kind==='connection'?'Messages':'Inbox'} · Trashed {new Date(message.trashedAt).toLocaleString()}</span></span></label><p class="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{message.preview}</p></article>{/each}
    </section>
  {:else}<p class="hail-card p-6">Trash is empty.</p>{/if}
  {#if data.paged||data.next}<nav class="mt-6 flex gap-3" aria-label="Trash pages">{#if data.paged}<a class="hail-button-secondary" href="/trash">Newest messages</a>{/if}{#if data.next}<a class="hail-button-secondary" href={`/trash?after=${encodeURIComponent(data.next)}`}>Older messages</a>{/if}</nav>{/if}
</div>
