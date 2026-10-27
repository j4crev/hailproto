<script lang="ts">
  import {onMount} from 'svelte';
  let ready=$state(false);onMount(()=>ready=true);
  import {goto,invalidateAll} from '$app/navigation';
  import {mailboxRequest} from '$lib/mailbox.js';
  let {sender,messageId,returnTo}:{sender:string;messageId:string;returnTo?:string}=$props();
  let confirming=$state(false),trashEnabled=$state(true),busy=$state(false),error=$state('');
  async function review(){
    busy=true;error='';
    try{const settings=await mailboxRequest('message-preferences');trashEnabled=settings.trashEnabled!==false;confirming=true;}
    catch(e){error=e instanceof Error?e.message:'Unable to load deletion settings.';}finally{busy=false;}
  }
  async function remove(){
    busy=true;error='';
    try{await mailboxRequest(`inbox/${encodeURIComponent(sender)}/${encodeURIComponent(messageId)}/delete`,{});
      confirming=false;if(returnTo)await goto(returnTo,{invalidateAll:true});else await invalidateAll();}
    catch(e){error=e instanceof Error?e.message:'Unable to delete message.';}finally{busy=false;}
  }
</script>
<div class="grid gap-3">
  {#if confirming}
    <p class="m-0 text-sm">{trashEnabled?'Move this message to Trash? You can restore it for 30 days.':'Trash is disabled. Permanently delete this message? This cannot be undone.'}</p>
    <div class="flex flex-wrap gap-2"><button class="hail-button-secondary" disabled={busy||!ready} onclick={remove}>{trashEnabled?'Move to Trash':'Delete permanently'}</button><button class="hail-button-secondary" disabled={busy||!ready} onclick={()=>confirming=false}>Cancel</button></div>
  {:else}<button class="hail-button-secondary justify-self-start" disabled={busy||!ready} onclick={review}>Delete message</button>{/if}
  {#if error}<p class="hail-error" role="alert">{error}</p>{/if}
</div>
